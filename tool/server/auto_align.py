"""Automatic splat -> IFC room alignment (no clicked point pairs). EXPERIMENTAL, not wired in.

The no-IFC pipeline (auto_room / auto_clean) is the supported automatic path; it only borrows
`load_features` from here. `solve()` below -- matching a scan to an existing IFC footprint -- is a
prototype kept for the IFC case and has not been benchmarked yet.

Pipeline (all on a random subsample of splat centres):
  1. Normals for free: a flat gaussian's shortest axis is its surface normal.
  2. Level: the scans come out roughly z-up already (every hand alignment so far is within ~6 deg),
     so the floor/ceiling normals near +-z are averaged to fix the residual tilt.
  3. Yaw (mod 90 deg): the dominant wall-normal direction is matched to the footprint's dominant
     edge direction, leaving four candidates.
  4. Global search over (yaw candidate, scale, xy): wall splats are rasterised top-down and
     cross-correlated (FFT) with the footprint's wall raster. The score is precision x recall --
     "splats land on walls" times "walls are covered by splats" -- so shrinking the scan onto one
     wall can't win.
  5. Refine with trimmed point-to-wall ICP (2D similarity) on the room's SDF.
  6. Floor: the lowest strong peak of the levelled height histogram goes to z = 0.

Returns the same (s, R, t) the point-pair solve does, mapping splat -> room space.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import fftconvolve
from scipy.ndimage import binary_dilation, gaussian_filter1d

import align
import sdf

CELL = 0.10          # m, top-down raster resolution for the global search
TOL = 0.15           # m, "on the wall" tolerance
N_SAMPLE = 400_000


# ---------------------------------------------------------------- splat features

def load_features(src: np.ndarray, props: list[str], n: int = N_SAMPLE, seed: int = 0) -> dict:
    """Subsample splats -> xyz, weight (opacity), unit normal, flatness."""
    col = {p: i for i, p in enumerate(props)}
    N = len(src)
    idx = np.sort(np.random.default_rng(seed).choice(N, size=min(n, N), replace=False))
    blk = np.asarray(src[idx], dtype=np.float64)
    xyz = blk[:, [col["x"], col["y"], col["z"]]]
    op = 1.0 / (1.0 + np.exp(-blk[:, col["opacity"]]))
    sc = np.exp(blk[:, [col["scale_0"], col["scale_1"], col["scale_2"]]])
    q = blk[:, [col["rot_0"], col["rot_1"], col["rot_2"], col["rot_3"]]]
    q /= np.linalg.norm(q, axis=1, keepdims=True) + 1e-12
    w, x, y, z = q.T
    # rotation-matrix columns = gaussian's local axes in world space
    Rm = np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)], 1),
        np.stack([2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)], 1),
        np.stack([2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)], 1),
    ], axis=1)                                      # (n, 3 axes, 3 xyz)
    order = np.argsort(sc, axis=1)
    normal = Rm[np.arange(len(idx)), order[:, 0]]
    s_sorted = np.take_along_axis(sc, order, axis=1)
    flat = s_sorted[:, 0] / (s_sorted[:, 1] + 1e-12)   # small = disc-like
    keep = op > 0.3
    return {"xyz": xyz[keep], "w": op[keep], "n": normal[keep], "flat": flat[keep]}


def _rot_a_to_b(a, b) -> np.ndarray:
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b)
    v = np.cross(a, b); c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (v @ v))


def level(f: dict, iters: int = 3) -> np.ndarray:
    """Rotation taking the scan's up (floor/ceiling normals) to +z."""
    disc = f["flat"] < 0.3
    n, w = f["n"][disc], f["w"][disc]
    up = np.array([0.0, 0.0, 1.0])
    for cone in (25.0, 12.0, 6.0)[:iters]:
        d = n @ up
        m = np.abs(d) > np.cos(np.radians(cone))
        if m.sum() < 100:
            break
        nn = n[m] * np.sign(d[m])[:, None]
        up = (nn * w[m, None]).sum(0)
        up /= np.linalg.norm(up)
    return _rot_a_to_b(up, np.array([0.0, 0.0, 1.0]))


def _dominant_angle_mod90(angles: np.ndarray, weights: np.ndarray) -> float:
    """Circular mean of 4*theta -> dominant direction mod 90 deg, in [0, pi/2)."""
    c = (weights * np.cos(4 * angles)).sum(); s = (weights * np.sin(4 * angles)).sum()
    return (np.arctan2(s, c) / 4) % (np.pi / 2)


