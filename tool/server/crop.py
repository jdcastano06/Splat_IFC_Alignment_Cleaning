"""The crop/feather formula. Source of truth.

`web/src/crop-dyno.js` reimplements this in GLSL, and `tests/test_parity.py` pins the two
together. If you change the maths here, change it there, and the parity test will tell you if
you got it wrong.

Sign conventions, chosen so every control reads the same way:
  * offset  > 0 shrinks the room (cuts further in);  < 0 grows it.
  * feather = 0 is a hard cut. feather = f fades over f metres *inside* the boundary.
  * alpha 1 = keep, 0 = gone.
"""

from __future__ import annotations

import numpy as np

# Below this the splat contributes nothing visible; 1/255 is the 8-bit quantisation floor.
ALPHA_EPS = 1.0 / 255.0


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    """Hermite smoothstep, matching GLSL's."""
    t = np.clip((x - edge0) / max(edge1 - edge0, 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def fade(dist: np.ndarray, feather: float) -> np.ndarray:
    """1 where dist <= -feather (well inside), 0 where dist >= 0 (outside).

    `dist` is signed outsideness in metres. feather<=0 gives a hard cut at dist=0.
    """
    if feather <= 1e-9:
        return (dist < 0.0).astype(np.float32)
    return (1.0 - smoothstep(-feather, 0.0, dist)).astype(np.float32)


def alpha(points: np.ndarray, grid, params: dict) -> np.ndarray:
    """Per-splat keep-factor in [0,1] for points already in room space.

    params:
      wall_offset  [N] or scalar   wall_feather  [N] or scalar
      floor_offset, floor_feather, ceil_offset, ceil_feather : scalar
      height : room height (ceiling z)
    """
    import sdf  # local import keeps this module importable standalone

    pts = np.asarray(points, dtype=np.float32)
    d, widx = sdf.sample(grid, pts[:, :2].astype(np.float64))

    n_walls = int(grid.widx.max()) + 1
    w_off = np.asarray(params["wall_offset"], dtype=np.float32)
    w_fth = np.asarray(params["wall_feather"], dtype=np.float32)
    if w_off.ndim == 0:
        w_off = np.full(n_walls, float(w_off), dtype=np.float32)
    if w_fth.ndim == 0:
        w_fth = np.full(n_walls, float(w_fth), dtype=np.float32)

    # Per-wall offset applied through the nearest-wall index: an exact polygon offset away
    # from corners, and a graceful approximation at them.
    d_eff = d + w_off[widx]
    per_pt_feather = w_fth[widx]

    # Vectorised fade with a per-point feather (fade() takes a scalar).
    hard = per_pt_feather <= 1e-9
    a_wall = np.empty_like(d_eff)
    a_wall[hard] = (d_eff[hard] < 0.0).astype(np.float32)
    soft = ~hard
    if soft.any():
        t = np.clip((d_eff[soft] + per_pt_feather[soft]) / per_pt_feather[soft], 0.0, 1.0)
        a_wall[soft] = 1.0 - (t * t * (3.0 - 2.0 * t))

    z = pts[:, 2]
    floor_z = 0.0 + float(params.get("floor_offset", 0.0))
    ceil_z = float(params["height"]) - float(params.get("ceil_offset", 0.0))

    a_floor = fade(floor_z - z, float(params.get("floor_feather", 0.0)))
    a_ceil = fade(z - ceil_z, float(params.get("ceil_feather", 0.0)))

    return (a_wall * a_floor * a_ceil).astype(np.float32)


def floater_keep(scale_max: np.ndarray, opacity: np.ndarray, params: dict) -> np.ndarray:
    """Floater filter: 0 for oversized or near-invisible splats, else 1. Hard, per splat.

    scale_max -- largest gaussian std-dev axis in room units; opacity -- linear [0,1].
    params: max_scale (room units, <= 0 = off), min_opacity (<= 0 = off).
    Applied on the splat's own opacity, before the crop fade, in preview and export alike.
    """
    keep = np.ones(np.shape(scale_max), dtype=np.float32)
    ms = float(params.get("max_scale", 0.0) or 0.0)
    mo = float(params.get("min_opacity", 0.0) or 0.0)
    if ms > 0:
        keep *= (np.asarray(scale_max) < ms).astype(np.float32)
    if mo > 0:
        keep *= (np.asarray(opacity) >= mo).astype(np.float32)
    return keep


def default_params(height: float, n_walls: int) -> dict:
    return {
        "wall_offset": np.zeros(n_walls, dtype=np.float32),
        "wall_feather": np.full(n_walls, 0.25, dtype=np.float32),
        "floor_offset": 0.0, "floor_feather": 0.10,
        "ceil_offset": 0.0, "ceil_feather": 0.25,
        "height": float(height),
        "max_scale": 0.0, "min_opacity": 0.0,
    }
