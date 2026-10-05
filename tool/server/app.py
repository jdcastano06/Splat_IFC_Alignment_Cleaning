"""FastAPI backend for the splat/IFC aligner.

Serves dataset discovery, room geometry, the baked SDF, the SOG for preview, and runs the
export. Read-only with respect to everything under IFC/ and the vault -- the only writes are to
OUT_ROOT and the SDF cache.
"""

from __future__ import annotations

import json
import os
import struct
import sys
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent))

import align  # noqa: E402
import clean  # noqa: E402
import crop  # noqa: E402
import ifc_room  # noqa: E402
import ply  # noqa: E402
import sdf  # noqa: E402
import vault  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
# Vault credentials live in the gitignored repo-root .env; see vault.py.
vault.load_env(ROOT / ".env")
SPLAT_ROOT = Path(os.environ.get(
    "SPLAT_ROOT",
    vault.mount_point() / "06_Research_projects/Splats" if vault.configured()
    else "/Volumes/SMART_vault/06_Research_projects/Splats"))
IFC_ROOT = Path(os.environ.get("IFC_ROOT", ROOT / "IFC"))
# Cleaned outputs are large (200+ MB PLYs), so they go on the vault next to the source scans,
# not on the laptop. Override with OUT_ROOT. Falls back to a local dir only if the vault is
# not mounted (so an export never hard-fails just because the share dropped).
OUT_ROOT = Path(os.environ.get("OUT_ROOT", SPLAT_ROOT / "_Cleaned"))
LOCAL_OUT_FALLBACK = ROOT / "out"
CACHE_ROOT = Path(os.environ.get("CACHE_ROOT", ROOT / ".cache"))


def resolve_out_root() -> Path:
    """Where to write this export. Prefer the vault; fall back locally if it isn't mounted."""
    # The default OUT_ROOT lives under the vault, which can't be written if the share is gone.
    on_vault = str(OUT_ROOT).startswith(str(SPLAT_ROOT))
    if on_vault and not splat_root_ok():
        return LOCAL_OUT_FALLBACK
    return OUT_ROOT


def splat_root_ok() -> bool:
    """SPLAT_ROOT is reachable, re-mounting the vault first if the share dropped."""
    vault.ensure_mounted()
    return SPLAT_ROOT.exists()


vault.ensure_mounted(force=True)
vault.start_watchdog()

app = FastAPI(title="Splat/IFC Aligner")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

_rooms: dict[str, ifc_room.Room] = {}
_grids: dict[str, sdf.SdfGrid] = {}
_meshes: dict[str, dict] = {}


# ---------------------------------------------------------------- discovery

def find_splats() -> dict[str, dict]:
    """Scan for `*/result/3D/model-gs-{ply,sog}` scan folders."""
    out: dict[str, dict] = {}
    if not splat_root_ok():
        return out
    for sog in sorted(SPLAT_ROOT.glob("*/*/result/3D/model-gs-sog/gs.sog")):
        scan = sog.parents[3]           # .../<Project>/<Scan-date>
        d3 = sog.parents[1]             # .../result/3D
        pl = d3 / "model-gs-ply" / "gs.ply"
        sid = f"{scan.parent.name}/{scan.name}".replace(" ", "_")
        out[sid] = {
            "id": sid,
            "project": scan.parent.name,
            "scan": scan.name,
            "sog": str(sog),
            "ply": str(pl) if pl.exists() else None,
            "sog_bytes": sog.stat().st_size,
            "ply_bytes": pl.stat().st_size if pl.exists() else None,
        }
    return out


def export_source_ply(s_info: dict) -> str:
    """The PLY an export reads: the scan's own gs.ply, or else one decoded from its gs.sog.

    The decode is cached under CACHE_ROOT keyed by the SOG's size + mtime, so re-exporting a scan
    (or tweaking and exporting again) doesn't re-run it, and replacing the SOG invalidates it.
    """
    if s_info["ply"]:
        return s_info["ply"]
    sog = Path(s_info["sog"])
    st = sog.stat()
    out = CACHE_ROOT / "sog_ply" / f"{s_info['id'].replace('/', '__')}_{st.st_size}_{int(st.st_mtime)}.ply"
    if not out.exists():
        for old in out.parent.glob(f"{s_info['id'].replace('/', '__')}_*.ply"):
            old.unlink(missing_ok=True)
        try:
            clean.sog_to_ply(sog, out, cwd=out.parent.parent)
        except Exception as e:
            raise HTTPException(500, str(e))
    return str(out)


