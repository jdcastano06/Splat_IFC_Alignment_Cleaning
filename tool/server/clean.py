"""Apply the solved transform + crop to the full-precision gs.ply and export.

Runs against the PLY rather than the SOG the viewer previews, so the export keeps full
precision. Safe because both encode the same splats in the same order (verified: identical
counts, and the SOG's log-decoded means bounds reproduce the PLY's roi.json).

Three encodings matter here and each is easy to get wrong:
  * scale_*   are log-encoded  -> a uniform scale s is `+ log(s)`, not `* s`
  * opacity   is logit-encoded -> fade in sigmoid space, then logit back
  * rot_*     are (w, x, y, z) and NOT normalised in the file
`f_dc_*` need no rotation (DC is view-independent). `f_rest_*` -- the view-dependent SH bands a
SOG-sourced export carries -- do: each band is rotated with the same R as the gaussians, else the
specular colour would point the old way. Vault `gs.ply` files are DC-only, so that is a no-op there.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import align
import crop
import ifc_write
import ply
import sdf

CHUNK = 1_000_000


def _quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product, (w,x,y,z). a: (4,) or (N,4); b: (N,4)."""
    aw, ax, ay, az = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bw, bx, by, bz = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ], axis=-1)


def _mat_to_quat(R: np.ndarray) -> np.ndarray:
    """Rotation matrix -> (w,x,y,z), via the branch-stable trace method."""
    m = np.asarray(R, dtype=np.float64)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        S = np.sqrt(tr + 1.0) * 2
        w = 0.25 * S
        x = (m[2, 1] - m[1, 2]) / S
        y = (m[0, 2] - m[2, 0]) / S
        z = (m[1, 0] - m[0, 1]) / S
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        S = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / S
        x = 0.25 * S
        y = (m[0, 1] + m[1, 0]) / S
        z = (m[0, 2] + m[2, 0]) / S
    elif m[1, 1] > m[2, 2]:
        S = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / S
        x = (m[0, 1] + m[1, 0]) / S
        y = 0.25 * S
        z = (m[1, 2] + m[2, 1]) / S
    else:
        S = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / S
        x = (m[0, 2] + m[2, 0]) / S
        y = (m[1, 2] + m[2, 1]) / S
        z = 0.25 * S
    q = np.array([w, x, y, z], dtype=np.float64)
    return q / np.linalg.norm(q)


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30.0, 30.0)))


def _logit(p):
    p = np.clip(p, 1e-7, 1.0 - 1e-7)
    return np.log(p / (1.0 - p))


# Real SH basis, bands 1-3, in the 3DGS ordering and sign convention (gaussian-splatting eval_sh).
_C1 = 0.4886025119029199
_C2 = (1.0925484305920792, -1.0925484305920792, 0.31539156525252005,
       -1.0925484305920792, 0.5462742152960396)
_C3 = (-0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154,
       -0.4570457994644658, 1.445305721320277, -0.5900435899266435)


def _sh_basis(d: np.ndarray, band: int) -> np.ndarray:
    """(n,3) unit dirs -> (n, 2*band+1) real SH values for one band."""
    x, y, z = d[:, 0], d[:, 1], d[:, 2]
    if band == 1:
        return np.stack([-_C1 * y, _C1 * z, -_C1 * x], axis=1)
    xx, yy, zz = x * x, y * y, z * z
    if band == 2:
        return np.stack([_C2[0] * x * y, _C2[1] * y * z, _C2[2] * (2 * zz - xx - yy),
                         _C2[3] * x * z, _C2[4] * (xx - yy)], axis=1)
    return np.stack([_C3[0] * y * (3 * xx - yy), _C3[1] * x * y * z,
                     _C3[2] * y * (4 * zz - xx - yy), _C3[3] * z * (2 * zz - 3 * xx - 3 * yy),
                     _C3[4] * x * (4 * zz - xx - yy), _C3[5] * z * (xx - yy),
                     _C3[6] * x * (xx - 3 * yy)], axis=1)


