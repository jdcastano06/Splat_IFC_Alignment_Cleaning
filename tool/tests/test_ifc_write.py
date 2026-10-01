"""The generated room IFC must round-trip: what we author, our own reader/tessellator must read
back as the same box. This is what lets the exported IFC overlay the cleaned splat."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import ifc_room  # noqa: E402
import ifc_write  # noqa: E402


def _bbox_z(path):
    v, _ = ifc_room.tessellate(path, [0.0, 0.0])
    V = np.asarray(v).reshape(-1, 3)
    return V[:, 2].min(), V[:, 2].max(), V


def test_rectangle_roundtrips(tmp_path):
    fp = [[-1.5, -1.0], [1.5, -1.0], [1.5, 1.0], [-1.5, 1.0]]
    out = tmp_path / "r.ifc"
    ifc_write.build_room_ifc(fp, 2.5, out, name="Rect")

    r = ifc_room.extract(out)
    assert len(r.footprint) == 4
    assert r.height == pytest.approx(2.5, abs=1e-4)
    assert r.area == pytest.approx(6.0, abs=1e-3)

    zmin, zmax, _ = _bbox_z(out)
    assert zmin == pytest.approx(-0.1, abs=1e-3)   # floor slab thickness below z=0
    assert zmax == pytest.approx(2.5, abs=1e-3)     # walls/space reach the ceiling


def test_nonconvex_footprint_roundtrips(tmp_path):
    """An L-shaped room (like the real 57-gon machine_shop) must survive authoring."""
    fp = [[-2, -1], [2, -1], [2, 1], [0.5, 1], [0.5, 2.5], [-2, 2.5]]
    out = tmp_path / "l.ifc"
    ifc_write.build_room_ifc(fp, 3.0, out, name="L")
    r = ifc_room.extract(out)
    assert len(r.footprint) == 6
    assert r.height == pytest.approx(3.0, abs=1e-4)


def test_height_is_honoured(tmp_path):
    fp = [[0, 0], [2, 0], [2, 2], [0, 2]]
    for h in (1.8, 2.4, 4.2):
        out = tmp_path / f"h{h}.ifc"
        ifc_write.build_room_ifc(fp, h, out)
        _, zmax, _ = _bbox_z(out)
        assert zmax == pytest.approx(h, abs=1e-3)


def test_walls_have_thickness(tmp_path):
    """Walls extend beyond the interior footprint by half the thickness -- that's the point of
    saving solids rather than a bare prism."""
    fp = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    out = tmp_path / "t.ifc"
    ifc_write.build_room_ifc(fp, 2.0, out, wall_thickness=0.2)
    _, _, V = _bbox_z(out)
    # footprint is +-1; walls centred on edges reach +-1.1
    assert V[:, 0].max() == pytest.approx(1.1, abs=1e-3)
    assert V[:, 0].min() == pytest.approx(-1.1, abs=1e-3)


def test_degenerate_footprint_rejected(tmp_path):
    with pytest.raises(ValueError):
        ifc_write.build_room_ifc([[0, 0], [1, 1]], 2.0, tmp_path / "bad.ifc")
