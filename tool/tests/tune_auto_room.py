"""Tune auto_room's mask knobs across every scan: prepare once (cached), render contact sheets.

    python3 tests/tune_auto_room.py '{"close_r": 6}' [name-filter]

Each tile: structure density (orange), ceiling (blue), detected outline (yellow), and the share of
the scan's in-height structure mass that falls inside the outline.
"""
import json, pickle, sys
from pathlib import Path
import cv2, numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import app, auto_room, ply  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PREP = ROOT / ".cache" / "auto_prep"; OUT = ROOT / "out" / "auto_tune"


def prepared(sid, s):
    f = PREP / (sid.replace("/", "__") + ".pkl")
    if f.exists():
        return pickle.loads(f.read_bytes())
    d, props = ply.read(app.export_source_ply(s))
    P = auto_room.prepare(d, props)
    f.parent.mkdir(parents=True, exist_ok=True); f.write_bytes(pickle.dumps(P))
    return P


def tile(sid, P, kw):
    dbg = {}
    r = auto_room.solve(prepared=P, debug=dbg, **kw)
    a = np.log1p(dbg["wall_img"]); a = (255 * a / max(a.max(), 1e-9)).astype(np.uint8)
    b = np.log1p(dbg["floor_img"]); b = (255 * b / max(b.max(), 1e-9)).astype(np.uint8)
    rgb = np.dstack([a, a // 2 + b // 2, b])
    ctr = dbg["poly_xy"].mean(0)
    px = np.rint((np.asarray(r["footprint"]) + ctr - dbg["lo"]) / dbg["cell"]).astype(np.int32)
    poly = np.zeros(rgb.shape[:2], np.uint8); cv2.fillPoly(poly, [px.reshape(-1, 1, 2)], 1)
    mass = float((dbg["wall_img"] * poly).sum() / dbg["wall_img"].sum())
    cv2.polylines(rgb, [px.reshape(-1, 1, 2)], True, (255, 255, 0), 1)
    rgb = rgb[::-1]
    h, w = rgb.shape[:2]; sc = 300 / max(h, w)
    rgb = cv2.resize(rgb, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
    t = np.zeros((330, 310, 3), np.uint8); t[25:25 + rgb.shape[0], 5:5 + rgb.shape[1]] = rgb
    cv2.putText(t, f"{sid.split('/')[0][:22]} {100 * mass:.0f}% {r['n_corners']}c", (5, 18),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
    return cv2.cvtColor(t, cv2.COLOR_RGB2BGR), mass


def elevation(sid, P):
    """Side view (x-z, levelled frame) with the detected floor (yellow) and ceiling (cyan)."""
    xyz, w = P["xyz"], P["w"]
    x, z = xyz[:, 0], xyz[:, 2]
    lo = np.percentile(np.c_[x, z], 0.5, 0); hi = np.percentile(np.c_[x, z], 99.5, 0)
    span = hi - lo; lo = lo - 0.15 * span; hi = hi + 0.15 * span
    W, H = 300, 160
    img, _, _ = np.histogram2d(z, x, bins=(H, W), range=((lo[1], hi[1]), (lo[0], hi[0])), weights=w)
    img = np.log1p(img); img = (255 * img / max(img.max(), 1e-9)).astype(np.uint8)[::-1]
    rgb = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    for zz, col in ((P["z0"], (0, 255, 255)), (P["z1"], (255, 200, 0))):
        r = int(H - 1 - (zz - lo[1]) / (hi[1] - lo[1]) * H)
        cv2.line(rgb, (0, r), (W, r), col, 1)
    t = np.zeros((185, 305, 3), np.uint8); t[22:22 + H, 2:2 + W] = rgb
    cv2.putText(t, f"{sid.split('/')[0][:18]} tilt {P.get('up_tilt_deg', 0):.0f}deg", (4, 15),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
    return t


def main():
    kw = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    filt = sys.argv[2] if len(sys.argv) > 2 else ""
    OUT.mkdir(parents=True, exist_ok=True)
    tiles, masses, elev = [], [], []
    for sid, s in sorted(app.find_splats().items()):
        if filt and filt.lower() not in sid.lower():
            continue
        P = prepared(sid, s)
        t, m = tile(sid, P, kw); tiles.append(t); masses.append(m); elev.append(elevation(sid, P))
    while len(tiles) % 6: tiles.append(np.zeros_like(tiles[0]))
    sheet = np.vstack([np.hstack(tiles[i:i + 6]) for i in range(0, len(tiles), 6)])
    name = "sheet_" + ("_".join(f"{k}{v}" for k, v in kw.items()) or "default") + ".png"
    cv2.imwrite(str(OUT / name), sheet)
    while len(elev) % 6: elev.append(np.zeros_like(elev[0]))
    cv2.imwrite(str(OUT / name.replace("sheet_", "elev_")),
                np.vstack([np.hstack(elev[i:i + 6]) for i in range(0, len(elev), 6)]))
    print(f"{name}: mean mass captured {100 * np.mean(masses):.1f}%  min {100 * np.min(masses):.1f}%")


if __name__ == "__main__":
    main()