def sh_rotation(R: np.ndarray, band: int) -> np.ndarray:
    """M with  coeffs_new = M @ coeffs_old  for one SH band under rotation R.

    The rotated splat's colour toward d must equal the old colour toward R^T d. Solved by least
    squares over well-spread directions -- exact (to float precision), since each band spans a
    rotation-invariant space, and it sidesteps a hand-derived Wigner-D for every convention.
    """
    rng = np.random.default_rng(0)
    d = rng.normal(size=(256, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    A = _sh_basis(d, band)                      # Y(d)
    B = _sh_basis(d @ np.asarray(R), band)      # Y(R^T d)   (rows: d_i^T R = (R^T d_i)^T)
    # Row-wise B = A @ T. Colour toward d after rotation: Y(d).f_new = Y(R^T d).f = Y(d).(T f),
    # so f_new = T @ f_old.
    T, *_ = np.linalg.lstsq(A, B, rcond=None)
    return T


def _rest_layout(props: list[str]):
    """-> (degree, per-channel column index arrays) for f_rest_*, or (0, None) if absent."""
    rest = [p for p in props if p.startswith("f_rest_")]
    if not rest:
        return 0, None
    k = len(rest) // 3                          # coeffs per channel: 3, 8 or 15
    degree = {3: 1, 8: 2, 15: 3}.get(k)
    if degree is None or len(rest) != 3 * k:
        raise ValueError(f"unexpected f_rest count {len(rest)}")
    col = {p: i for i, p in enumerate(props)}
    # 3DGS / splat-transform layout is channel-major: f_rest_{c*k + j}
    return degree, [np.array([col[f"f_rest_{c * k + j}"] for j in range(k)]) for c in range(3)]


def transform_and_crop(
    src: np.ndarray, props: list[str], s: float, R: np.ndarray, t: np.ndarray,
    grid, params: dict, alpha_eps: float = crop.ALPHA_EPS,
):
    """Stream the PLY in chunks -> (kept_rows, n_total, n_kept). Rows are already transformed."""
    col = {p: i for i, p in enumerate(props)}
    Rq = _mat_to_quat(R)
    log_s = float(np.log(s))
    degree, rest_cols = _rest_layout(props)
    sh_rot = None
    if degree:
        mats = [sh_rotation(R, b) for b in range(1, degree + 1)]
        sh_rot = np.zeros((len(rest_cols[0]),) * 2)
        o = 0
        for m in mats:
            sh_rot[o:o + len(m), o:o + len(m)] = m
            o += len(m)
    out: list[np.ndarray] = []
    n_total = len(src)

    for start in range(0, n_total, CHUNK):
        end = min(start + CHUNK, n_total)
        blk = np.array(src[start:end], dtype=np.float32)

        xyz = blk[:, [col["x"], col["y"], col["z"]]].astype(np.float64)
        xyz = s * (xyz @ R.T) + t

        a = crop.alpha(xyz.astype(np.float32), grid, params)
        keep = a >= alpha_eps
        if not keep.any():
            continue

        blk = blk[keep]
        a = a[keep]
        blk[:, [col["x"], col["y"], col["z"]]] = xyz[keep].astype(np.float32)

        # log-encoded scales, uniform scale -> additive in log space
        for c in ("scale_0", "scale_1", "scale_2"):
            blk[:, col[c]] += log_s

        # (w,x,y,z), unnormalised in-file -> normalise, compose, keep normalised
        qi = [col["rot_0"], col["rot_1"], col["rot_2"], col["rot_3"]]
        q = blk[:, qi].astype(np.float64)
        n = np.linalg.norm(q, axis=1, keepdims=True)
        q = np.divide(q, n, out=np.tile(np.array([[1.0, 0, 0, 0]]), (len(q), 1)), where=n > 1e-12)
        blk[:, qi] = _quat_mul(Rq, q).astype(np.float32)

        # view-dependent SH: rotate each colour channel's band coefficients with the splat
        if sh_rot is not None:
            for cols in rest_cols:
                blk[:, cols] = (blk[:, cols].astype(np.float64) @ sh_rot.T).astype(np.float32)

        # logit-encoded opacity -> fade in sigmoid space
        blk[:, col["opacity"]] = _logit(_sigmoid(blk[:, col["opacity"]].astype(np.float64)) * a)

        out.append(blk)

    kept = np.concatenate(out, axis=0) if out else np.zeros((0, len(props)), dtype=np.float32)
    return kept, n_total, len(kept)


def to_sog(ply_path: Path, sog_path: Path, cwd: Path) -> dict:
    """PLY -> SOG via the PlayCanvas CLI. Non-fatal: the PLY is the primary artefact."""
    cmd = ["npx", "--yes", "@playcanvas/splat-transform@3",
           "-w", str(ply_path), str(sog_path)]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=1800)
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if r.returncode != 0 or not sog_path.exists():
        return {"ok": False, "error": (r.stderr or r.stdout)[-2000:]}
    return {"ok": True, "seconds": round(time.time() - t0, 1),
            "bytes": sog_path.stat().st_size}


def sog_to_ply(sog_path: Path, ply_path: Path, cwd: Path) -> None:
    """SOG -> PLY via the PlayCanvas CLI, so a SOG-only scan exports through the same PLY path.

    Raises on failure (unlike to_sog): without this there is nothing to export.
    """
    ply_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = ply_path.with_suffix(".tmp.ply")
    cmd = ["npx", "--yes", "@playcanvas/splat-transform@3", "-w", str(sog_path), str(tmp)]
    r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=1800)
    if r.returncode != 0 or not tmp.exists():
        raise RuntimeError(f"SOG -> PLY failed: {(r.stderr or r.stdout)[-2000:]}")
    tmp.replace(ply_path)


