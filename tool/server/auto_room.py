"""Automatic room box from the splat alone -- no IFC, no clicks.

Produces exactly what the "Draw a custom box" stage authors by hand: a floor footprint polygon, a
height, and the scan -> box transform (levelled, floor at z = 0, scan units, scale 1). Everything
downstream (crop, feather, cleaned.ply/.sog, cleaned.ifc, reopen) is then the existing path.

  1. Level: floor/ceiling disc normals -> up (auto_align.level). Floor & ceiling: the outer edges
     of the lowest / highest dense height bins (see vertical_extent).
  2. Top-down maps on a grid ~1/250 of the scan extent: flat floor/ceiling discs, wall discs,
     and all structure between floor and ceiling.
  3. Room = where the scan saw floor or ceiling (only the room's interior has those -- floater
     haze and whatever is visible through windows doesn't), closed, grown a short way out to the
     walls. Falls back to "all dense structure" (`density_mask`) when floor/ceiling coverage is
     too thin to trust.
  4. Outline -> Douglas-Peucker polygon (a handful of corners, like a hand-drawn box).
"""

from __future__ import annotations

import cv2
import numpy as np
from scipy import ndimage as ndi

import align
import auto_align as aa


def _disk(r: int) -> np.ndarray:
    r = max(1, int(r))
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def _hemisphere(n: int) -> np.ndarray:
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - i / n)                      # z >= 0 only (directions are axis-ambiguous)
    th = np.pi * (1 + 5 ** 0.5) * i
    return np.c_[np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)]


def manhattan_frame(n: np.ndarray, w: np.ndarray, xyz: np.ndarray, sigma_deg: float = 6.0,
                    seed: int = 0):
    """Three dominant orthogonal surface directions of a scan, from its disc normals.

    -> rotation whose rows are (e1, e2, up): up is the Manhattan axis nearest the scan's +z (every
    scan seen so far is within ~20 deg of z-up; the walls give e1). If no axis is near z, the one
    along which the scan is thinnest is taken as up (rooms are wider than they are tall).
    """
    rng = np.random.default_rng(seed)
    sub = rng.choice(len(n), min(len(n), 60_000), replace=False)
    ns, ws = n[sub], w[sub]
    sig = np.radians(sigma_deg)

    def score(D):
        ang = np.arccos(np.clip(np.abs(ns @ D.T), 0.0, 1.0))
        return (np.exp(-ang ** 2 / (2 * sig ** 2)) * ws[:, None]).sum(0)

    def refine(d):                                   # local weighted mean, sign-aligned
        for cone in (8.0, 4.0):
            dot = n @ d
            m = np.abs(dot) > np.cos(np.radians(cone))
            if m.sum() < 50:
                break
            d = ((n[m] * np.sign(dot[m])[:, None]) * w[m, None]).sum(0)
            d /= np.linalg.norm(d)
        return d

    C = _hemisphere(4000)
    d1 = refine(C[np.argmax(score(C))])
    a = np.cross(d1, [1.0, 0, 0] if abs(d1[0]) < 0.9 else [0, 1.0, 0]); a /= np.linalg.norm(a)
    b = np.cross(d1, a)
    th = np.linspace(0, np.pi, 360, endpoint=False)
    ring = np.outer(np.cos(th), a) + np.outer(np.sin(th), b)
    d2 = ring[np.argmax(score(ring))]
    d2 = d2 - (d2 @ d1) * d1; d2 /= np.linalg.norm(d2)
    D = np.array([d1, d2, np.cross(d1, d2)])
    S = score(D)
    k = int(np.argmax(np.abs(D[:, 2])))
    if abs(D[k, 2]) < 0.8:                           # nothing near z: thinnest axis is up
        ext = [np.ptp(np.percentile(xyz @ v, [2, 98])) for v in D]
        k = int(np.argmin(ext))
    up = D[k] * np.sign(D[k, 2] or 1.0)
    rest = [i for i in range(3) if i != k]
    j = max(rest, key=lambda i: S[i])                # strongest wall direction -> e1
    e1 = D[j] - (D[j] @ up) * up; e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)
    return np.array([e1, e2, up]), {"axis_scores": S.tolist(), "up_tilt_deg":
                                    float(np.degrees(np.arccos(min(1.0, abs(up[2])))))}


