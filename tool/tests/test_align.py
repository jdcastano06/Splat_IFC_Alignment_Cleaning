import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import align  # noqa: E402


def rot(rx, ry, rz):
    cx, sx = np.cos(rx), np.sin(rx)
    cy, sy = np.cos(ry), np.sin(ry)
    cz, sz = np.cos(rz), np.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def test_roundtrip_recovers_known_transform():
    rng = np.random.default_rng(42)
    P = rng.uniform(-50, 50, size=(8, 3))
    s_true, R_true, t_true = 0.0413, rot(0.3, -0.7, 1.9), np.array([12.4, -3.1, 0.8])
    Q = s_true * (R_true @ P.T).T + t_true

    s, R, t = align.umeyama(P, Q)
    assert abs(s - s_true) < 1e-10
    assert np.allclose(R, R_true, atol=1e-10)
    assert np.allclose(t, t_true, atol=1e-9)
    assert align.rms(P, Q, s, R, t) < 1e-9


def test_minimal_three_points_exact():
    """3 non-collinear points fully determine a similarity."""
    P = np.array([[0.0, 0, 0], [1, 0, 0], [0, 1, 0]])
    s_true, R_true, t_true = 2.5, rot(0.0, 0.0, 0.4), np.array([5.0, -2.0, 1.0])
    Q = s_true * (R_true @ P.T).T + t_true
    s, R, t = align.umeyama(P, Q)
    assert abs(s - s_true) < 1e-9
    assert np.allclose(R, R_true, atol=1e-9)


def test_no_reflection_for_mirrored_input():
    """A mirrored target must not be fitted with a reflection masquerading as a rotation."""
    rng = np.random.default_rng(1)
    P = rng.uniform(-10, 10, size=(6, 3))
    Q = P.copy()
    Q[:, 0] *= -1  # mirror
    s, R, t = align.umeyama(P, Q)
    assert np.linalg.det(R) > 0, "solver returned a reflection"


def test_collinear_is_rejected():
    P = np.array([[0.0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])
    Q = P * 2.0 + 1.0
    with pytest.raises(align.DegenerateError):
        align.umeyama(P, Q)


def test_coincident_is_rejected():
    P = np.ones((4, 3))
    Q = np.zeros((4, 3))
    with pytest.raises(align.DegenerateError):
        align.umeyama(P, Q)


def test_planar_points_are_accepted():
    """Rank-2 (all clicks on one wall/floor) still determines a unique similarity."""
    rng = np.random.default_rng(7)
    P = np.column_stack([rng.uniform(-5, 5, 6), rng.uniform(-5, 5, 6), np.zeros(6)])
    s_true, R_true, t_true = 1.7, rot(0.2, 0.1, 0.9), np.array([1.0, 2.0, 3.0])
    Q = s_true * (R_true @ P.T).T + t_true
    s, R, t = align.umeyama(P, Q)
    assert align.rms(P, Q, s, R, t) < 1e-9


def test_yaw_only_recovers_yaw_transform():
    rng = np.random.default_rng(3)
    P = rng.uniform(-30, 30, size=(5, 3))
    s_true, R_true, t_true = 0.05, rot(0, 0, 2.61), np.array([12.4, -3.1, 0.8])
    Q = s_true * (R_true @ P.T).T + t_true
    s, R, t = align.umeyama_yaw(P, Q)
    assert abs(s - s_true) < 1e-10
    assert np.allclose(R, R_true, atol=1e-10)
    assert np.allclose(t, t_true, atol=1e-9)


def test_yaw_only_ignores_tilt_instead_of_chasing_it():
    """Given a tilted target, yaw-only must stay level (that is the point of the mode)."""
    rng = np.random.default_rng(5)
    P = rng.uniform(-30, 30, size=(6, 3))
    Q = 1.0 * (rot(0.25, 0.0, 0.5) @ P.T).T  # genuine tilt in the data
    s, R, t = align.umeyama_yaw(P, Q)
    assert abs(R[2, 2] - 1.0) < 1e-12 and abs(R[2, 0]) < 1e-12 and abs(R[2, 1]) < 1e-12
    assert align.rms(P, Q, s, R, t) > 1.0, "should NOT fit the tilt"
    # ...while the unconstrained solver does fit it
    s2, R2, t2 = align.umeyama(P, Q)
    assert align.rms(P, Q, s2, R2, t2) < 1e-9


def test_residuals_localise_a_misclick():
    rng = np.random.default_rng(11)
    P = rng.uniform(-20, 20, size=(6, 3))
    Q = 2.0 * (rot(0, 0, 0.3) @ P.T).T + np.array([1.0, 1.0, 1.0])
    Q[3] += np.array([5.0, 0, 0])  # one bad pair
    s, R, t = align.umeyama(P, Q)
    r = align.residuals(P, Q, s, R, t)
    assert int(np.argmax(r)) == 3, "worst residual should point at the bad pair"


def test_matrix4_roundtrip():
    rng = np.random.default_rng(13)
    P = rng.uniform(-10, 10, size=(5, 3))
    s, R, t = 3.0, rot(0.1, 0.2, 0.3), np.array([1.0, 2.0, 3.0])
    M = np.array(align.to_matrix4(s, R, t)).reshape(4, 4)
    got = (M @ np.column_stack([P, np.ones(len(P))]).T).T[:, :3]
    want = s * (R @ P.T).T + t
    assert np.allclose(got, want, atol=1e-12)


def test_decompose_matches_input_scale():
    s, R, t = 0.0413, rot(0.3, -0.7, 1.9), np.array([12.4, -3.1, 0.8])
    d = align.decompose(s, R, t)
    assert abs(d["scale"] - s) < 1e-12
    assert np.allclose(d["translation"], t)
    rx, ry, rz = d["rotation_euler_xyz"]
    assert np.allclose(rot(rx, ry, rz), R, atol=1e-9)
