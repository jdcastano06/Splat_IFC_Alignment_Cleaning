"""Hands-off cleaning: splat in -> room box found automatically -> cleaned PLY/SOG + IFC out.

    python3 auto_clean.py "Space_1/Space_1-20260701" ...     # specific scans (ids as the UI lists)
    python3 auto_clean.py --new                              # every scan with no export yet
    python3 auto_clean.py --all                              # every scan

Writes to <OUT_ROOT>/custom/<scan>/ with the label `auto` (auto.ply, auto.sog, auto.ifc,
auto.alignment.json, auto.preview.png) -- never touching a hand-made `cleaned.*`. The sidecar
carries the same `reopen` block the Draw stage writes, so each result shows up under
"Reopen a cleaned export" and can be nudged and re-exported in the UI.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

import app
import auto_room
import clean
import ifc_room
import ply
import sdf

LABEL = "auto"
FLOATER_FRAC = 0.01  # drop splats whose largest axis exceeds this fraction of the room (~0.1-0.4%)
WALL_FRAC = 0.02     # generated wall thickness, as a fraction of the room's largest extent

# One house look for every auto room (the frontend's: solid walls on its #242424 ground), so a batch
# of auto exports reads consistently. Only the wall thickness varies -- it follows the room's size,
# since scans come in arbitrary units.
TWIN_STYLE = {
    "source": "generated", "shading": "solid", "wallColor": "#6b6b6b", "slabColor": "#6c7683",
    "edgeColor": "#7fd4ff", "opacity": 1, "edges": False, "anchor": "center", "offset": 0,
    "floorSlab": True, "ceilSlab": False, "bg": "#242424", "twinLight": True,
}


def wall_thickness(footprint) -> float:
    return round(WALL_FRAC * float(np.ptp(np.asarray(footprint), axis=0).max()), 4)


def default_crop(footprint, height) -> dict:
    ext = float(np.ptp(np.asarray(footprint), axis=0).max())
    n = len(footprint)
    return {
        "wall_offset": np.zeros(n, dtype=np.float32),
        "wall_feather": np.full(n, 0.02 * ext, dtype=np.float32),
        "floor_offset": 0.0, "floor_feather": 0.02 * height,
        "ceil_offset": 0.0, "ceil_feather": 0.02 * height,
        "height": float(height),
        "max_scale": FLOATER_FRAC * ext, "min_opacity": 0.0,
    }


def preview_png(dbg, res, path, title: str = ""):
    """Plan (structure orange, ceiling blue, outline yellow) beside an elevation (floor yellow,
    ceiling cyan), so one image shows both cuts the export will make."""
    a = np.log1p(dbg["wall_img"]); a = (255 * a / max(a.max(), 1e-9)).astype(np.uint8)
    b = np.log1p(dbg["floor_img"]); b = (255 * b / max(b.max(), 1e-9)).astype(np.uint8)
    plan = np.dstack([a, a // 2 + b // 2, b])
    ctr = dbg["poly_xy"].mean(0)
    px = np.rint((np.asarray(res["footprint"]) + ctr - dbg["lo"]) / dbg["cell"]).astype(np.int32)
    cv2.polylines(plan, [px.reshape(-1, 1, 2)], True, (255, 230, 0), 1, cv2.LINE_AA)
    plan = plan[::-1]

    P = dbg["prepared"]
    xyz, w = P["xyz"], P["w"]
    x, z = xyz[:, 0], xyz[:, 2]
    lo = np.percentile(np.c_[x, z], 0.5, 0); hi = np.percentile(np.c_[x, z], 99.5, 0)
    span = hi - lo; lo = lo - 0.12 * span; hi = hi + 0.12 * span
    Wd = plan.shape[1]
    Hd = max(60, int(Wd * (hi[1] - lo[1]) / max(hi[0] - lo[0], 1e-9)))
    img, _, _ = np.histogram2d(z, x, bins=(Hd, Wd), range=((lo[1], hi[1]), (lo[0], hi[0])), weights=w)
    img = np.log1p(img); img = (255 * img / max(img.max(), 1e-9)).astype(np.uint8)[::-1]
    elev = np.dstack([img, img, img])
    for zz, col in ((P["z0"], (255, 230, 0)), (P["z1"], (0, 200, 255))):
        r = int(Hd - 1 - (zz - lo[1]) / (hi[1] - lo[1]) * Hd)
        cv2.line(elev, (0, r), (Wd, r), col, 1, cv2.LINE_AA)

    S = 640 / max(plan.shape[1], 1)
    plan = cv2.resize(plan, None, fx=S, fy=S, interpolation=cv2.INTER_AREA)
    elev = cv2.resize(elev, (plan.shape[1], int(elev.shape[0] * S)), interpolation=cv2.INTER_AREA)
    bar = np.full((34, plan.shape[1], 3), 24, np.uint8)
    cv2.putText(bar, title or "", (10, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (235, 235, 235), 1, cv2.LINE_AA)
    sep = np.full((6, plan.shape[1], 3), 24, np.uint8)
    out = np.vstack([bar, plan, sep, elev])
    cv2.imwrite(str(path), cv2.cvtColor(out, cv2.COLOR_RGB2BGR))


def _cache_path(sid: str, s_info: dict):
    src = s_info["ply"] or s_info["sog"]
    st = os.stat(src)
    return (app.CACHE_ROOT / "auto_room"
            / f"{sid.replace('/', '__')}_{st.st_size}_{int(st.st_mtime)}_{auto_room.VERSION}.json")


def detect(sid: str, s_info: dict, force: bool = False) -> tuple[dict, str, dict | None]:
    """Auto room for a scan -> (result, source PLY, debug maps or None if served from cache)."""
    src_ply = app.export_source_ply(s_info)
    cp = _cache_path(sid, s_info)
    if cp.exists() and not force:
        r = json.loads(cp.read_text())
        r["R"], r["t"] = np.asarray(r["R"]), np.asarray(r["t"])
        return r, src_ply, None
    data, props = ply.read(src_ply)
    dbg: dict = {}
    res = auto_room.solve(data, props, debug=dbg)
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_text(json.dumps({**res, "R": res["R"].tolist(), "t": res["t"].tolist()}))
    return res, src_ply, dbg


def box_payload(sid: str, s_info: dict, res: dict) -> dict:
    """The custom-box state the Draw stage would author, plus a default crop for it."""
    fp, H = res["footprint"], res["height"]
    R, t = np.asarray(res["R"]), np.asarray(res["t"])
    # the Draw stage's basis: room = R (p - center), rows of R = e1, e2, up; center on the floor
    center = R.T @ (-t)
    crop = {k: (v.tolist() if isinstance(v, np.ndarray) else v)
            for k, v in default_crop(fp, H).items()}
    return {
        "splat_id": sid, "custom_mode": True, "yaw_only": True, "reloadable": True,
        "matrix4_row_major": res["matrix4_row_major"], "rms": 0.0, "refine": None,
        "crop": crop, "room_height": H, "room_name": f"auto · {s_info['project']}",
        "custom": {
            "footprint": fp, "matrix4_row_major": res["matrix4_row_major"], "height": H,
            "name": f"auto · {s_info['project']}",
            "basis": {"e1": R[0].tolist(), "e2": R[1].tolist(), "up": R[2].tolist(),
                      "center": center.tolist(), "fromCeiling": False},
        },
        "auto": {"method": "auto_room", "n_corners": res["n_corners"],
                 "floor_z_scan": res["floor_z_scan"], "ceiling_z_scan": res["ceiling_z_scan"]},
        "twin": {**TWIN_STYLE, "thickness": wall_thickness(fp)},
    }


def _title(sid, res, result=None):
    t = f"{sid.split('/')[0].replace('_', ' ')}  -  {res['n_corners']} walls, h {res['height']:.2f}"
    if result:
        t += f", kept {100 * result['kept_fraction']:.0f}%"
    return t


def run_one(sid: str, s_info: dict, write_sog: bool = True, force: bool = False,
            out_root=None) -> dict:
    t0 = time.time()
    res, src_ply, dbg = detect(sid, s_info, force=force)
    if dbg is None:                                  # cached box: still need maps for the preview
        res, src_ply, dbg = detect(sid, s_info, force=True)
    pl = box_payload(sid, s_info, res)
    fp, H = res["footprint"], res["height"]
    room = ifc_room.room_from_footprint(fp, H, name=pl["room_name"])
    grid = sdf.bake(fp)
    params = default_crop(fp, H)
    s, R, t = res["s"], np.asarray(res["R"]), np.asarray(res["t"])
    reopen = {k: pl[k] for k in ("splat_id", "custom_mode", "yaw_only", "custom", "auto", "twin")}
    out_dir = Path(out_root or app.resolve_out_root()) / "custom" / sid.replace("/", "__")
    result = clean.run(src_ply, room, grid, s, R, t, params, out_dir, write_sog=write_sog,
                       label=LABEL, reopen=reopen, wall_thickness=wall_thickness(fp),
                       wall_color=TWIN_STYLE["wallColor"], floor_color=TWIN_STYLE["slabColor"])
    preview_png(dbg, res, out_dir / f"{LABEL}.preview.png", title=_title(sid, res, result))
    result["seconds_total"] = round(time.time() - t0, 1)
    result["n_corners"] = res["n_corners"]
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--new", action="store_true", help="scans with no export of any kind yet")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--detect-only", metavar="DIR", help="only detect + write preview PNGs to DIR")
    ap.add_argument("--redetect", action="store_true", help="ignore the cached room detection")
    ap.add_argument("--no-sog", action="store_true", help="skip the (slower) SOG re-encode")
    a = ap.parse_args(argv)

    splats = app.find_splats()
    if a.all:
        ids = sorted(splats)
    elif a.new:
        done = {e["splat_id"] for e in app.find_exports()}
        ids = sorted(sid for sid in splats if sid not in done)
    else:
        ids = a.ids
    if not ids:
        print("nothing to do"); return
    print(f"writing to {app.resolve_out_root()}  ({len(ids)} scans)", flush=True)
    failed = []
    for sid in ids:
        if sid not in splats:
            print(f"  ? {sid}: unknown scan id"); failed.append(sid); continue
        try:
            if a.detect_only:
                res, _, dbg = detect(sid, splats[sid], force=True)
                out = Path(a.detect_only); out.mkdir(parents=True, exist_ok=True)
                preview_png(dbg, res, out / f"{sid.replace('/', '__')}.png", title=_title(sid, res))
                print(f"  ok {sid}: {res['n_corners']} corners, height {res['height']:.2f}", flush=True)
                continue
            r = run_one(sid, splats[sid], write_sog=not a.no_sog, force=a.redetect)
            print(f"  ok {sid}: kept {r['splats_out']:,}/{r['splats_in']:,} "
                  f"({100 * r['kept_fraction']:.0f}%), {r['n_corners']} corners, "
                  f"{r['seconds_total']:.0f}s -> {r['ply'].rsplit('/', 1)[0]}", flush=True)
        except Exception as e:  # one bad scan shouldn't stop a batch
            print(f"  FAIL {sid}: {type(e).__name__}: {e}", flush=True); failed.append(sid)
    if failed:
        print(f"{len(failed)} failed: {failed}"); sys.exit(1)


if __name__ == "__main__":
    main()
