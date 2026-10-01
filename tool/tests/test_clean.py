import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import clean, crop, ply, sdf  # noqa: E402


def rot_z(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def square(size=10.0):
    h = size / 2
    return [[-h, -h], [h, -h], [h, h], [-h, h]]


def make_ply(tmp_path, xyz, opacity=None, scale=None, quat=None):
    n = len(xyz)
    d = np.zeros((n, len(ply.GS_PROPS)), dtype=np.float32)
    c = {p: i for i, p in enumerate(ply.GS_PROPS)}
    d[:, [c["x"], c["y"], c["z"]]] = xyz
    d[:, c["opacity"]] = 0.0 if opacity is None else opacity      # sigmoid(0) = 0.5
    d[:, [c["scale_0"], c["scale_1"], c["scale_2"]]] = -3.0 if scale is None else scale
    d[:, [c["rot_0"], c["rot_1"], c["rot_2"], c["rot_3"]]] = (
        [1.0, 0, 0, 0] if quat is None else quat)
    p = tmp_path / "in.ply"
    ply.write(p, d, ply.GS_PROPS)
    return p


@pytest.fixture
def grid():
    return sdf.bake(square(10.0), target_cell=0.02)


def params(**kw):
    p = crop.default_params(height=3.0, n_walls=4)
    p["wall_feather"] = np.zeros(4, dtype=np.float32)  # hard cut by default in tests
    p["floor_feather"] = 0.0
    p["ceil_feather"] = 0.0
    p.update(kw)
    return p


def test_ply_roundtrip(tmp_path):
    xyz = np.array([[0.0, 0, 1], [1, 1, 2]])
    p = make_ply(tmp_path, xyz)
    data, props = ply.read(p)
    assert props == ply.GS_PROPS
    assert len(data) == 2
    assert np.allclose(data[:, :3], xyz)


def test_identity_transform_keeps_inside_drops_outside(tmp_path, grid):
    xyz = np.array([
        [0.0, 0.0, 1.5],    # centre of room -> keep
        [4.9, 4.9, 1.5],    # just inside -> keep
        [5.1, 0.0, 1.5],    # outside a wall -> drop
        [0.0, 0.0, -0.1],   # below floor -> drop
        [0.0, 0.0, 3.1],    # above ceiling -> drop
    ])
    src, props = ply.read(make_ply(tmp_path, xyz))
    kept, n_total, n_kept = clean.transform_and_crop(
        src, props, 1.0, np.eye(3), np.zeros(3), grid, params())
    assert (n_total, n_kept) == (5, 2)
    assert np.allclose(np.sort(kept[:, 0]), [0.0, 4.9], atol=1e-3)


def test_scale_is_additive_in_log_space(tmp_path, grid):
    """The classic trap: scale_* are log-encoded, so a 4x scale is +log(4), not *4."""
    src, props = ply.read(make_ply(tmp_path, np.array([[0.0, 0, 0.375]]), scale=-3.0))
    s = 4.0
    kept, _, n = clean.transform_and_crop(
        src, props, s, np.eye(3), np.zeros(3), grid, params())
    assert n == 1
    c = {p: i for i, p in enumerate(props)}
    assert kept[0, c["scale_0"]] == pytest.approx(-3.0 + np.log(4.0), abs=1e-5)
    # and the centre scaled multiplicatively
    assert kept[0, 2] == pytest.approx(1.5, abs=1e-5)


def test_opacity_fades_in_sigmoid_space(tmp_path, grid):
    """opacity is logit-encoded: a 50% fade must halve sigmoid(opacity), not opacity."""
    # sigmoid(0)=0.5. Put the splat where the wall feather makes alpha ~= 0.5.
    p = params(wall_feather=np.full(4, 2.0, dtype=np.float32))
    # d = -1.0 with feather 2.0 -> t=0.5 -> smoothstep=0.5 -> alpha=0.5
    src, props = ply.read(make_ply(tmp_path, np.array([[4.0, 0.0, 1.5]]), opacity=0.0))
    kept, _, n = clean.transform_and_crop(
        src, props, 1.0, np.eye(3), np.zeros(3), grid, p)
    assert n == 1
    c = {q: i for i, q in enumerate(props)}
    got = clean._sigmoid(kept[0, c["opacity"]].astype(np.float64))
    assert got == pytest.approx(0.5 * 0.5, abs=1e-3), "expected sigmoid-space halving"


def test_quaternion_composes_and_stays_normalised(tmp_path, grid):
    src, props = ply.read(make_ply(
        tmp_path, np.array([[0.0, 0, 1.5]]), quat=[3.0, 0, 0, 0]))  # deliberately unnormalised
    R = rot_z(np.pi / 2)
    kept, _, n = clean.transform_and_crop(
        src, props, 1.0, R, np.zeros(3), grid, params())
    assert n == 1
    c = {p: i for i, p in enumerate(props)}
    q = kept[0, [c["rot_0"], c["rot_1"], c["rot_2"], c["rot_3"]]].astype(np.float64)
    assert np.linalg.norm(q) == pytest.approx(1.0, abs=1e-5), "must renormalise"
    # identity rotation composed with Rz(90) == Rz(90)
    assert np.allclose(np.abs(q), np.abs(clean._mat_to_quat(R)), atol=1e-5)


def test_mat_to_quat_matches_scipy_style_roundtrip():
    for a in (0.0, 0.3, np.pi / 2, 2.9):
        R = rot_z(a)
        q = clean._mat_to_quat(R)
        # rebuild R from q
        w, x, y, z = q
        Rb = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ])
        assert np.allclose(Rb, R, atol=1e-9)