def find_rooms() -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not IFC_ROOT.exists():
        return out
    for f in sorted(IFC_ROOT.glob("*/*.ifc")):
        out[f.parent.name] = {"id": f.parent.name, "ifc": str(f), "file": f.name}
    return out


def get_room(room_id: str) -> ifc_room.Room:
    if room_id not in _rooms:
        rooms = find_rooms()
        if room_id not in rooms:
            raise HTTPException(404, f"unknown room {room_id!r}")
        try:
            _rooms[room_id] = ifc_room.extract(rooms[room_id]["ifc"])
        except ifc_room.RoomExtractError as e:
            raise HTTPException(422, f"cannot read room {room_id!r}: {e}")
    return _rooms[room_id]


def get_grid(room_id: str) -> sdf.SdfGrid:
    if room_id not in _grids:
        r = get_room(room_id)
        _grids[room_id] = sdf.bake_cached(r.footprint, CACHE_ROOT / room_id)
    return _grids[room_id]


# ---------------------------------------------------------------- routes

@app.get("/api/datasets")
def datasets():
    splats = []
    for s in find_splats().values():
        splats.append({k: s[k] for k in
                       ("id", "project", "scan", "sog_bytes", "ply_bytes")} | {"has_ply": bool(s["ply"])})
        # Every scan is exportable: without a gs.ply the export decodes the SOG instead.
    rooms = []
    for rid in find_rooms():
        try:
            r = get_room(rid)
            rooms.append({"id": rid, "name": r.name, "points": len(r.footprint),
                          "area_m2": round(r.area, 2), "height_m": round(r.height, 3)})
        except HTTPException as e:
            rooms.append({"id": rid, "name": rid, "error": e.detail})
    out = resolve_out_root()
    return {"splats": splats, "rooms": rooms,
            "splat_root": str(SPLAT_ROOT), "splat_root_exists": SPLAT_ROOT.exists(),
            "vault_error": vault.last_error,
            "out_root": str(out), "out_on_vault": str(out).startswith(str(SPLAT_ROOT))}


@app.get("/api/room/{room_id}")
def room(room_id: str):
    r = get_room(room_id)
    g = get_grid(room_id)
    return r.to_dict() | {"sdf": g.meta() | {"n_walls": len(r.walls)}}


