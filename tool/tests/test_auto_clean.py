"""Hands-off pipeline, end to end on a real (small) SOG: splat in -> auto.ply/.sog/.ifc out.

Checks the contract the rest of the tool relies on: the exported IFC reads back as the detected
room, the sidecar can be reopened in Clean as a custom box, and the crop removed something.
"""

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import auto_clean, ifc_room, ply  # noqa: E402

SAMPLE = Path.home() / "Downloads/splats/july_v2/VID_20260701_123242_00_124_lowq17dB.sog"
pytestmark = pytest.mark.skipif(not SAMPLE.exists() or not shutil.which("npx"),
                                reason="needs the sample SOG + npx")


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out_root = tmp_path_factory.mktemp("out")
    sid = "Test/sample-lowq"
    s_info = {"id": sid, "project": "Test", "scan": "sample-lowq", "sog": str(SAMPLE), "ply": None}
    res = auto_clean.run_one(sid, s_info, write_sog=True, force=True, out_root=out_root)
    return res, out_root / "custom" / "Test__sample-lowq"


def test_outputs_written(run):
    res, d = run
    for f in ("auto.ply", "auto.sog", "auto.ifc", "auto.alignment.json", "auto.preview.png"):
        assert (d / f).exists() and (d / f).stat().st_size > 0, f
    assert 0.2 < res["kept_fraction"] < 1.0
    kept, _ = ply.read(d / "auto.ply")
    assert len(kept) == res["splats_out"]


def test_ifc_reads_back_as_the_detected_room(run):
    _, d = run
    sc = json.loads((d / "auto.alignment.json").read_text())
    fp = sc["reopen"]["custom"]["footprint"]
    r = ifc_room.extract(d / "auto.ifc")
    A, B = Polygon(fp), Polygon(np.asarray(r.footprint) + r.centroid)
    # the slab is the walls' outer ring, so the IFC is the footprint grown by half a wall
    assert A.within(B.buffer(1e-6))
    assert B.area / A.area < 1.25
    assert r.height == pytest.approx(sc["crop"]["height"], rel=1e-3)


def test_sidecar_reopens_as_custom_box(run):
    _, d = run
    sc = json.loads((d / "auto.alignment.json").read_text())
    ro = sc["reopen"]
    assert ro["custom_mode"] and ro["custom"]["footprint"] and ro["custom"]["matrix4_row_major"]
    b = ro["custom"]["basis"]
    R = np.array([b["e1"], b["e2"], b["up"]])
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-6)            # a proper rotation
    assert ro["twin"]["thickness"] > 0 and sc["crop"]["max_scale"] > 0
