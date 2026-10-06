"""Benchmark auto_room against the hand-drawn custom boxes already exported to the vault.

    python3 tests/bench_auto_room.py [name-filter]

For each `_Cleaned/custom/*/cleaned.alignment.json`: solve the room automatically from the source
splat, map the hand-drawn footprint into the auto box frame, and report footprint IoU, floor
offset and height error (both as a fraction of room height). Overlays go to out/auto_bench/.
"""

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import align, auto_room, ply  # noqa: E402

import cv2  # noqa: E402
from shapely.geometry import Polygon  # noqa: E402

CLEANED = Path(os.environ.get("OUT_ROOT", "/Volumes/SMART_vault/06_Research_projects/Splats/_Cleaned")) / "custom"
OUT = Path(__file__).resolve().parents[2] / "out" / "auto_bench"


def gt_in_auto_frame(sc: dict, res: dict):
    c = sc["reopen"]["custom"]
    s_g, R_g, t_g = align.from_matrix4(sc["alignment"]["matrix4_row_major"])
    fp = np.asarray(c["footprint"], float)
    q = np.c_[fp, np.zeros(len(fp))]
    p = ((q - t_g) @ R_g) / s_g                         # GT box frame -> scan
    a = (p @ res["R"].T) * res["s"] + res["t"]          # scan -> auto box frame
    H_gt = sc["crop"]["height"] / s_g                   # crop height is in (scaled) box units
    return a, H_gt


def overlay(dbg, res, gt_xy, path):
    img = np.log1p(dbg["floor_img"]); img = (255 * img / max(img.max(), 1e-9)).astype(np.uint8)
    wal = np.log1p(dbg["wall_img"]); wal = (255 * wal / max(wal.max(), 1e-9)).astype(np.uint8)
    rgb = np.dstack([wal, img, img // 2])
    rgb[dbg["room"]] = (0.6 * rgb[dbg["room"]] + [0, 0, 90]).astype(np.uint8)
    lo, cell = dbg["lo"], dbg["cell"]
    ctr = dbg["poly_xy"].mean(0)

    def px(xy):  # auto-frame xy -> pixel
        return np.rint((xy + ctr - lo) / cell).astype(np.int32).reshape(-1, 1, 2)
    cv2.polylines(rgb, [px(np.asarray(res["footprint"]))], True, (255, 255, 0), 2)
    cv2.polylines(rgb, [px(gt_xy)], True, (255, 0, 255), 2)
    rgb = cv2.resize(rgb[::-1], None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(str(path), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))


def main(filt=""):
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for side in sorted(CLEANED.glob("*/cleaned.alignment.json")):
        if filt and filt.lower() not in side.parent.name.lower():
            continue
        sc = json.loads(side.read_text())
        src_ply = sc["source"]["splat_ply"]
        t0 = time.time()
        data, props = ply.read(src_ply)
        dbg = {}
        res = auto_room.solve(data, props, debug=dbg)
        gt, H_gt = gt_in_auto_frame(sc, res)
        A, G = Polygon(res["footprint"]), Polygon(gt[:, :2])
        iou = A.intersection(G).area / A.union(G).area if A.is_valid and G.is_valid else float("nan")
        floor_err = float(np.mean(gt[:, 2])) / H_gt
        h_err = (res["height"] - H_gt) / H_gt
        name = side.parent.name.split("__")[0]
        overlay(dbg, res, gt[:, :2], OUT / f"{name}.png")
        rows.append((name, iou, floor_err, h_err, res["n_corners"], len(gt), time.time() - t0))
        print(f"{name:16s} IoU={iou:.3f}  floor_err={floor_err:+.3f}H  height_err={h_err:+.3f}  "
              f"corners auto/gt={res['n_corners']}/{len(gt)}  {time.time() - t0:.0f}s", flush=True)
    if rows:
        print(f"mean IoU {np.nanmean([r[1] for r in rows]):.3f}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
