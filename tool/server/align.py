"""Similarity alignment (scale + rotation + translation) from >=3 point pairs.

Reference implementation. `web/src/align.js` mirrors it; `tests/test_align.py` pins both.

Solves for s, R, t minimising  sum || s*R*p_i + t - q_i ||^2
where p = clicked splat points, q = clicked IFC/room points.
"""

from __future__ import annotations

import numpy as np


class DegenerateError(Exception):
    """Point configuration cannot determine a unique transform."""


def umeyama(P: np.ndarray, Q: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Full 3D similarity. Umeyama (1991), with the reflection guard.

    Raises DegenerateError on collinear/coincident input rather than returning a plausible-
    looking but arbitrary rotation.
    """
    P = np.asarray(P, dtype=np.float64)
    Q = np.asarray(Q, dtype=np.float64)
    if P.shape != Q.shape or P.shape[0] < 3 or P.shape[1] != 3:
        raise ValueError(f"need matching (N>=3, 3) arrays, got {P.shape} and {Q.shape}")

    n = P.shape[0]
    mp, mq = P.mean(0), Q.mean(0)
    X, Y = P - mp, Q - mq

    var_x = (X ** 2).sum() / n
    if var_x < 1e-12:
        raise DegenerateError("source points are coincident")

    # Rank of the centred source tells us whether the points span 3D. Rank 2 (planar) still
    # yields a unique similarity; rank <2 (collinear) does not.
    if np.linalg.matrix_rank(X, tol=1e-8) < 2:
        raise DegenerateError("source points are collinear -- rotation is not determined")
    if np.linalg.matrix_rank(Y, tol=1e-8) < 2:
        raise DegenerateError("target points are collinear -- rotation is not determined")

    S = Y.T @ X / n
    U, D, Vt = np.linalg.svd(S)

    # Guard against a reflection sneaking in as a "rotation".
    corr = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        corr[2, 2] = -1.0

    R = U @ corr @ Vt
    s = float(np.trace(np.diag(D) @ corr) / var_x)
    t = mq - s * R @ mp
    return s, R, t


def umeyama_yaw(P: np.ndarray, Q: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Similarity constrained to a Z-up frame: uniform scale, yaw only, free translation.

    Both the scans and the IFC are gravity-aligned, so this is usually the better solver -- it
    cannot tilt the room to chase a misclick.
    """
    P = np.asarray(P, dtype=np.float64)
    Q = np.asarray(Q, dtype=np.float64)
    if P.shape != Q.shape or P.shape[0] < 2 or P.shape[1] != 3:
        raise ValueError(f"need matching (N>=2, 3) arrays, got {P.shape} and {Q.shape}")

    mp, mq = P.mean(0), Q.mean(0)
    X, Y = (P - mp)[:, :2], (Q - mq)[:, :2]

    var_x = (X ** 2).sum()
    if var_x < 1e-12:
        raise DegenerateError("source points are coincident in XY")

    # Closed-form 2D similarity: the complex-number/Procrustes solution.
    a = float((X[:, 0] * Y[:, 0] + X[:, 1] * Y[:, 1]).sum())
    b = float((X[:, 0] * Y[:, 1] - X[:, 1] * Y[:, 0]).sum())
    if abs(a) < 1e-12 and abs(b) < 1e-12:
        raise DegenerateError("yaw is not determined by these points")

    theta = np.arctan2(b, a)
    s = float(np.hypot(a, b) / var_x)

    c, sn = np.cos(theta), np.sin(theta)
    R = np.array([[c, -sn, 0.0], [sn, c, 0.0], [0.0, 0.0, 1.0]])
    t = mq - s * R @ mp
    return s, R, t


def solve(P, Q, yaw_only: bool = False):
    return (umeyama_yaw if yaw_only else umeyama)(P, Q)


def residuals(P, Q, s: float, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Per-pair distance between the transformed source and its target, in metres."""
    P = np.asarray(P, dtype=np.float64)
    Q = np.asarray(Q, dtype=np.float64)
    return np.linalg.norm((s * (R @ P.T).T + t) - Q, axis=1)


def rms(P, Q, s, R, t) -> float:
    r = residuals(P, Q, s, R, t)
    return float(np.sqrt((r ** 2).mean()))


def euler_xyz(rx: float, ry: float, rz: float) -> np.ndarray:
    """Rotation from XYZ Euler angles (radians), applied Rz @ Ry @ Rx -- matches decompose()."""
    cx, sx = np.cos(rx), np.sin(rx)
    cy, sy = np.cos(ry), np.sin(ry)
    cz, sz = np.cos(rz), np.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def compose_refine(s, R, t, refine: dict | None, pivot=(0.0, 0.0, 0.0)):
    """Apply a manual nudge on top of a solved transform, about `pivot` in room space.

    Point pairs get you close; eyeballing the overlay gets you the last centimetre. The refine
    is itself a similarity, so the composition stays a similarity and the export still needs
    only (s, R, t) -- no second code path.

        refined(p) = pivot + s_r*R_r*(solved(p) - pivot) + t_r

    Rotating about the room centre (rather than the origin) is what makes the sliders feel like
    they nudge the model instead of swinging it away.
    """
    if not refine:
        return s, R, t
    sr = float(refine.get("scale", 1.0) or 1.0)
    rx, ry, rz = refine.get("rotation_euler_xyz", (0.0, 0.0, 0.0))
    tr = np.asarray(refine.get("translation", (0.0, 0.0, 0.0)), dtype=np.float64)
    Rr = euler_xyz(float(rx), float(ry), float(rz))
    pv = np.asarray(pivot, dtype=np.float64)

    s2 = sr * s
    R2 = Rr @ R
    t2 = pv + sr * (Rr @ (t - pv)) + tr
    return s2, R2, t2


def to_matrix4(s: float, R: np.ndarray, t: np.ndarray) -> list[float]:
    """Row-major 4x4 for JSON. THREE.Matrix4.fromArray wants column-major -- transpose there."""
    M = np.eye(4)
    M[:3, :3] = s * R
    M[:3, 3] = t
    return M.reshape(-1).tolist()


def from_matrix4(m16) -> tuple[float, np.ndarray, np.ndarray]:
    """Inverse of to_matrix4: a row-major similarity 4x4 -> (s, R, t).

    Used for the custom-box path, where the client authors the transform directly (plane fit on
    clicked points) and sends the matrix rather than point pairs. Columns of the 3x3 block are
    s * (orthonormal columns), so their length gives s and dividing removes it.
    """
    M = np.asarray(m16, dtype=np.float64).reshape(4, 4)
    A = M[:3, :3]
    t = M[:3, 3].copy()
    scales = np.linalg.norm(A, axis=0)
    s = float(scales.mean())
    if s < 1e-12:
        raise DegenerateError("matrix has zero scale")
    R = A / s
    # Re-orthonormalise defensively (float drift), keeping a proper rotation.
    U, _, Vt = np.linalg.svd(R)
    R = U @ Vt
    if np.linalg.det(R) < 0:
        U[:, -1] *= -1
        R = U @ Vt
    return s, R, t


def decompose(s: float, R: np.ndarray, t: np.ndarray) -> dict:
    """Scale / Euler XYZ (radians) / translation, for the sidecar."""
    sy = float(np.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2))
    if sy > 1e-8:
        rx = float(np.arctan2(R[2, 1], R[2, 2]))
        ry = float(np.arctan2(-R[2, 0], sy))
        rz = float(np.arctan2(R[1, 0], R[0, 0]))
    else:  # gimbal lock
        rx = float(np.arctan2(-R[1, 2], R[1, 1]))
        ry = float(np.arctan2(-R[2, 0], sy))
        rz = 0.0
    return {
        "scale": float(s),
        "rotation_euler_xyz": [rx, ry, rz],
        "translation": [float(v) for v in t],
    }