def run(
    splat_ply: str | Path, room, grid, s: float, R: np.ndarray, t: np.ndarray,
    params: dict, out_dir: str | Path, pairs: dict | None = None,
    write_sog: bool = True, label: str = "cleaned", refine: dict | None = None,
    reopen: dict | None = None, wall_thickness: float = 0.1,
    wall_color=None, floor_color=None, wall_anchor="center", wall_offset=0.0,
) -> dict:
    splat_ply, out_dir = Path(splat_ply), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    src, props = ply.read(splat_ply)
    kept, n_total, n_kept = transform_and_crop(src, props, s, R, t, grid, params)

    out_ply = out_dir / f"{label}.ply"
    ply.write(out_ply, kept, props)
    result = {
        "ply": str(out_ply),
        "splats_in": int(n_total),
        "splats_out": int(n_kept),
        "kept_fraction": round(n_kept / n_total, 5) if n_total else 0.0,
        "seconds": round(time.time() - t0, 1),
        "bytes": out_ply.stat().st_size,
    }

    if write_sog:
        out_sog = out_dir / f"{label}.sog"
        r = to_sog(out_ply, out_sog, cwd=out_dir)
        result["sog"] = str(out_sog) if r.get("ok") else None
        result["sog_result"] = r

    # Always bundle a room-space IFC of the box actually used, at the final height. For a custom
    # box or an overridden IFC height there was no matching IFC before; for a plain room this still
    # gives one in the cleaned splat's own frame (metres, floor z=0), so the two overlay directly.
    # Wall thickness comes from the client's Twin preview, so the file matches what was previewed.
    out_ifc = out_dir / f"{label}.ifc"
    try:
        ifc_write.build_room_ifc(room.footprint, params["height"], out_ifc, name=room.name,
                                 wall_thickness=wall_thickness,
                                 wall_color=wall_color, floor_color=floor_color,
                                 wall_anchor=wall_anchor, wall_offset=wall_offset)
        result["ifc"] = str(out_ifc)
        result["ifc_wall_thickness"] = wall_thickness
    except Exception as e:  # never let IFC authoring sink an otherwise-good export
        result["ifc"] = None
        result["ifc_error"] = str(e)

    sidecar = {
        "version": 1,
        "created": datetime.now(timezone.utc).isoformat(),
        "source": {
            "splat_ply": str(splat_ply),
            "room": room.name,
            "footprint_points": len(room.footprint),
            "height_m": room.height,
            # room space = IFC metres - centroid; keep the offset so this is reversible
            "ifc_centroid_offset_m": room.centroid,
        },
        "alignment": {
            # (s, R, t) below are final: the base alignment with any manual refine already composed
            # in. `manual_refine` is recorded separately so a run is reproducible.
            "method": ("point-pairs-umeyama" if pairs else "custom-box")
                      + ("+manual-refine" if refine else ""),
            "matrix4_row_major": align.to_matrix4(s, R, t),
            **align.decompose(s, R, t),
            "manual_refine": refine,
        },
        "crop": {
            k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in params.items()
        },
        "result": result,
    }
    if pairs:
        sidecar["alignment"]["pairs"] = pairs
    # Everything the Clean stage needs to be re-opened later (the sidecar's own fields are a record
    # of the run; this block is authored for a lossless reload -- yaw-only flag, and for a custom
    # box the footprint + base transform + basis that the record doesn't otherwise keep).
    if reopen:
        sidecar["reopen"] = reopen

    side = out_dir / f"{label}.alignment.json"
    side.write_text(json.dumps(sidecar, indent=2))
    result["sidecar"] = str(side)
    return result
