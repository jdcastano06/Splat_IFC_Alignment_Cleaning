"""auto_room on a synthetic scan with a known answer.

An L-shaped room (floor, ceiling and wall discs, some furniture), tilted 12 deg and yawed 30 deg so
the levelling has real work to do, wrapped in a haze of floaters and with a faint mirrored copy
under its glossy floor. The detector must recover up, the footprint, the floor and the ceiling.
"""

import sys
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import align, auto_room, clean, ply  # noqa: E402

L_SHAPE = np.array([[0, 0], [10, 0], [10, 4], [5, 4], [5, 8], [0, 8]], float)
H = 3.0


def _quat_for_normal(n):
    """Quaternion (w,x,y,z) whose local z axis points along n -- a disc facing n."""
    n = n / np.linalg.norm(n)
    a = np.array([1.0, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 1.0, 0])
    x = np.cross(a, n); x /= np.linalg.norm(x)
    y = np.cross(n, x)
    return clean._mat_to_quat(np.stack([x, y, n], axis=1))


def _discs(pts, normal, rng, size=0.05, opacity=2.0):
    n = len(pts)
    d = np.zeros((n, len(ply.GS_PROPS)), np.float32)
    c = {p: i for i, p in enumerate(ply.GS_PROPS)}
    d[:, [c["x"], c["y"], c["z"]]] = pts
    d[:, c["opacity"]] = opacity
    d[:, [c["scale_0"], c["scale_1"], c["scale_2"]]] = np.log([size, size, size * 0.05])
    d[:, [c["rot_0"], c["rot_1"], c["rot_2"], c["rot_3"]]] = _quat_for_normal(np.asarray(normal, float))
    d[:, [c["f_dc_0"], c["f_dc_1"], c["f_dc_2"]]] = rng.normal(0, 0.3, (n, 3))
    return d


def _inside(poly, xy):
    from matplotlib.path import Path as MPath
    return MPath(poly).contains_points(xy)


def synthetic_scan(seed=0, tilt_deg=12.0, yaw_deg=30.0):
    rng = np.random.default_rng(seed)
    parts = []
    lo, hi = L_SHAPE.min(0), L_SHAPE.max(0)

    def area_pts(n, z):
        xy = rng.uniform(lo, hi, (n * 2, 2))
        xy = xy[_inside(L_SHAPE, xy)][:n]
        return np.c_[xy, np.full(len(xy), z)]

    parts.append(_discs(area_pts(40000, 0.0), [0, 0, 1], rng))             # floor
    parts.append(_discs(area_pts(25000, H), [0, 0, 1], rng))               # ceiling
    for a, b in zip(L_SHAPE, np.roll(L_SHAPE, -1, 0)):                     # walls
        L = np.linalg.norm(b - a)
        k = int(3000 * L)
        t = rng.uniform(0, 1, k)[:, None]
        xy = a + t * (b - a)
        nrm = np.array([b[1] - a[1], -(b[0] - a[0]), 0.0]) / L
        parts.append(_discs(np.c_[xy, rng.uniform(0, H, k)], nrm, rng))
    # furniture: a few desks (horizontal tops at 0.75) and cabinets
    for cx, cy in [(2, 2), (7, 2), (2, 6)]:
        xy = rng.uniform([cx - 1, cy - 0.5], [cx + 1, cy + 0.5], (4000, 2))
        parts.append(_discs(np.c_[xy, np.full(4000, 0.75)], [0, 0, 1], rng))
    # glossy floor: a faint mirrored room below z=0
    m = area_pts(6000, 0.0); m[:, 2] = -rng.uniform(0, H, len(m))
    parts.append(_discs(m, rng.normal(size=3), rng, opacity=-1.0))
    # haze of floaters around the room, big and faint
    hz = rng.uniform(lo - 6, hi + 6, (15000, 2))
    parts.append(_discs(np.c_[hz, rng.uniform(-2, H + 3, len(hz))], rng.normal(size=3), rng,
                        size=0.15, opacity=-2.5))
    data = np.concatenate(parts).astype(np.float32)

    # scan frame = room frame tilted about x, then yawed, then shifted
    R_t = align.euler_xyz(np.radians(tilt_deg), 0, 0)
    R_y = align.euler_xyz(0, 0, np.radians(yaw_deg))
    R = R_y @ R_t
    c = {p: i for i, p in enumerate(ply.GS_PROPS)}
    xyz = data[:, [c["x"], c["y"], c["z"]]].astype(np.float64) @ R.T + [3.0, -2.0, 1.0]
    data[:, [c["x"], c["y"], c["z"]]] = xyz.astype(np.float32)
    q = data[:, [c["rot_0"], c["rot_1"], c["rot_2"], c["rot_3"]]].astype(np.float64)
    data[:, [c["rot_0"], c["rot_1"], c["rot_2"], c["rot_3"]]] = clean._quat_mul(
        clean._mat_to_quat(R), q).astype(np.float32)
    return data, R


@pytest.fixture(scope="module")
def solved():
    data, R_true = synthetic_scan()
    res = auto_room.solve(data, ply.GS_PROPS, n_sample=200_000)
    return data, R_true, res


def test_recovers_up(solved):
    _, R_true, res = solved
    up_true = R_true @ np.array([0, 0, 1.0])            # room +z, seen in scan coordinates
    up_est = np.asarray(res["R"])[2]                    # third row maps scan -> room z
    assert np.degrees(np.arccos(np.clip(up_true @ up_est, -1, 1))) < 2.0


def test_floor_and_ceiling(solved):
    """Floor at the real floor (not the desks, not the mirrored room); height close to H."""
    _, _, res = solved
    assert res["height"] == pytest.approx(H, rel=0.08)


def test_footprint_matches_the_room(solved):
    data, R_true, res = solved
    # bring the true footprint into the auto box frame: room -> scan -> box
    fp = np.c_[L_SHAPE, np.zeros(len(L_SHAPE))]
    scan = fp @ R_true.T + [3.0, -2.0, 1.0]
    box = scan @ np.asarray(res["R"]).T + np.asarray(res["t"])
    A, G = Polygon(res["footprint"]), Polygon(box[:, :2])
    iou = A.intersection(G).area / A.union(G).area
    assert iou > 0.85, f"IoU {iou:.3f}"
    assert 4 <= res["n_corners"] <= 10                  # an L is 6; a clean outline, not a blob


def test_floor_is_z0_in_box_frame(solved):
    data, R_true, res = solved
    fp = np.c_[L_SHAPE, np.zeros(len(L_SHAPE))] @ R_true.T + [3.0, -2.0, 1.0]
    z = (fp @ np.asarray(res["R"]).T + np.asarray(res["t"]))[:, 2]
    assert np.abs(z).max() < 0.08 * H


def test_snap_axes_squares_a_noisy_rectangle():
    rect = np.array([[0, 0], [4.02, 0.05], [4.0, 3.0], [-0.03, 2.97]])
    out = auto_room.snap_axes(rect, 20.0, min_edge=0.1)
    edges = np.roll(out, -1, 0) - out
    ang = np.degrees(np.arctan2(edges[:, 1], edges[:, 0])) % 90
    assert np.all((ang < 1e-6) | (ang > 90 - 1e-6))


def test_visvalingam_drops_a_spike_keeps_corners():
    sq = [[0, 0], [10, 0], [10, 10], [5.1, 10], [5, 10.4], [4.9, 10], [0, 10]]   # tiny spike on top
    out = auto_room.visvalingam(np.asarray(sq, float), 0.01)
    assert len(out) == 4
