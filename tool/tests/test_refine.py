"""The manual refine nudge composed on top of a solved transform.

The preview applies refine as a THREE matrix on the client; the export recomposes it here. If
these disagree, you nudge the overlay into place and export something else -- so pin the
algebra.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import align  # noqa: E402


def apply(s, R, t, P):
    return s * (np.asarray(P) @ R.T) + t


def test_identity_refine_is_a_noop():
    s, R, t = 0.05, align.euler_xyz(0, 0, 1.1), np.array([1.0, 2, 3])
    s2, R2, t2 = align.compose_refine(s, R, t, None)
    assert (s2, R2.tolist(), t2.tolist()) == (s, R.tolist(), t.tolist())

    s3, R3, t3 = align.compose_refine(s, R, t, {
        "scale": 1.0, "rotation_euler_xyz": [0, 0, 0], "translation": [0, 0, 0]})
    assert abs(s3 - s) < 1e-15
    assert np.allclose(R3, R) and np.allclose(t3, t)


def test_refine_matches_explicit_pivot_formula():
    rng = np.random.default_rng(0)
    P = rng.uniform(-5, 5, size=(20, 3))
    s, R, t = 0.05, align.euler_xyz(0.1, -0.2, 1.1), np.array([1.0, 2, 3])
    pivot = np.array([0.0, 0.0, 1.5])
    refine = {"scale": 1.3, "rotation_euler_xyz": [0.05, 0.0, 0.4], "translation": [0.2, -0.1, 0.05]}

    s2, R2, t2 = align.compose_refine(s, R, t, refine, pivot=pivot)
    got = apply(s2, R2, t2, P)

    # explicit: refine applied to the solved output, about the pivot
    Rr = align.euler_xyz(*refine["rotation_euler_xyz"])
    sr = refine["scale"]
    tr = np.array(refine["translation"])
    mid = apply(s, R, t, P)
    want = pivot + sr * ((mid - pivot) @ Rr.T) + tr
    assert np.allclose(got, want, atol=1e-12)


def test_refine_result_is_still_a_similarity():
    s, R, t = 0.05, align.euler_xyz(0.3, 0.2, 1.1), np.array([1.0, 2, 3])
    s2, R2, t2 = align.compose_refine(
        s, R, t, {"scale": 1.7, "rotation_euler_xyz": [0.2, 0.3, 0.4], "translation": [1, 2, 3]},
        pivot=[0, 0, 1.5])
    assert np.allclose(R2 @ R2.T, np.eye(3), atol=1e-12), "rotation must stay orthonormal"
    assert np.linalg.det(R2) == pytest.approx(1.0, abs=1e-12), "no reflection"
    assert s2 == pytest.approx(0.05 * 1.7, abs=1e-15)


def test_pure_rotation_refine_keeps_the_pivot_fixed():
    """A point at the pivot must not move when you only rotate -- that is the whole point."""
    s, R, t = 1.0, np.eye(3), np.zeros(3)
    pivot = np.array([0.0, 0.0, 1.5])
    s2, R2, t2 = align.compose_refine(
        s, R, t, {"scale": 1.0, "rotation_euler_xyz": [0, 0, 0.9], "translation": [0, 0, 0]},
        pivot=pivot)
    assert np.allclose(apply(s2, R2, t2, [pivot])[0], pivot, atol=1e-12)


def test_translation_refine_is_world_space():
    s, R, t = 2.0, align.euler_xyz(0, 0, 0.7), np.array([1.0, 0, 0])
    dt = np.array([0.3, -0.2, 0.1])
    s2, R2, t2 = align.compose_refine(
        s, R, t, {"scale": 1.0, "rotation_euler_xyz": [0, 0, 0], "translation": dt.tolist()})
    P = np.array([[1.0, 2.0, 3.0]])
    assert np.allclose(apply(s2, R2, t2, P), apply(s, R, t, P) + dt, atol=1e-12)


def test_from_matrix4_inverts_to_matrix4():
    """The custom-box path decomposes a client-authored matrix; it must round-trip."""
    rng = np.random.default_rng(0)
    for _ in range(20):
        s = float(rng.uniform(0.01, 5))
        R = align.euler_xyz(*rng.uniform(-3, 3, 3))
        t = rng.uniform(-50, 50, 3)
        m = align.to_matrix4(s, R, t)
        s2, R2, t2 = align.from_matrix4(m)
        assert abs(s2 - s) < 1e-9
        assert np.allclose(R2, R, atol=1e-9)
        assert np.allclose(t2, t, atol=1e-9)


def test_from_matrix4_pure_rotation_translation():
    """Custom boxes are typically s=1 (a level frame): decompose must give exactly that."""
    R = align.euler_xyz(0.3, -0.5, 1.2)
    t = np.array([2.0, -3.0, 1.5])
    s, R2, t2 = align.from_matrix4(align.to_matrix4(1.0, R, t))
    assert abs(s - 1.0) < 1e-9
    assert np.allclose(R2 @ R2.T, np.eye(3), atol=1e-9)
    assert np.allclose(t2, t, atol=1e-9)


def test_euler_xyz_matches_decompose_roundtrip():
    for ang in [(0.1, 0.2, 0.3), (-1.2, 0.4, 2.0), (0, 0, 0)]:
        R = align.euler_xyz(*ang)
        d = align.decompose(1.0, R, np.zeros(3))
        assert np.allclose(align.euler_xyz(*d["rotation_euler_xyz"]), R, atol=1e-9)