def _wall_angle_hist_peak(angles, weights) -> float:
    """Histogram peak mod 90 (robust to clutter), refined by a local circular mean."""
    a = angles % (np.pi / 2)
    bins = 180
    h, e = np.histogram(a, bins=bins, range=(0, np.pi / 2), weights=weights)
    h = gaussian_filter1d(h, 2, mode="wrap")
    peak = (e[np.argmax(h)] + e[np.argmax(h) + 1]) / 2
    near = np.abs(((a - peak + np.pi / 4) % (np.pi / 2)) - np.pi / 4) < np.radians(5)
    return _dominant_angle_mod90(angles[near], weights[near]) if near.sum() > 10 else peak


def footprint_angle(footprint) -> float:
    P = np.asarray(footprint, float)
    E = np.roll(P, -1, 0) - P
    return _dominant_angle_mod90(np.arctan2(E[:, 1], E[:, 0]), np.linalg.norm(E, axis=1))


def floor_z(z: np.ndarray, w: np.ndarray) -> tuple[float, float]:
    """(floor, ceiling) heights from the levelled height histogram's outer strong peaks."""
    lo, hi = np.percentile(z, [0.5, 99.5])
    bins = max(50, int((hi - lo) / ((hi - lo) / 200)))
    h, e = np.histogram(z, bins=bins, range=(lo, hi), weights=w)
    h = gaussian_filter1d(h.astype(float), 1.5)
    mid = (e[:-1] + e[1:]) / 2
    strong = h > 0.35 * h.max()
    cand = mid[strong]
    # floor: lowest strong bin's local max; ceiling: highest's
    def local_peak(i):
        j = i
        while 0 < j < len(h) - 1 and (h[j + 1] > h[j] or h[j - 1] > h[j]):
            j = j + 1 if h[j + 1] > h[j] else j - 1
        return mid[j]
    first = np.argmax(strong); last = len(strong) - 1 - np.argmax(strong[::-1])
    return float(local_peak(first)), float(local_peak(last)) if len(cand) else float(hi)


# ---------------------------------------------------------------- global 2D search

def _raster_walls(footprint, cell, pad):
    P = np.asarray(footprint, float)
    lo = P.min(0) - pad; hi = P.max(0) + pad
    W, H = (np.ceil((hi - lo) / cell).astype(int) + 1)
    img = np.zeros((H, W), bool)
    for a, b in zip(P, np.roll(P, -1, 0)):
        L = max(2, int(np.linalg.norm(b - a) / (cell * 0.5)))
        t = np.linspace(0, 1, L)[:, None]
        pts = ((a + t * (b - a)) - lo) / cell
        img[np.rint(pts[:, 1]).astype(int), np.rint(pts[:, 0]).astype(int)] = True
    return img, lo


def _raster_points(xy, w, cell):
    lo = xy.min(0)
    ij = np.floor((xy - lo) / cell).astype(int)
    W, H = ij.max(0) + 1
    img = np.zeros((H, W))
    np.add.at(img, (ij[:, 1], ij[:, 0]), w)
    return img, lo


def global_search(wall_xy, wall_w, footprint, yaw_cands, scales, cell=CELL, tol=TOL):
    walls, wlo = _raster_walls(footprint, cell, pad=2.0)
    r = max(1, int(round(tol / cell)))
    st = np.ones((2 * r + 1, 2 * r + 1), bool)
    walls_d = binary_dilation(walls, st).astype(float)
    walls_f = walls.astype(float)
    n_wall = walls_f.sum()
    best = None
    results = []
    for yaw in yaw_cands:
        c, s_ = np.cos(yaw), np.sin(yaw)
        Rz = np.array([[c, -s_], [s_, c]])
        xy_r = wall_xy @ Rz.T
        for s in scales:
            pts = s * xy_r
            img, plo = _raster_points(pts, wall_w, cell)
            if img.shape[0] > 4000 or img.shape[1] > 4000:
                continue
            occ = binary_dilation(img > 0, st).astype(float)
            # correlation over all integer shifts: corr[k] = sum_x A[x] B[x - k]
            prec = fftconvolve(walls_d, img[::-1, ::-1], mode="full") / img.sum()
            rec = fftconvolve(walls_f, occ[::-1, ::-1], mode="full") / n_wall
            score = prec * rec
            k = np.unravel_index(np.argmax(score), score.shape)
            # shift (in cells) that maps point raster onto wall raster
            dy = k[0] - (img.shape[0] - 1); dx = k[1] - (img.shape[1] - 1)
            t = wlo + np.array([dx, dy]) * cell - plo
            res = (float(score[k]), float(yaw), float(s), t, float(prec[k]), float(rec[k]))
            results.append(res)
            if best is None or res[0] > best[0]:
                best = res
    return best, results


# ---------------------------------------------------------------- local refine

