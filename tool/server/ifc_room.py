"""Extract room geometry from the IfcOpenShell-authored room IFCs.

These files are deliberately simple: one IfcSpace, a `Floor_*` IfcSlab whose swept area is the
room footprint in absolute site coordinates, and one IfcWall per footprint edge. The wall
extrusion Depth gives the ceiling height.

Everything leaves this module in *room space*: metres, with the footprint centroid at the
origin and z=0 at the floor. Raw IFC coordinates reach 336 m, which costs float precision in a
shader; centring keeps them small.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from pathlib import Path

import ifcopenshell
import ifcopenshell.util.placement as _placement


# IfcSIUnit prefix -> factor to metres. These files use MILLI.
_PREFIX = {
    "EXA": 1e18, "PETA": 1e15, "TERA": 1e12, "GIGA": 1e9, "MEGA": 1e6, "KILO": 1e3,
    "HECTO": 1e2, "DECA": 1e1, None: 1.0, "DECI": 1e-1, "CENTI": 1e-2, "MILLI": 1e-3,
    "MICRO": 1e-6, "NANO": 1e-9, "PICO": 1e-12, "FEMTO": 1e-15, "ATTO": 1e-18,
}


class RoomExtractError(Exception):
    pass


@dataclass
class Room:
    name: str
    footprint: list[list[float]]  # [[x, y], ...] CCW, metres, centroid-relative, unclosed
    walls: list[dict]             # one per footprint edge, index-aligned with edge i -> i+1
    height: float                 # metres, floor (z=0) to ceiling
    centroid: list[float]         # [x, y] metres in original IFC space -- the frame offset
    area: float                   # m^2
    unit_scale: float             # source length unit -> metres

    def to_dict(self) -> dict:
        return asdict(self)


def _unit_scale(f: ifcopenshell.file) -> float:
    for u in f.by_type("IfcUnitAssignment"):
        for unit in u.Units:
            if unit.is_a("IfcSIUnit") and unit.UnitType == "LENGTHUNIT":
                return _PREFIX[unit.Prefix]
    return 1.0


def _rect_corners(slab, item, prof) -> list[tuple[float, float]]:
    """4 world-XY corners of an IfcRectangleProfileDef floor slab, in file units.

    Unlike the polyline branch (whose points are already absolute site coords), a rectangle
    profile stores its corners profile-local and keeps the real position/rotation in the extrude
    solid's Position and the slab's ObjectPlacement. We compose the full chain so the corners come
    out in the same world frame tessellate() renders in -- otherwise the footprint box lands at the
    origin while the real IFC sits metres away and rotated (the smart_lab misalignment).
    """
    import numpy as np

    m_obj = _placement.get_local_placement(slab.ObjectPlacement) if slab.ObjectPlacement else np.eye(4)
    m_ext = _placement.get_axis2placement(item.Position) if item.Position else np.eye(4)
    m_prof = _placement.get_axis2placement(prof.Position) if prof.Position else np.eye(4)
    world = m_obj @ m_ext @ m_prof

    hx, hy = prof.XDim / 2.0, prof.YDim / 2.0
    corners = []
    for lx, ly in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)):
        p = world @ np.array([lx, ly, 0.0, 1.0])
        corners.append((float(p[0]), float(p[1])))
    return corners


def _floor_slab_solid(f: ifcopenshell.file):
    """The (slab, extruded-solid, profile) carrying the room footprint, or None.

    Prefer a `Floor_*`-named slab (the hand-authored convention); otherwise take any slab whose
    extruded profile we can read (a polyline, or a rectangle from a Revit-style export).
    """
    slabs = [s for s in f.by_type("IfcSlab") if (s.Name or "").startswith("Floor_")]
    if not slabs:
        slabs = f.by_type("IfcSlab")
    for slab in slabs:
        if not slab.Representation:
            continue
        for rep in slab.Representation.Representations:
            for item in rep.Items:
                if not item.is_a("IfcExtrudedAreaSolid"):
                    continue
                prof = item.SweptArea
                if prof.is_a("IfcArbitraryClosedProfileDef") and prof.OuterCurve.is_a("IfcPolyline"):
                    return slab, item, prof
                if prof.is_a("IfcRectangleProfileDef"):
                    return slab, item, prof
    return None


def _slab_world_matrix(slab, item, prof):
    """World placement of the slab's swept-area plane (object x extrude x profile), file units."""
    import numpy as np
    m = _placement.get_local_placement(slab.ObjectPlacement) if slab.ObjectPlacement else np.eye(4)
    if getattr(item, "Position", None) is not None:
        m = m @ _placement.get_axis2placement(item.Position)
    if getattr(prof, "Position", None) is not None:
        m = m @ _placement.get_axis2placement(prof.Position)
    return m


def _footprint_points(f: ifcopenshell.file) -> list[tuple[float, float]]:
    """Footprint polygon from the floor slab's swept area, in file units.

    Polyline profiles (hand-authored rooms) already carry absolute XY, so we take them verbatim.
    A rectangle profile (Revit export) stores corners profile-local and its position/rotation in
    placements, so _rect_corners composes the full transform to land in the same world frame.
    """
    found = _floor_slab_solid(f)
    if found is None:
        raise RoomExtractError("no Floor_* IfcSlab with an IfcPolyline or IfcRectangleProfileDef swept area")
    slab, item, prof = found
    if prof.is_a("IfcRectangleProfileDef"):
        return _rect_corners(slab, item, prof)
    return [tuple(p.Coordinates[:2]) for p in prof.OuterCurve.Points]