def vertical_extent(z: np.ndarray, w: np.ndarray, horiz: np.ndarray, bins: int = 160,
                    floor_frac: float = 0.10, ceil_frac: float = 0.03, peak_frac: float = 0.05,
                    ceil_peak_frac: float = 0.015,
                    run_frac: float = 0.05, max_ext: float = 0.08, beyond_max: float = 0.03):
    """(floor, ceiling) of the room in levelled scan units.

    Two estimates, and the safe one wins unless the tight one is clearly right:
      * safe  -- outer edges of the dense height bins (floor strict at `floor_frac` so the weak
                 mirrored room under a glossy floor is cut; ceiling lenient at `ceil_frac` since
                 ceilings are sparse). Never cuts the room, but can keep floater haze.
      * tight -- the outermost horizontal-disc peaks (floor/ceiling slabs), each pushed out while
                 density stays continuous. Trims haze, but a desk or mezzanine peak can masquerade
                 as a slab.
    Tight replaces safe on a side only if what lies between them is under `beyond_max` of the
    room's mass -- i.e. it's haze, not a room half.
    """
    lo, hi = np.percentile(z, [0.2, 99.8])
    h_all, e = np.histogram(z, bins=bins, range=(lo, hi), weights=w)
    h_hor, _ = np.histogram(z[horiz], bins=bins, range=(lo, hi), weights=w[horiz])
    h_all = ndi.gaussian_filter1d(h_all.astype(float), 1.0)
    h_hor = ndi.gaussian_filter1d(h_hor.astype(float), 1.5)

    lo_ok = np.nonzero(h_all > floor_frac * h_all.max())[0]
    hi_ok = np.nonzero(h_all > ceil_frac * h_all.max())[0]
    s0, s1 = lo_ok[0], hi_ok[-1]                                   # safe bin range

    def peaks(frac):
        return [i for i in range(max(1, s0), min(bins - 1, s1 + 1))
                if h_hor[i] >= h_hor[i - 1] and h_hor[i] >= h_hor[i + 1]
                and h_hor[i] > frac * h_hor.max()]
    # a ceiling slab may be faint next to the floor (sparse roof), so it gets a lower bar; haze
    # rarely forms horizontal discs, so a faint flat layer up there is still a real surface
    pf, pc = peaks(peak_frac), peaks(ceil_peak_frac)
    t0, t1 = s0, s1
    if pf and pc and pc[-1] > pf[0]:
        i0, i1 = pf[0], pc[-1]
        step = max(1, int(max_ext * (i1 - i0)))
        thr = run_frac * h_all.max()
        j0 = i0
        while j0 > s0 and i0 - j0 < step and h_all[j0 - 1] > thr:
            j0 -= 1
        j1 = i1
        while j1 < s1 and j1 - i1 < step and h_all[j1 + 1] > thr:
            j1 += 1
        room = h_all[s0:s1 + 1].sum()
        if h_all[s0:j0].sum() < beyond_max * room:
            t0 = j0
        if h_all[j1 + 1:s1 + 1].sum() < beyond_max * room:
            t1 = j1
    return float(e[t0]), float(e[t1 + 1])


def visvalingam(xy: np.ndarray, min_area_frac: float) -> np.ndarray:
    """Drop the vertex spanning the smallest triangle until every remaining one spans at least
    `min_area_frac` of the polygon's area. Spikes and stair-steps go first; real corners stay."""
    P = [np.asarray(q, float) for q in xy]
    A = abs(0.5 * sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(P, P[1:] + P[:1])))
    while len(P) > 4:
        n = len(P)
        tri = [abs(0.5 * ((P[i][0] - P[i - 1][0]) * (P[(i + 1) % n][1] - P[i - 1][1])
                          - (P[(i + 1) % n][0] - P[i - 1][0]) * (P[i][1] - P[i - 1][1])))
               for i in range(n)]
        i = int(np.argmin(tri))
        if tri[i] >= min_area_frac * A:
            break
        P.pop(i)
    return np.asarray(P)


