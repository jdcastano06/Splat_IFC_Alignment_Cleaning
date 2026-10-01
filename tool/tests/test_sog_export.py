"""SOG-only scans: export decodes the SOG, and view-dependent SH rotates with the splat."""

import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import clean, crop, ply, sdf  # noqa: E402


def rand_rot(seed):
    q = np.random.default_rng(seed).normal(size=4)
    q /= np.linalg.norm(q)
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def colour(coeffs, d, degree=3):
    """Sum of bands 1..degree toward unit dirs d. coeffs: (15,) in band order."""
    Y = np.concatenate([clean._sh_basis(d, b) for b in range(1, degree + 1)], axis=1)
    return Y @ coeffs


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_sh_rotation_preserves_colour_in_rotated_frame(seed):
    R = rand_rot(seed)
    rng = np.random.default_rng(seed + 10)
    f = rng.normal(size=15)
    T = np.zeros((15, 15))
    o = 0
    for b in (1, 2, 3):
        m = clean.sh_rotation(R, b)
        T[o:o + len(m), o:o + len(m)] = m
        o += len(m)
    d = rng.normal(size=(50, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    # rotated splat seen from R d == original splat seen from d
    assert np.allclose(colour(T @ f, d @ R.T), colour(f, d), atol=1e-6)


def test_sh_rotation_identity():
    for b in (1, 2, 3):
        assert np.allclose(clean.sh_rotation(np.eye(3), b), np.eye(2 * b + 1), atol=1e-9)


def test_transform_rotates_f_rest_channel_major():
    props = ply.GS_PROPS + [f"f_rest_{i}" for i in range(45)]
    c = {p: i for i, p in enumerate(props)}
    d = np.zeros((1, len(props)), dtype=np.float32)
    d[0, [c["rot_0"]]] = 1.0
    d[0, [c["scale_0"], c["scale_1"], c["scale_2"]]] = -3.0
    d[0, c["z"]] = 1.5
    rng = np.random.default_rng(3)
    d[0, c["f_rest_0"]:c["f_rest_44"] + 1] = rng.normal(size=45)
    R = rand_rot(5)
    grid = sdf.bake([[-50, -50], [50, -50], [50, 50], [-50, 50]], target_cell=0.5)
    p = crop.default_params(height=100.0, n_walls=4)
    # put the splat at the room centre after transform
    t = -R @ d[0, :3].astype(np.float64) + np.array([0, 0, 50.0])
    kept, _, n = clean.transform_and_crop(d, props, 1.0, R, t, grid, p)
    assert n == 1
    for ch in range(3):
        cols = [c[f"f_rest_{ch * 15 + j}"] for j in range(15)]
        f_old, f_new = d[0, cols].astype(np.float64), kept[0, cols].astype(np.float64)
        dirs = rng.normal(size=(20, 3))
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        assert np.allclose(colour(f_new, dirs @ R.T), colour(f_old, dirs), atol=1e-4)


SAMPLE = Path.home() / "Downloads/splats/july_v2/VID_20260701_123242_00_124_lowq17dB.sog"


@pytest.mark.skipif(not SAMPLE.exists() or not shutil.which("npx"), reason="needs sample SOG + npx")
def test_sog_decodes_and_exports(tmp_path):
    out_ply = tmp_path / "src.ply"
    clean.sog_to_ply(SAMPLE, out_ply, cwd=tmp_path)
    data, props = ply.read(out_ply)
    assert {"x", "y", "z", "opacity", "rot_0", "f_dc_0"} <= set(props)
    assert len(data) > 1000

    xyz = np.asarray(data[:, [props.index("x"), props.index("y"), props.index("z")]])
    lo, hi = np.percentile(xyz, 5, axis=0), np.percentile(xyz, 95, axis=0)
    ctr = (lo + hi) / 2
    half = (hi - lo)[:2].max() / 4
    grid = sdf.bake([[-half, -half], [half, -half], [half, half], [-half, half]], target_cell=0.05)
    p = crop.default_params(height=float(hi[2] - lo[2]), n_walls=4)
    t = -ctr + np.array([0, 0, (hi[2] - lo[2]) / 2])

    from types import SimpleNamespace
    room = SimpleNamespace(footprint=[[-half, -half], [half, -half], [half, half], [-half, half]],
                           name="t", height=float(hi[2] - lo[2]), centroid=[0, 0])
    res = clean.run(out_ply, room, grid, 1.0, np.eye(3), t, p, tmp_path / "out", write_sog=False)
    assert 0 < res["splats_out"] < res["splats_in"]
    kept, kprops = ply.read(res["ply"])
    assert kprops == props and len(kept) == res["splats_out"]
