"""Cross-language parity: the JS crop formula must equal the Python one.

server/crop.py is what the export runs; web/src/crop-shared.js is what the preview runs. If
they disagree, the tool lies to you -- you feather until it looks right and export something
else. This test is the contract between them.

It runs the real JS through node against the real machine_shop grid (57 walls, non-convex),
which is the worst case in the dataset.
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
import crop, ifc_room, sdf  # noqa: E402

IFC = ROOT.parent / "IFC"


def _node() -> str:
    from shutil import which
    n = which("node")
    if not n:
        pytest.skip("node not available")
    return n


@pytest.fixture(scope="module")
def room_and_grid():
    r = ifc_room.extract(IFC / "machine_shop" / "C1-L0-MEC-02.ifc")
    return r, sdf.bake_cached(r.footprint, ROOT.parent / ".cache" / "machine_shop")


def _run_js(grid, pts, params, tmp_path) -> np.ndarray:
    payload = {
        "grid": {
            "width": int(grid.shape[1]), "height": int(grid.shape[0]),
            "origin": list(grid.origin), "cell": float(grid.cell),
        },
        "points": pts.tolist(),
        "params": {
            "wallOffset": np.asarray(params["wall_offset"], dtype=float).tolist(),
            "wallFeather": np.asarray(params["wall_feather"], dtype=float).tolist(),
            "floorZ": 0.0 + float(params["floor_offset"]),
            "floorFeather": float(params["floor_feather"]),
            "ceilZ": float(params["height"]) - float(params["ceil_offset"]),
            "ceilFeather": float(params["ceil_feather"]),
        },
    }
    (tmp_path / "in.json").write_text(json.dumps(payload))
    grid.dist.astype("<f4").tofile(tmp_path / "dist.bin")
    grid.widx.astype("<f4").tofile(tmp_path / "widx.bin")

    driver = tmp_path / "run.mjs"
    driver.write_text(f"""
import {{ readFileSync, writeFileSync }} from "node:fs";
import {{ cropAlphaJS }} from "{(ROOT / 'web' / 'src' / 'crop-shared.js').as_posix()}";
const inp = JSON.parse(readFileSync("{(tmp_path / 'in.json').as_posix()}", "utf8"));
const rd = (p) => {{
  const b = readFileSync(p);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}};
const grid = {{ ...inp.grid,
  dist: rd("{(tmp_path / 'dist.bin').as_posix()}"),
  widx: rd("{(tmp_path / 'widx.bin').as_posix()}") }};
const out = inp.points.map(([x, y, z]) => cropAlphaJS({{ x, y, z }}, grid, inp.params));
writeFileSync("{(tmp_path / 'out.json').as_posix()}", JSON.stringify(out));
""")
    r = subprocess.run([_node(), str(driver)], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"node failed:\n{r.stderr}")
    return np.array(json.loads((tmp_path / "out.json").read_text()), dtype=np.float64)


def _sample_points(room, n, seed):
    rng = np.random.default_rng(seed)
    fp = np.asarray(room.footprint)
    lo, hi = fp.min(0) - 1.0, fp.max(0) + 1.0
    xy = rng.uniform(lo, hi, size=(n, 2))
    z = rng.uniform(-0.6, room.height + 0.6, size=(n, 1))
    return np.hstack([xy, z])


def _params(room, wall_off=0.0, wall_fth=0.3, **kw):
    n = len(room.walls)
    p = {
        "wall_offset": np.full(n, wall_off, dtype=np.float32),
        "wall_feather": np.full(n, wall_fth, dtype=np.float32),
        "floor_offset": 0.05, "floor_feather": 0.15,
        "ceil_offset": 0.10, "ceil_feather": 0.40,
        "height": room.height,
    }
    p.update(kw)
    return p


# crop.py deliberately computes in float32 -- that is what the export runs, so that is the
# precision that matters -- while JS is float64 throughout. The residual is float32 epsilon
# (~1.2e-7) amplified a little by the smoothstep, so ~1e-5 is the honest bound. Anything
# structural (a sign flip, a wrong wall index, a stale uniform) lands orders of magnitude above.
TOL = 1e-5


def test_js_matches_python_uniform_params(room_and_grid, tmp_path):
    room, grid = room_and_grid
    pts = _sample_points(room, 4000, seed=1)
    p = _params(room)
    want = crop.alpha(pts.astype(np.float32), grid, p).astype(np.float64)
    got = _run_js(grid, pts, p, tmp_path)
    err = np.abs(got - want)
    assert err.max() < TOL, f"max alpha divergence {err.max():.3g}"
    # the sample must actually exercise the interesting range, or this proves nothing
    assert ((want > 0.02) & (want < 0.98)).sum() > 100, "no feathered points in sample"
    assert (want > 0.98).sum() > 100 and (want < 0.02).sum() > 100


def test_js_matches_python_per_wall_params(room_and_grid, tmp_path):
    """Per-wall offsets/feathers are where an index mix-up would show up."""
    room, grid = room_and_grid
    n = len(room.walls)
    rng = np.random.default_rng(7)
    p = _params(room)
    p["wall_offset"] = rng.uniform(-0.4, 0.4, n).astype(np.float32)
    p["wall_feather"] = rng.uniform(0.0, 0.8, n).astype(np.float32)
    pts = _sample_points(room, 4000, seed=2)
    want = crop.alpha(pts.astype(np.float32), grid, p).astype(np.float64)
    got = _run_js(grid, pts, p, tmp_path)
    assert np.abs(got - want).max() < TOL


def test_js_matches_python_hard_cut(room_and_grid, tmp_path):
    """feather=0 must be a hard cut on both sides, not a divide-by-zero."""
    room, grid = room_and_grid
    p = _params(room, wall_fth=0.0, floor_feather=0.0, ceil_feather=0.0)
    pts = _sample_points(room, 3000, seed=3)
    want = crop.alpha(pts.astype(np.float32), grid, p).astype(np.float64)
    got = _run_js(grid, pts, p, tmp_path)
    assert np.abs(got - want).max() == 0.0, "the binary case should agree exactly"
    assert np.isin(np.unique(want), [0.0, 1.0]).all(), "hard cut must be binary"


def test_glsl_and_js_stay_in_step():
    """Cheap staleness guard over the two implementations that sit in one file."""
    src = (ROOT / "web" / "src" / "crop-shared.js").read_text()
    glsl = src.split("export const CROP_GLSL")[1].split("// ---- JS mirror")[0]
    js = src.split("// ---- JS mirror")[1]
    # same smoothstep polynomial
    assert "t * t * (3.0 - 2.0 * t)" in glsl
    assert "t * t * (3 - 2 * t)" in js
    # one definition + three uses (walls, floor, ceiling) on each side
    assert glsl.count("cropFade(") == 4, "GLSL should define cropFade and use it 3x"
    assert js.count("cropFadeJS(") == 4, "JS should define cropFadeJS and use it 3x"
    for side in (glsl, js):
        assert "aWall" in side and "aFloor" in side and "aCeil" in side