def snap_axes(xy: np.ndarray, tol_deg: float, min_edge: float) -> np.ndarray:
    """Make near-axis edges exactly axis-aligned (walls are grid-aligned in the Manhattan frame),
    keep genuinely diagonal walls, and rebuild corners as intersections of consecutive edges."""
    P = np.asarray(xy, float)
    keep = [P[0]]
    for q in P[1:]:
        if np.linalg.norm(q - keep[-1]) >= min_edge:
            keep.append(q)
    P = np.asarray(keep)
    if len(P) > 3 and np.linalg.norm(P[0] - P[-1]) < min_edge:
        P = P[:-1]
    n = len(P)
    lines = []                                   # (point on line, direction)
    for i in range(n):
        a, b = P[i], P[(i + 1) % n]
        d = b - a
        ang = np.degrees(np.arctan2(d[1], d[0])) % 180
        m = (a + b) / 2
        if min(ang, 180 - ang) < tol_deg:
            lines.append((m, np.array([1.0, 0.0])))
        elif abs(ang - 90) < tol_deg:
            lines.append((m, np.array([0.0, 1.0])))
        else:
            lines.append((m, d / (np.linalg.norm(d) + 1e-12)))
    out = []
    for i in range(n):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        cross = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(cross) < 1e-6:                    # parallel neighbours: no corner between them
            continue
        t = ((p2 - p1)[0] * d2[1] - (p2 - p1)[1] * d2[0]) / cross
        out.append(p1 + t * d1)
    out = np.asarray(out) if len(out) >= 3 else P
    # guard: if snapping threw a corner far out, keep the unsnapped outline
    if np.abs(out - P.mean(0)).max() > 3 * np.abs(P - P.mean(0)).max():
        return P
    return out


def prepare(src, props, seed: int = 0, n_sample: int = 600_000) -> dict:
    """The slow part, done once per scan: sample, level, yaw to the walls, vertical extent."""
    f = aa.load_features(src, props, n=n_sample, seed=seed)
    disc = f["flat"] < 0.3
    # Manhattan frame: levels the scan AND puts the dominant walls on the grid axes
    R, info = manhattan_frame(f["n"][disc], f["w"][disc], f["xyz"], seed=seed)
    xyz = f["xyz"] @ R.T
    w = f["w"]
    nz = np.abs(f["n"] @ R[2])
    disc = f["flat"] < 0.3
    hz, vt = disc & (nz > 0.9), disc & (nz < 0.2)                # flat floor/ceiling vs wall discs
    z0, z1 = vertical_extent(xyz[:, 2], w, horiz=hz)
    return {"xyz": xyz, "w": w, "R": R, "z0": z0, "z1": z1, "hz": hz, "vt": vt, **info}


VERSION = "fc1"  # bump when detection changes, so auto_clean's cached boxes are recomputed

# Footprint-mask knobs (tuned on the vault's 22 scans; see tests/bench_auto_room.py).
# Floor/ceiling mask: mean IoU vs the 5 hand-drawn boxes 0.80 -> 0.85, and it stops swallowing
# the haze around corridor-like scans (CCS_AD 0.43 -> 0.67).
MASK = dict(q_struct=15, q_ceil=15, close_r=6, open_r=2, keep_frac=0.15, min_area=0.01,
            seed_sigma=5.0, seed_frac=0.04, seed_close=10, wall_frac=0.15, grow=6,
            min_floor_ceil=0.01)


def _grid(P: dict, grid_n: int):
    xyz, z0, z1 = P["xyz"], P["z0"], P["z1"]
    inside_z = (xyz[:, 2] >= z0) & (xyz[:, 2] <= z1)
    lo = np.percentile(xyz[inside_z, :2], 0.5, axis=0)
    hi = np.percentile(xyz[inside_z, :2], 99.5, axis=0)
    cell = float(np.max(hi - lo) / grid_n)
    lo, hi = lo - 8 * cell, hi + 8 * cell
    shape = (np.ceil((hi - lo) / cell).astype(int) + 1)[::-1]     # (rows=y, cols=x)

    def raster(m):
        ij = np.floor((xyz[m, :2] - lo) / cell).astype(int)
        ok = (ij >= 0).all(1) & (ij[:, 0] < shape[1]) & (ij[:, 1] < shape[0])
        img = np.zeros(shape)
        np.add.at(img, (ij[ok, 1], ij[ok, 0]), P["w"][m][ok])
        return img
    return lo, cell, raster, inside_z