def _floor_z(f: ifcopenshell.file, unit_scale: float) -> float:
    """World Z of the footprint plane, in metres -- where the room floor sits (walls stand on it).

    Zero for the hand-authored rooms (their floor is authored at z=0), so subtracting it is a no-op
    there; for a Revit export on a lower storey (smart_lab is on B2, ~7.2 m down) it's what pulls
    the tessellated solids up so the floor lands at room-space z=0, matching the footprint box.
    """
    import numpy as np
    found = _floor_slab_solid(f)
    if found is None:
        return 0.0
    m = _slab_world_matrix(*found)
    return float((m @ np.array([0.0, 0.0, 0.0, 1.0]))[2]) * unit_scale


def _height(f: ifcopenshell.file) -> float:
    """Ceiling height = wall extrusion depth. All walls share it in these files."""
    for w in f.by_type("IfcWall"):
        if not w.Representation:
            continue
        for rep in w.Representation.Representations:
            for item in rep.Items:
                if item.is_a("IfcExtrudedAreaSolid"):
                    return float(item.Depth)
    raise RoomExtractError("no IfcWall with an extruded solid to read height from")


def _dedupe_closed(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Drop consecutive duplicates and an explicit closing point.

    machine_shop ships 58 points for 57 walls -- the polyline repeats its first point.
    """
    out: list[tuple[float, float]] = []
    for p in pts:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(p)
    while len(out) > 1 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


def _signed_area(pts: list[tuple[float, float]]) -> float:
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def extract(ifc_path: str | Path) -> Room:
    ifc_path = Path(ifc_path)
    f = ifcopenshell.open(str(ifc_path))

    scale = _unit_scale(f)
    raw = _footprint_points(f)
    height = _height(f) * scale

    # to metres, then drop duplicate/closing points (1 mm tolerance)
    pts = [(x * scale, y * scale) for x, y in raw]
    pts = _dedupe_closed(pts, tol=1e-3)
    if len(pts) < 3:
        raise RoomExtractError(f"footprint has only {len(pts)} distinct points")

    # normalise winding to CCW so the SDF sign convention is stable
    if _signed_area(pts) < 0:
        pts.reverse()

    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    local = [[x - cx, y - cy] for x, y in pts]

    spaces = f.by_type("IfcSpace")
    name = (spaces[0].LongName or spaces[0].Name) if spaces else ifc_path.stem
    return room_from_footprint(local, height, name=str(name), centroid=[cx, cy])


def room_from_footprint(footprint, height, name="custom", centroid=(0.0, 0.0),
                        unit_scale=1.0, rewind=False) -> Room:
    """Build a Room (walls, area) from a footprint polygon + height.

    Shared by the IFC path and the custom-box path. The IFC path pre-winds to CCW and passes the
    footprint as-is (rewind=False); the custom path leaves the user's click order alone so wall
    index i always means "the edge you drew from corner i to corner i+1", which keeps the client
    overlay and the server SDF talking about the same walls.
    """
    pts = [[float(x), float(y)] for x, y in footprint]
    if len(pts) < 3:
        raise RoomExtractError(f"footprint has only {len(pts)} distinct points")
    if rewind and _signed_area(pts) < 0:
        pts.reverse()

    walls = []
    for i, (x1, y1) in enumerate(pts):
        x2, y2 = pts[(i + 1) % len(pts)]
        walls.append({
            "index": i,
            "label": f"Wall {i}",
            "a": [x1, y1],
            "b": [x2, y2],
            "length": math.dist((x1, y1), (x2, y2)),
        })

    return Room(
        name=name,
        footprint=pts,
        walls=walls,
        height=float(height),
        centroid=[float(centroid[0]), float(centroid[1])],
        area=abs(_signed_area(pts)),
        unit_scale=unit_scale,
    )


def tessellate(ifc_path: str | Path, centroid: list[float]) -> tuple[list[float], list[int]]:
    """Triangulate the real IFC solids (walls with thickness, floor slab) into room space.

    This is the actual building geometry, not the footprint prism -- so you can see how thick the
    walls really are and judge how far to offset the crop. Coordinates come out of the geometry
    engine already in metres (world coords); room space is just that minus the footprint centroid.
    """
    import numpy as np
    import ifcopenshell.geom as geom

    f = ifcopenshell.open(str(ifc_path))
    settings = geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    cx, cy = centroid
    cz = _floor_z(f, _unit_scale(f))  # 0 for authored rooms; the storey offset for Revit exports
    vparts: list[np.ndarray] = []
    fparts: list[np.ndarray] = []
    base = 0
    for p in f.by_type("IfcProduct"):
        if not p.Representation or p.is_a("IfcSpace") or p.is_a("IfcAnnotation"):
            continue
        try:
            shape = geom.create_shape(settings, p)
        except RuntimeError:
            continue  # a product we can't tessellate is not worth failing the whole room over
        v = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
        idx = np.asarray(shape.geometry.faces, dtype=np.int64)
        v[:, 0] -= cx
        v[:, 1] -= cy
        v[:, 2] -= cz
        vparts.append(v.astype(np.float32))
        fparts.append(idx + base)
        base += len(v)

    V = np.concatenate(vparts) if vparts else np.zeros((0, 3), np.float32)
    F = np.concatenate(fparts) if fparts else np.zeros((0,), np.int64)
    return V.reshape(-1).tolist(), F.tolist()


if __name__ == "__main__":
    import sys, json
    r = extract(sys.argv[1])
    print(json.dumps(r.to_dict(), indent=1)[:600])
    print(f"\n{r.name}: {len(r.footprint)} pts, {r.area:.2f} m2, h={r.height:.2f} m")
