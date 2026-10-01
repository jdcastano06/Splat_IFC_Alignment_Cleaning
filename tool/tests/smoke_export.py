"""End-to-end export against the real 300 MB gs.ply. Run manually:

    python3 tests/smoke_export.py [room_id]

Not part of the pytest suite -- it reads hundreds of MB off the vault and shells out to
splat-transform, so it is minutes, not milliseconds. But it is the only thing that proves the
actual deliverable: a cleaned PLY + SOG that a viewer can open.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
import align, ply  # noqa: E402

API = "http://localhost:8777"
ROOM = sys.argv[1] if len(sys.argv) > 1 else "libra_lab"
SPLAT = "Libra_Lab/Libra_Lab-20260715"


def get(p):
    return json.load(urllib.request.urlopen(f"{API}{p}"))


def post(p, body):
    r = urllib.request.Request(f"{API}{p}", method="POST", data=json.dumps(body).encode(),
                               headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r))


def robust_box(path, lo=2, hi=98, stride=97):
    data, props = ply.read(path)
    xyz = np.array(data[::stride, :3], dtype=np.float64)
    return np.percentile(xyz, lo, axis=0), np.percentile(xyz, hi, axis=0)


def main():
    room = get(f"/api/room/{ROOM}")
    info = get(f"/api/splat/{SPLAT}/info")
    print(f"room  : {room['name']} · {len(room['footprint'])} walls · h {room['height']} m")
    print(f"splat : {info['ply_count']:,} splats · {info['ply_bytes']/1e6:.0f} MB")

    t0 = time.time()
    lo, hi = robust_box(info["ply"])
    print(f"core  : {np.round(lo,2)} .. {np.round(hi,2)}  ({time.time()-t0:.1f}s)")

    # Map the splat's dense core onto the room: not a real alignment, but a plausible one, so
    # the crop has something to bite on.
    fp = np.asarray(room["footprint"])
    room_size = float(max(fp.max(0) - fp.min(0)))
    s = room_size / float(max((hi - lo)[:2]))
    c = (lo + hi) / 2
    P = np.array([[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]],
                  [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]])
    Q = (P - np.array([c[0], c[1], lo[2]])) * s
    pairs = [{"splat": p.tolist(), "room": q.tolist()} for p, q in zip(P, Q)]

    sol = post("/api/solve", {"pairs": pairs, "yaw_only": True, "room_id": ROOM})
    print(f"solve : scale={sol['scale']:.5f} rms={sol['rms']:.2e}")

    n = len(room["walls"])
    body = {
        "splat_id": SPLAT, "room_id": ROOM, "pairs": pairs, "yaw_only": True,
        "refine": {"scale": 1.0, "rotation_euler_xyz": [0, 0, 0.05], "translation": [0.01, 0, 0]},
        "crop": {
            "wall_offset": [0.0] * n, "wall_feather": [0.25] * n,
            "floor_offset": 0.0, "floor_feather": 0.1,
            "ceil_offset": 0.0, "ceil_feather": 0.25,
        },
        "write_sog": True, "label": "smoke",
    }
    print("export: running (reads the full PLY, then splat-transform)…")
    t0 = time.time()
    r = post("/api/export", body)
    print(f"export: {time.time()-t0:.0f}s  kept {r['splats_out']:,}/{r['splats_in']:,} "
          f"({r['kept_fraction']*100:.1f}%)  ply {r['bytes']/1e6:.0f} MB")
    print("sog   :", r.get("sog_result"))

    ok = True

    def chk(name, cond, detail=""):
        nonlocal ok
        print(f"{'PASS' if cond else 'FAIL'}  {name}{' — ' + detail if detail else ''}")
        ok = ok and bool(cond)

    chk("kept some splats", 0 < r["splats_out"] < r["splats_in"],
        f"{r['kept_fraction']*100:.1f}% kept")

    # The exported PLY must be readable, and every kept splat must sit inside the room prism
    # (plus a hair for the feather). This is the real proof the crop applied to the export.
    out, props = ply.read(r["ply"])
    chk("exported PLY reads back", len(out) == r["splats_out"], f"{len(out):,} rows")
    chk("property layout preserved", props == ply.GS_PROPS)

    xyz = np.array(out[:, :3], dtype=np.float64)
    zmin, zmax = xyz[:, 2].min(), xyz[:, 2].max()
    chk("splats sit within floor/ceiling", zmin >= -0.01 and zmax <= room["height"] + 0.01,
        f"z {zmin:.3f} .. {zmax:.3f} (room 0 .. {room['height']})")

    from shapely.geometry import Polygon, Point
    poly = Polygon(room["footprint"])
    idx = np.random.default_rng(0).choice(len(xyz), size=min(3000, len(xyz)), replace=False)
    outside = sum(1 for i in idx if not poly.buffer(0.02).contains(Point(xyz[i, 0], xyz[i, 1])))
    chk("splats sit within the footprint", outside == 0, f"{outside}/{len(idx)} outside")

    # The bundled IFC must exist and re-parse to the box at the height we exported.
    import ifc_room
    chk("IFC written", bool(r.get("ifc")) and Path(r["ifc"]).exists(), r.get("ifc"))
    if r.get("ifc"):
        rr = ifc_room.extract(r["ifc"])
        chk("IFC height matches export", abs(rr.height - room["height"]) < 1e-3,
            f"{rr.height:.2f} vs {room['height']:.2f}")

    side = json.load(open(r["sidecar"]))
    chk("sidecar records the refine",
        side["alignment"]["manual_refine"]["rotation_euler_xyz"][2] == 0.05)
    chk("sidecar method notes the nudge", "manual-refine" in side["alignment"]["method"],
        side["alignment"]["method"])
    chk("SOG written", bool(r.get("sog_result", {}).get("ok")),
        str(r.get("sog_result", {}).get("error", ""))[:200])

    # config.json must be untouched -- the user asked for a sidecar, not a rewrite.
    cfg = ROOT.parent / "IFC" / ROOM / "config.json"
    if cfg.exists():
        c = json.load(open(cfg))
        chk("config.json left alone",
            c["pointcloud"]["alignment"]["method"] == "none"
            and c["pointcloud"]["transform"]["scale"] == 1)

    print("\nSMOKE PASSED" if ok else "\nSMOKE FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