@app.get("/api/room/{room_id}/mesh")
def room_mesh(room_id: str):
    """The real IFC solids (walls with thickness, floor slab) triangulated into room space."""
    if room_id not in _meshes:
        r = get_room(room_id)
        rooms = find_rooms()
        if room_id not in rooms:
            raise HTTPException(404, f"unknown room {room_id!r}")
        try:
            verts, faces = ifc_room.tessellate(rooms[room_id]["ifc"], r.centroid)
        except Exception as e:  # geometry engine issues shouldn't 500 the app
            raise HTTPException(422, f"cannot tessellate {room_id!r}: {e}")
        _meshes[room_id] = {"vertices": verts, "indices": faces,
                            "vertex_count": len(verts) // 3, "triangle_count": len(faces) // 3}
    return _meshes[room_id]


@app.get("/api/room/{room_id}/sdf.bin")
def room_sdf(room_id: str):
    """Packed grid: header then float32 distance then float32 wall-index.

    Sent as float32 for both because WebGL2 wants R32F textures; the index is exact in float32
    well past any wall count we will see.
    """
    g = get_grid(room_id)
    h, w = g.shape
    header = struct.pack(
        "<4sIIIffff", b"SDF1", 1, w, h,
        g.origin[0], g.origin[1], g.cell, float(g.widx.max() + 1),
    )
    body = g.dist.astype("<f4").tobytes() + g.widx.astype("<f4").tobytes()
    return Response(
        content=header + body, media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/api/splat/{splat_id:path}/sog")
def splat_sog(splat_id: str):
    s = find_splats().get(splat_id)
    if not s:
        raise HTTPException(404, f"unknown splat {splat_id!r}")
    return FileResponse(s["sog"], media_type="application/octet-stream", filename="gs.sog")


@app.get("/api/splat/{splat_id:path}/info")
def splat_info(splat_id: str):
    s = find_splats().get(splat_id)
    if not s:
        raise HTTPException(404, f"unknown splat {splat_id!r}")
    info = dict(s)
    if s["ply"]:
        try:
            count, props, _ = ply.read_header(s["ply"])
            info["ply_count"] = count
            info["ply_props"] = props
        except ply.PlyError as e:
            info["ply_error"] = str(e)
    return info


class Pair(BaseModel):
    splat: list[float]
    room: list[float]


class Refine(BaseModel):
    """Manual nudge applied on top of the solved transform, about the room centre."""
    scale: float = 1.0
    rotation_euler_xyz: list[float] = [0.0, 0.0, 0.0]
    translation: list[float] = [0.0, 0.0, 0.0]


class SolveReq(BaseModel):
    pairs: list[Pair] = []
    yaw_only: bool = False
    refine: Refine | None = None
    room_id: str | None = None       # needed only to locate the refine pivot
    base_matrix4: list[float] | None = None  # custom box: compose refine onto this, no pairs
    pivot_height: float | None = None


def _pivot(room_id: str | None):
    """Refine rotates about the room centre; without a room, fall back to the origin."""
    if not room_id:
        return (0.0, 0.0, 0.0)
    try:
        return (0.0, 0.0, get_room(room_id).height / 2.0)
    except HTTPException:
        return (0.0, 0.0, 0.0)


def _solve_pairs(pairs: list[Pair], yaw_only: bool, refine: Refine | None, room_id: str | None):
    """Solve + refine. One implementation, shared by /api/solve and /api/export, so the numbers
    the UI previews are literally the numbers the export uses."""
    if len(pairs) < 3:
        raise HTTPException(400, "need at least 3 point pairs")
    P = np.array([p.splat for p in pairs], dtype=np.float64)
    Q = np.array([p.room for p in pairs], dtype=np.float64)
    try:
        s, R, t = align.solve(P, Q, yaw_only=yaw_only)
    except (align.DegenerateError, ValueError) as e:
        raise HTTPException(422, str(e))
    # RMS/residuals describe the fit to the clicked pairs, so report them before the nudge.
    stats = {"rms": align.rms(P, Q, s, R, t),
             "residuals": align.residuals(P, Q, s, R, t).tolist()}
    if refine is not None:
        s, R, t = align.compose_refine(s, R, t, refine.model_dump(), pivot=_pivot(room_id))
    return s, R, t, stats


@app.post("/api/solve")
def solve(req: SolveReq):
    """Server-side solve so the preview transform is exactly what the export will apply."""
    if req.base_matrix4 is not None:
        # Custom box: base transform is fixed; just compose the manual refine about the box centre.
        s, R, t = align.from_matrix4(req.base_matrix4)
        if req.refine is not None:
            pivot = (0.0, 0.0, (req.pivot_height or 0.0) / 2.0)
            s, R, t = align.compose_refine(s, R, t, req.refine.model_dump(), pivot=pivot)
        stats = {"rms": 0.0, "residuals": []}
    else:
        s, R, t, stats = _solve_pairs(req.pairs, req.yaw_only, req.refine, req.room_id)
    return {
        "matrix4_row_major": align.to_matrix4(s, R, t),
        **stats,
        **align.decompose(s, R, t),
    }


class CropParams(BaseModel):
    wall_offset: list[float]
    wall_feather: list[float]
    floor_offset: float = 0.0
    floor_feather: float = 0.0
    ceil_offset: float = 0.0
    ceil_feather: float = 0.0
    height: float | None = None   # overridden ceiling height; None -> use the IFC value
    max_scale: float = 0.0        # floater filter: drop splats larger than this (room units); 0 = off
    min_opacity: float = 0.0      # floater filter: drop splats fainter than this; 0 = off


class CustomRoom(BaseModel):
    """A box drawn on the splat when no IFC exists: footprint + height + the level transform,
    all authored on the client. The client is the source of truth here, so preview and export use
    the identical numbers -- there is nothing to re-derive and therefore nothing to diverge."""
    footprint: list[list[float]]
    height: float
    matrix4_row_major: list[float]
    name: str = "custom box"


class ExportReq(BaseModel):
    splat_id: str
    room_id: str | None = None
    pairs: list[Pair] = []
    yaw_only: bool = False
    refine: Refine | None = None
    crop: CropParams
    custom: CustomRoom | None = None   # present -> draw-your-own-box path
    write_sog: bool = True
    label: str = "cleaned"
    # Wall thickness for the bundled cleaned.ifc, chosen in the client's Twin preview so the
    # exported IFC is the geometry the user actually looked at over the splat.
    wall_thickness: float = 0.1
    # Client-authored snapshot persisted verbatim so this export can be re-opened in Clean later
    # (see /api/exports). Free-form on purpose: the client owns the reload contract.
    reopen: dict | None = None


def _sdf_from_footprint(footprint) -> sdf.SdfGrid:
    """Bake (and cache) an SDF for an arbitrary footprint -- used by custom boxes."""
    key = sdf.cache_key(footprint, sdf.TARGET_CELL, sdf.MAX_DIM, sdf.MARGIN)
    return sdf.bake_cached(footprint, CACHE_ROOT / "custom" / key)


class SdfReq(BaseModel):
    footprint: list[list[float]]


@app.post("/api/sdf.bin")
def custom_sdf(req: SdfReq):
    """Bake an SDF for a client-authored footprint (custom box). Same wire format as the IFC one."""
    if len(req.footprint) < 3:
        raise HTTPException(400, "footprint needs at least 3 points")
    g = _sdf_from_footprint(req.footprint)
    h, w = g.shape
    header = struct.pack("<4sIIIffff", b"SDF1", 1, w, h,
                         g.origin[0], g.origin[1], g.cell, float(g.widx.max() + 1))
    body = g.dist.astype("<f4").tobytes() + g.widx.astype("<f4").tobytes()
    return Response(content=header + body, media_type="application/octet-stream")


@app.post("/api/export")
def export(req: ExportReq):
    s_info = find_splats().get(req.splat_id)
    if not s_info:
        raise HTTPException(404, f"unknown splat {req.splat_id!r}")

    if req.custom is not None:
        # Draw-your-own-box: geometry + transform come straight from the client.
        r = ifc_room.room_from_footprint(req.custom.footprint, req.custom.height,
                                         name=req.custom.name)
        g = _sdf_from_footprint(req.custom.footprint)
        s, R, t = align.from_matrix4(req.custom.matrix4_row_major)
        pivot = (0.0, 0.0, req.custom.height / 2.0)
        if req.refine is not None:
            s, R, t = align.compose_refine(s, R, t, req.refine.model_dump(), pivot=pivot)
        stats = {"rms": 0.0}
        room_key = "custom"
    else:
        if not req.room_id:
            raise HTTPException(400, "room_id or custom is required")
        r = get_room(req.room_id)
        g = get_grid(req.room_id)
        s, R, t, stats = _solve_pairs(req.pairs, req.yaw_only, req.refine, req.room_id)
        room_key = req.room_id

    n = len(r.walls)
    if len(req.crop.wall_offset) != n or len(req.crop.wall_feather) != n:
        raise HTTPException(400, f"room has {n} walls; crop arrays must match")

    height = req.crop.height if req.crop.height is not None else r.height
    if height <= 0:
        raise HTTPException(400, "height must be positive")
    params = {
        "wall_offset": np.array(req.crop.wall_offset, dtype=np.float32),
        "wall_feather": np.array(req.crop.wall_feather, dtype=np.float32),
        "floor_offset": req.crop.floor_offset, "floor_feather": req.crop.floor_feather,
        "ceil_offset": req.crop.ceil_offset, "ceil_feather": req.crop.ceil_feather,
        "height": height,
        "max_scale": req.crop.max_scale, "min_opacity": req.crop.min_opacity,
    }

    out_dir = resolve_out_root() / room_key / req.splat_id.replace("/", "__")
    reopen = dict(req.reopen or {})
    reopen.setdefault("splat_id", req.splat_id)
    reopen.setdefault("custom_mode", req.custom is not None)
    reopen.setdefault("yaw_only", req.yaw_only)
    # Colour the IFC with the walls/slab colours the user picked in Twin preview (sent under
    # reopen.twin), so cleaned.ifc matches what they saw instead of a default grey.
    twin = reopen.get("twin") or {}
    result = clean.run(
        export_source_ply(s_info), r, g, s, R, t, params, out_dir,
        pairs=([{"splat": p.splat, "room": p.room} for p in req.pairs] if req.pairs else None),
        write_sog=req.write_sog, label=req.label, wall_thickness=req.wall_thickness,
        refine=req.refine.model_dump() if req.refine else None,
        reopen=reopen,
        wall_color=twin.get("wallColor"), floor_color=twin.get("slabColor"),
        wall_anchor=twin.get("anchor", "center"), wall_offset=twin.get("offset", 0.0),
    )
    result["rms"] = stats["rms"]
    return result


def _reload_from_sidecar(sc: dict, room_key: str, splat_id: str | None, custom_mode: bool) -> dict:
    """Assemble everything the Clean stage needs to be re-opened, from a parsed sidecar.

    Most of it is already recorded (final transform, manual refine, crop, pairs); the `reopen`
    block fills the gaps (yaw-only flag, and a custom box's footprint + base transform + basis).
    """
    reopen = sc.get("reopen") or {}
    crop = sc.get("crop") or {}
    alignment = sc.get("alignment") or {}
    source = sc.get("source") or {}
    rl = {
        "splat_id": splat_id,
        "custom_mode": custom_mode,
        "yaw_only": reopen.get("yaw_only", True),
        "refine": alignment.get("manual_refine"),
        "crop": crop,
        "room_height": crop.get("height"),
        "room_name": source.get("room", room_key),
        "matrix4_row_major": alignment.get("matrix4_row_major"),
        "rms": (sc.get("result") or {}).get("rms"),
        # The Twin-preview look this export was tuned at (absent on exports made before it existed).
        "twin": reopen.get("twin"),
    }
    if custom_mode:
        c = reopen.get("custom") or {}
        rl["custom"] = {
            "footprint": c.get("footprint"),
            "matrix4_row_major": c.get("matrix4_row_major"),
            "basis": c.get("basis"),
            "height": crop.get("height"),
            "name": source.get("room", "custom box"),
        }
        # A legacy custom export never stored its footprint/base transform, so it can't be rebuilt.
        rl["reloadable"] = bool(c.get("footprint") and c.get("matrix4_row_major")
                                and rl["matrix4_row_major"])
    else:
        rl["room_id"] = room_key
        rl["pairs"] = alignment.get("pairs")
        rl["reloadable"] = bool(alignment.get("pairs") and rl["matrix4_row_major"])
    return rl


def find_exports() -> list[dict]:
    """Enumerate previously exported cleans under OUT_ROOT (each is a `*.alignment.json` sidecar)."""
    out_root = resolve_out_root()
    if not out_root.exists():
        return []
    splats = find_splats()
    ply_to_id = {s["ply"]: sid for sid, s in splats.items() if s["ply"]}
    # SOG-only scans export from a cached decode whose name changes with the SOG; the sidecar's
    # reopen.splat_id (always written) maps those back.
    items: list[dict] = []
    for side in sorted(out_root.glob("*/*/*.alignment.json")):
        try:
            sc = json.loads(side.read_text())
        except Exception:
            continue
        d = side.parent
        room_key = d.parent.name
        reopen = sc.get("reopen") or {}
        custom_mode = (room_key == "custom") or bool(reopen.get("custom_mode")) or bool(reopen.get("custom"))
        # Prefer matching the recorded PLY path back to a live scan; fall back to what we stored.
        splat_id = ply_to_id.get((sc.get("source") or {}).get("splat_ply")) or reopen.get("splat_id")
        if not splat_id:
            splat_id = d.name.replace("__", "/")
        items.append({
            "id": str(side.relative_to(out_root)),
            "dir": str(d),
            "label": side.name[: -len(".alignment.json")],
            "room_key": room_key,
            "room_name": (sc.get("source") or {}).get("room", room_key),
            "splat_id": splat_id,
            "splat_available": splat_id in splats,
            "custom_mode": custom_mode,
            "created": sc.get("created"),
            "kept_fraction": (sc.get("result") or {}).get("kept_fraction"),
            "reload": _reload_from_sidecar(sc, room_key, splat_id, custom_mode),
        })
    items.sort(key=lambda x: x.get("created") or "", reverse=True)
    return items


@app.post("/api/auto_room/{splat_id:path}")
def auto_room_box(splat_id: str, force: bool = False):
    """Detect the room box from the splat alone; returns a reopen-shaped payload for Clean."""
    import auto_clean  # lazy: auto_clean imports this module
    s_info = find_splats().get(splat_id)
    if not s_info:
        raise HTTPException(404, f"unknown splat {splat_id!r}")
    try:
        res, _, _ = auto_clean.detect(splat_id, s_info, force=force)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(422, f"could not detect a room: {e}")
    return auto_clean.box_payload(splat_id, s_info, res)


@app.get("/api/exports")
def exports():
    """Previously exported cleans, newest first, each with a `reload` payload for the Clean stage."""
    return {"exports": find_exports(), "out_root": str(resolve_out_root())}


@app.get("/api/vault")
def vault_status():
    """Cheap mount check (no scan walk) — the frontend polls this while the share is down."""
    ok = splat_root_ok()
    return {"splat_root": str(SPLAT_ROOT), "splat_root_exists": ok,
            "configured": vault.configured(), "error": None if ok else vault.last_error}


@app.get("/api/health")
def health():
    return {"ok": True, "splat_root_exists": SPLAT_ROOT.exists(),
            "n_splats": len(find_splats()), "n_rooms": len(find_rooms())}