def test_transform_maps_splat_space_into_room(tmp_path, grid):
    """A splat far from origin at odd scale lands inside the room once transformed."""
    s, R, t = 0.05, rot_z(1.1), np.array([2.0, -1.0, 1.0])
    p_splat = np.array([[40.0, -20.0, 5.0]])
    expect = s * (R @ p_splat[0]) + t
    assert abs(expect[0]) < 5 and abs(expect[1]) < 5 and 0 < expect[2] < 3  # sanity: inside
    src, props = ply.read(make_ply(tmp_path, p_splat))
    kept, _, n = clean.transform_and_crop(src, props, s, R, t, grid, params())
    assert n == 1
    assert np.allclose(kept[0, :3], expect, atol=1e-4)


def test_height_override_moves_the_ceiling_cut(tmp_path, grid):
    """A lower `height` must drop the ceiling: a splat at z=2.5 is kept at h=3 but cut at h=2."""
    xyz = np.array([[0.0, 0.0, 2.5]])  # inside walls, high up
    src, props = ply.read(make_ply(tmp_path, xyz))

    tall = clean.transform_and_crop(src, props, 1.0, np.eye(3), np.zeros(3), grid,
                                    params(height=3.0))
    assert tall[2] == 1, "kept under a 3 m ceiling"

    short = clean.transform_and_crop(src, props, 1.0, np.eye(3), np.zeros(3), grid,
                                     params(height=2.0))
    assert short[2] == 0, "cut under a 2 m ceiling"


def test_feather_produces_partial_alpha_not_just_binary(tmp_path, grid):
    xs = np.linspace(0.0, 6.0, 25)
    xyz = np.column_stack([xs, np.zeros(25), np.full(25, 1.5)])
    p = params(wall_feather=np.full(4, 1.5, dtype=np.float32))
    src, props = ply.read(make_ply(tmp_path, xyz, opacity=10.0))  # sigmoid(10) ~ 1
    kept, _, n = clean.transform_and_crop(src, props, 1.0, np.eye(3), np.zeros(3), grid, p)
    c = {q: i for i, q in enumerate(props)}
    a = clean._sigmoid(kept[:, c["opacity"]].astype(np.float64))
    assert ((a > 0.05) & (a < 0.95)).sum() >= 5, "expected a gradient, not a hard edge"
    order = np.argsort(kept[:, 0])
    assert np.all(np.diff(a[order]) <= 1e-6), "alpha must fall monotonically toward the wall"


def test_floater_filter_drops_big_and_faint_splats(tmp_path, grid):
    xyz = np.array([[0.0, 0, 1.5]] * 4)
    #                 normal  huge   faint   both
    scale = np.array([[-3.0] * 3, [0.0, -3, -3], [-3.0] * 3, [0.0, -3, -3]])
    opacity = np.array([2.0, 2.0, -5.0, -5.0])          # sigmoid: 0.88, 0.88, 0.007, 0.007
    p_in = make_ply(tmp_path, xyz, opacity=opacity, scale=scale)
    data, props = ply.read(p_in)
    _, _, n_off = clean.transform_and_crop(data, props, 1.0, np.eye(3), np.zeros(3), grid, params())
    assert n_off == 4                                   # filter off by default
    kept, _, n = clean.transform_and_crop(data, props, 1.0, np.eye(3), np.zeros(3), grid,
                                          params(max_scale=0.5, min_opacity=0.05))
    assert n == 1                                       # only the normal splat survives
    # size is judged in room units: a 0.5x similarity shrinks the huge splat under the limit
    _, _, n_half = clean.transform_and_crop(data, props, 0.4, np.eye(3), np.zeros(3), grid,
                                            params(max_scale=0.5))
    assert n_half == 4