def refine_icp(wall_xy, wall_w, grid, yaw, s, t, iters=30, trim=0.4):
    """Trimmed point-to-wall ICP with a 2D similarity, using the SDF + its gradient."""
    c, s_ = np.cos(yaw), np.sin(yaw)
    A = s * np.array([[c, -s_], [s_, c]]); b = np.asarray(t, float)
    eps = grid.cell
    for it in range(iters):
        p = wall_xy @ A.T + b
        d, _ = sdf.sample(grid, p)
        gx = (sdf.sample(grid, p + [eps, 0])[0] - sdf.sample(grid, p - [eps, 0])[0]) / (2 * eps)
        gy = (sdf.sample(grid, p + [0, eps])[0] - sdf.sample(grid, p - [0, eps])[0]) / (2 * eps)
        g = np.stack([gx, gy], 1); g /= np.linalg.norm(g, axis=1, keepdims=True) + 1e-9
        tr = max(trim * (0.6 ** it), 0.08)
        m = np.abs(d) < tr
        if m.sum() < 50:
            break
        q = p[m] - d[m, None] * g[m]                # projection onto nearest wall
        # weighted 2D similarity src(wall_xy) -> q (Umeyama)
        X = wall_xy[m]; wt = wall_w[m] / wall_w[m].sum()
        mx = wt @ X; mq = wt @ q
        Xc = X - mx; Qc = q - mq
        C = (Qc * wt[:, None]).T @ Xc
        U, S, Vt = np.linalg.svd(C)
        D = np.diag([1.0, np.sign(np.linalg.det(U @ Vt))])
        Rr = U @ D @ Vt
        var = (wt * (Xc ** 2).sum(1)).sum()
        sc = np.trace(np.diag(S) @ D) / var
        A_new = sc * Rr; b_new = mq - A_new @ mx
        if np.abs(A_new - A).max() < 1e-6 and np.abs(b_new - b).max() < 1e-5:
            A, b = A_new, b_new
            break
        A, b = A_new, b_new
    s_out = float(np.sqrt(abs(np.linalg.det(A))))
    yaw_out = float(np.arctan2(A[1, 0], A[0, 0]))
    p = wall_xy @ A.T + b
    d, _ = sdf.sample(grid, p)
    inl = float((wall_w * (np.abs(d) < TOL)).sum() / wall_w.sum())
    return yaw_out, s_out, b, inl


# ---------------------------------------------------------------- top level

def solve(src, props, room, grid, scales=None, seed=0, verbose=False) -> dict:
    f = load_features(src, props, seed=seed)
    Rl = level(f)
    xyz = f["xyz"] @ Rl.T
    n = f["n"] @ Rl.T
    z0, z1 = floor_z(xyz[:, 2], f["w"])
    H = z1 - z0

    # wall splats: vertical-facing discs in the middle height band
    band = (xyz[:, 2] > z0 + 0.15 * H) & (xyz[:, 2] < z1 - 0.15 * H)
    vert = (np.abs(n[:, 2]) < 0.25) & (f["flat"] < 0.35)
    wm = band & vert
    wall_xy, wall_w = xyz[wm, :2], f["w"][wm]
    if len(wall_xy) < 500:                                 # fall back to everything in the band
        wall_xy, wall_w = xyz[band, :2], f["w"][band]

    ang = np.arctan2(n[wm, 1], n[wm, 0]) + np.pi / 2      # normal -> wall direction
    th_scan = _wall_angle_hist_peak(ang, f["w"][wm])
    th_room = footprint_angle(room.footprint)
    yaw0 = th_room - th_scan
    yaw_cands = [yaw0 + k * np.pi / 2 for k in range(4)]

    if scales is None:
        # scale range from the room's size vs the scan's (robust) wall extent, generously wide
        ext_room = np.ptp(np.asarray(room.footprint), 0).max()
        ext_scan = np.ptp(np.percentile(wall_xy, [5, 95], axis=0), 0).max()
        s_mid = ext_room / max(ext_scan, 1e-6)
        scales = s_mid * np.geomspace(0.33, 3.0, 45)

    best, results = global_search(wall_xy, wall_w, room.footprint, yaw_cands, scales)
    score, yaw, s, t, prec, rec = best
    if verbose:
        print(f"  global: yaw={np.degrees(yaw):.1f} s={s:.3f} score={score:.3f} P={prec:.2f} R={rec:.2f}")
    yaw, s, t, inl = refine_icp(wall_xy, wall_w, grid, yaw, s, t)

    c, s_ = np.cos(yaw), np.sin(yaw)
    Rz = np.array([[c, -s_, 0], [s_, c, 0], [0, 0, 1.0]])
    R = Rz @ Rl
    tz = -s * z0
    T = np.array([t[0], t[1], tz])
    return {
        "s": s, "R": R, "t": T,
        "score": score, "precision": prec, "recall": rec, "inlier_fraction": inl,
        "scan_height_m": float(s * H),
        "yaw_candidates_deg": [float(np.degrees(y)) for y in yaw_cands],
        "matrix4_row_major": align.to_matrix4(s, R, T),
    }