def room_mask(P: dict, grid_n: int = 250, **kw):
    """Top-down room mask -> (mask, lo, cell, maps), from floor/ceiling coverage grown to the walls;
    the density mask when the scan has too little floor/ceiling to go on. Re-run freely."""
    k = {**MASK, **{a: b for a, b in kw.items() if b is not None}}
    dense, lo, cell, maps = density_mask(P, grid_n=grid_n, **kw)
    if "hz" not in P:                                   # prepared before the floor/ceiling cues
        return dense, lo, cell, maps
    _, _, raster, inside_z = _grid(P, grid_n)
    zr = (P["xyz"][:, 2] - P["z0"]) / (P["z1"] - P["z0"])
    floor_ceil = P["hz"] & (((zr > -0.03) & (zr < 0.10)) | ((zr > 0.85) & (zr < 1.03)))
    # every usable scan has 2.6-6.4% of its in-room splats on floor/ceiling; a degenerate one
    # (Space_12, 0.3%) has too little to outline a room with, so keep the density mask
    if floor_ceil.sum() < k["min_floor_ceil"] * max(inside_z.sum(), 1):
        return dense, lo, cell, maps
    ev = ndi.gaussian_filter(raster(floor_ceil), k["seed_sigma"])
    wall = ndi.gaussian_filter(raster(P["vt"] & (zr > 0.1) & (zr < 0.9)), 0.7)

    def rel(img, frac):                                 # robust: fraction of the 98th percentile
        nz = img[img > 1e-9]
        return img > frac * (np.percentile(nz, 98) if len(nz) else np.inf)

    # seed: wherever floor or ceiling was seen (sparse ceilings still count once blurred)
    seed = ndi.binary_opening(rel(ev, k["seed_frac"]), _disk(1))
    seed = ndi.binary_fill_holes(ndi.binary_closing(seed, _disk(k["seed_close"])))
    lab, n = ndi.label(seed)
    if n == 0:
        return dense, lo, cell, maps
    mass = ndi.sum(ev, lab, index=np.arange(1, n + 1))
    seed = np.isin(lab, 1 + np.nonzero(mass >= k["keep_frac"] * mass.max())[0])
    # grow a few cells out to the walls (floor near a wall is often hidden by furniture), never
    # through one, then take the wall itself so the cut lands on it rather than inside
    walls = rel(wall, k["wall_frac"])
    grown = ndi.binary_dilation(seed, structure=ndi.generate_binary_structure(2, 1),
                                iterations=k["grow"], mask=~walls | seed)
    room = grown | (walls & ndi.binary_dilation(grown, iterations=2))
    room = ndi.binary_fill_holes(ndi.binary_closing(room, _disk(3)))
    room = ndi.binary_opening(room, _disk(2))
    lab, n = ndi.label(room)
    if n == 0:
        return dense, lo, cell, maps
    sizes = ndi.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    room = lab == (int(np.argmax(sizes)) + 1)
    return room, lo, cell, {**maps, "ceil": ev}


