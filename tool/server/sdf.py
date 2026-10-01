"""Bake a room footprint into a 2D signed-distance grid + nearest-wall-index grid.

This is the heart of the cleaning tool. Baking distance *and* nearest-wall-index once means a
per-wall offset is just `d + offset[wall_index]` and feathering is just `feather[wall_index]` --
so dragging a slider changes only shader uniforms. Nothing re-bakes, nothing re-uploads.

It also handles arbitrary non-convex footprints (machine_shop is a 57-gon) exactly, which a
union of analytic box/plane SDFs cannot.

Two grids rather than one because the index must be sampled NEAREST -- linearly interpolating a
wall *index* is meaningless -- while distance wants LINEAR. The GPU filter mode is per-texture,
so they cannot share one.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Polygon

# Grid is sized by target cell size, capped so the biggest room stays sane on the GPU.
TARGET_CELL = 0.01   # metres
MAX_DIM = 2048       # texels
MARGIN = 1.0         # metres of slack outside the footprint bbox


@dataclass
class SdfGrid:
    dist: np.ndarray   # (H, W) float32, metres, negative inside
    widx: np.ndarray   # (H, W) int32, index of nearest wall segment
    origin: tuple[float, float]  # world (x, y) of texel centre [0, 0]
    cell: float                  # metres per texel

    @property
    def shape(self) -> tuple[int, int]:
        return self.dist.shape

    def meta(self) -> dict:
        h, w = self.dist.shape
        return {
            "width": int(w), "height": int(h),
            "origin": [float(self.origin[0]), float(self.origin[1])],
            "cell": float(self.cell),
        }


def _seg_distance(pts: np.ndarray, a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Unsigned distance from each point to the nearest segment, and that segment's index.

    pts (M,2), a/b (N,2) -> (M,) distance, (M,) index. Chunked by the caller.
    """
    ab = b - a                                     # (N,2)
    ap = pts[:, None, :] - a[None, :, :]           # (M,N,2)
    denom = np.einsum("ij,ij->i", ab, ab)          # (N,)
    denom = np.where(denom < 1e-20, 1e-20, denom)
    t = np.einsum("mnj,nj->mn", ap, ab) / denom    # (M,N)
    np.clip(t, 0.0, 1.0, out=t)
    closest = a[None, :, :] + t[..., None] * ab[None, :, :]   # (M,N,2)
    d = np.linalg.norm(pts[:, None, :] - closest, axis=-1)    # (M,N)
    idx = np.argmin(d, axis=1)
    return d[np.arange(len(pts)), idx], idx.astype(np.int32)


def bake(footprint: list[list[float]], target_cell: float = TARGET_CELL,
         max_dim: int = MAX_DIM, margin: float = MARGIN) -> SdfGrid:
    poly_pts = np.asarray(footprint, dtype=np.float64)
    a = poly_pts
    b = np.roll(poly_pts, -1, axis=0)

    x0, y0 = poly_pts.min(axis=0) - margin
    x1, y1 = poly_pts.max(axis=0) + margin
    span = max(x1 - x0, y1 - y0)
    cell = max(target_cell, span / max_dim)

    w = int(np.ceil((x1 - x0) / cell)) + 1
    h = int(np.ceil((y1 - y0) / cell)) + 1

    gx = x0 + np.arange(w) * cell
    gy = y0 + np.arange(h) * cell
    mx, my = np.meshgrid(gx, gy)
    pts = np.stack([mx.ravel(), my.ravel()], axis=1)

    # Chunked so peak memory stays ~tens of MB: machine_shop is 1.8M cells x 57 segments.
    dist = np.empty(len(pts), dtype=np.float32)
    widx = np.empty(len(pts), dtype=np.int32)
    step = max(1, int(2_000_000 / max(len(a), 1)))
    for s in range(0, len(pts), step):
        e = min(s + step, len(pts))
        d, i = _seg_distance(pts[s:e], a, b)
        dist[s:e] = d
        widx[s:e] = i

    # Sign via shapely's vectorised containment -- mature and correct, including concavities.
    inside = shapely.contains_xy(Polygon(poly_pts), pts[:, 0], pts[:, 1])
    dist[inside] *= -1.0

    return SdfGrid(dist.reshape(h, w), widx.reshape(h, w), (float(x0), float(y0)), float(cell))


def sample(grid: SdfGrid, xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear distance + nearest-neighbour wall index. Mirrors the GLSL sampler exactly.

    Points outside the grid clamp to the edge; the margin plus a positive edge distance means
    they read as 'far outside', which is what we want.
    """
    h, w = grid.shape
    fx = (xy[:, 0] - grid.origin[0]) / grid.cell
    fy = (xy[:, 1] - grid.origin[1]) / grid.cell

    # nearest for the index
    ix = np.clip(np.rint(fx).astype(np.int64), 0, w - 1)
    iy = np.clip(np.rint(fy).astype(np.int64), 0, h - 1)
    widx = grid.widx[iy, ix]

    # bilinear for the distance
    x0 = np.clip(np.floor(fx).astype(np.int64), 0, w - 1)
    y0 = np.clip(np.floor(fy).astype(np.int64), 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    tx = np.clip(fx - x0, 0.0, 1.0)
    ty = np.clip(fy - y0, 0.0, 1.0)

    d00 = grid.dist[y0, x0]; d10 = grid.dist[y0, x1]
    d01 = grid.dist[y1, x0]; d11 = grid.dist[y1, x1]
    dist = (d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty
    return dist.astype(np.float32), widx


def cache_key(footprint: list[list[float]], target_cell: float, max_dim: int, margin: float) -> str:
    payload = json.dumps(
        {"f": np.round(np.asarray(footprint), 6).tolist(), "c": target_cell,
         "m": max_dim, "g": margin},
        sort_keys=True,
    )
    return hashlib.sha1(payload.encode()).hexdigest()[:16]


def bake_cached(footprint: list[list[float]], cache_dir: Path, **kw) -> SdfGrid:
    target_cell = kw.get("target_cell", TARGET_CELL)
    max_dim = kw.get("max_dim", MAX_DIM)
    margin = kw.get("margin", MARGIN)
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"sdf_{cache_key(footprint, target_cell, max_dim, margin)}.npz"
    if path.exists():
        z = np.load(path)
        return SdfGrid(z["dist"], z["widx"], (float(z["origin"][0]), float(z["origin"][1])),
                       float(z["cell"]))
    g = bake(footprint, target_cell, max_dim, margin)
    np.savez_compressed(path, dist=g.dist, widx=g.widx,
                        origin=np.array(g.origin), cell=np.array(g.cell))
    return g