def density_mask(P: dict, grid_n: int = 250, q_struct=None, q_ceil=None, close_r=None,
                 open_r=None, keep_frac=None, **_):
    """Room = all dense structure. Never cuts the room, but keeps haze and what's seen through
    windows; the fallback for scans with little floor/ceiling."""
    q_struct = MASK["q_struct"] if q_struct is None else q_struct
    q_ceil = MASK["q_ceil"] if q_ceil is None else q_ceil
    close_r = MASK["close_r"] if close_r is None else close_r
    open_r = MASK["open_r"] if open_r is None else open_r
    keep_frac = MASK["keep_frac"] if keep_frac is None else keep_frac
    xyz, z0, z1 = P["xyz"], P["z0"], P["z1"]
    H = z1 - z0
    lo, cell, raster, inside_z = _grid(P, grid_n)

    # structure: everything between floor and ceiling; ceiling layer alone as a second cue
    struct_img = ndi.gaussian_filter(raster(inside_z), 1.0)
    ceil_img = ndi.gaussian_filter(raster(inside_z & (xyz[:, 2] > z1 - 0.12 * H)), 1.0)

    def mask(img, q):
        nz = img[img > 1e-9]
        return img > (np.percentile(nz, q) if len(nz) else np.inf)

    # occupied = dense-enough structure, or ceiling coverage (a ceiling only exists over the room)
    occ = mask(struct_img, q_struct) | mask(ceil_img, q_ceil)
    occ = ndi.binary_opening(occ, _disk(1))                    # drop speckle floaters
    occ = ndi.binary_closing(occ, _disk(close_r))              # bridge gaps between objects
    occ = ndi.binary_fill_holes(occ)
    occ = ndi.binary_opening(occ, _disk(open_r))               # shave thin spurs (window leaks)
    lab, n = ndi.label(occ)
    if n == 0:
        raise RuntimeError("no structure found")
    # keep every substantial piece (a room can be split by a doorway-thin neck), weighted by
    # how much of the scan's mass it holds, then merge them into one outline
    mass = ndi.sum(struct_img, lab, index=np.arange(1, n + 1))
    keep = np.isin(lab, 1 + np.nonzero(mass >= keep_frac * mass.max())[0])
    if keep.sum() and len(np.unique(lab[keep])) > 1:
        keep = ndi.binary_closing(keep, _disk(3 * close_r))
    room = ndi.binary_fill_holes(keep)
    lab, n = ndi.label(room)
    sizes = ndi.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    room = lab == (int(np.argmax(sizes)) + 1)
    return room, lo, cell, {"struct": struct_img, "ceil": ceil_img}


def solve(src=None, props=None, seed: int = 0, n_sample: int = 600_000, simplify: float = 0.01,
          grid_n: int = 250, snap_deg: float = 20.0, debug: dict | None = None,
          prepared: dict | None = None, **mask_kw) -> dict:
    P = prepared if prepared is not None else prepare(src, props, seed=seed, n_sample=n_sample)
    room, lo, cell, maps = room_mask(P, grid_n=grid_n, **mask_kw)
    Rl, z0, z1 = P["R"], P["z0"], P["z1"]
    H = z1 - z0
    struct_img, ceil_img = maps["struct"], maps["ceil"]

    cs, _ = cv2.findContours(room.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    eps = simplify * cv2.arcLength(c, True)
    poly = cv2.approxPolyDP(c, 0.5 * eps, True)[:, 0, :].astype(float)  # (k, 2) in (col, row)
    if len(poly) < 3:
        raise RuntimeError("outline collapsed")
    xy = lo + (poly + 0.5) * cell
    xy = visvalingam(xy, mask_kw.get("min_area", MASK["min_area"]))
    if snap_deg > 0:
        xy = snap_axes(xy, snap_deg, min_edge=3 * cell)
        xy = visvalingam(xy, 0.25 * mask_kw.get("min_area", MASK["min_area"]))
    if np.sum(xy[:, 0] * np.roll(xy[:, 1], -1) - np.roll(xy[:, 0], -1) * xy[:, 1]) < 0:
        xy = xy[::-1]                                              # CCW (SDF sign convention)

    # box frame: levelled, footprint centred on its centroid, floor at z = 0, scale 1
    ctr = xy.mean(0)
    footprint = (xy - ctr).tolist()
    t = np.array([-ctr[0], -ctr[1], -z0])
    s, R = 1.0, Rl
    if debug is not None:
        debug.update(floor_img=ceil_img, wall_img=struct_img, room=room, lo=lo, cell=cell,
                     poly_xy=xy, Rl=Rl, z0=z0, z1=z1, prepared=P)
    return {
        "footprint": footprint, "height": float(H), "s": s, "R": R, "t": t,
        "matrix4_row_major": align.to_matrix4(s, R, t),
        "floor_z_scan": float(z0), "ceiling_z_scan": float(z1), "cell": cell,
        "n_corners": len(footprint),
    }
