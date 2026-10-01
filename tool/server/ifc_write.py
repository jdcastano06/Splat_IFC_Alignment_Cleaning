"""Author a room IFC from a footprint + height, in the cleaned splat's frame.

The cleaned PLY/SOG are exported in *room space* (metres, footprint centroid at the origin, floor
at z=0). When the room came from a real IFC we still have that file, but it lives in absolute site
coordinates (millimetres) and no longer matches a custom box or a height the user overrode. So on
every export we also write a room-space IFC of the box that was actually used -- walls and a floor
slab (plus a non-geometric IfcSpace for metadata) -- so it overlays the cleaned splat one-to-one.

Geometry mirrors the source room IFCs (extruded arbitrary profiles) so the same viewers and our own
tessellate() read it back identically.
"""

from __future__ import annotations

import math
from pathlib import Path

import ifcopenshell
import ifcopenshell.guid as guid


def _placement(f, x=0.0, y=0.0, z=0.0, ref=None):
    loc = f.create_entity("IfcCartesianPoint", Coordinates=(float(x), float(y), float(z)))
    zdir = f.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
    kw = {"Location": loc, "Axis": zdir}
    if ref is not None:
        kw["RefDirection"] = f.create_entity("IfcDirection",
                                             DirectionRatios=(float(ref[0]), float(ref[1]), 0.0))
    return f.create_entity("IfcAxis2Placement3D", **kw)


def _profile(f, pts2d, name=None):
    cps = [f.create_entity("IfcCartesianPoint", Coordinates=(float(x), float(y))) for x, y in pts2d]
    cps.append(cps[0])  # explicitly closed, like the source files
    poly = f.create_entity("IfcPolyline", Points=cps)
    return f.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA",
                           ProfileName=name, OuterCurve=poly)


def _extruded(f, prof, position, direction, depth):
    d = f.create_entity("IfcDirection", DirectionRatios=tuple(float(v) for v in direction))
    return f.create_entity("IfcExtrudedAreaSolid", SweptArea=prof, Position=position,
                           ExtrudedDirection=d, Depth=float(depth))


def _rgb(c):
    """Normalise a colour to an (r, g, b) tuple in 0..1. Accepts '#rrggbb' or an rgb triple, so the
    twin-preview hex the user picked can be passed straight through."""
    if isinstance(c, str):
        h = c.lstrip("#")
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return tuple(float(v) for v in c)


def _surface_style(f, name, rgb, transparency=0.0):
    """A reusable IfcSurfaceStyle (RGB in 0..1). One per colour, shared across items."""
    rgb = _rgb(rgb)
    col = f.create_entity("IfcColourRgb", Red=float(rgb[0]), Green=float(rgb[1]), Blue=float(rgb[2]))
    shading = f.create_entity("IfcSurfaceStyleShading",
                              SurfaceColour=col, Transparency=float(transparency))
    return f.create_entity("IfcSurfaceStyle", Name=name, Side="BOTH", Styles=[shading])


def _apply_style(f, item, style):
    """Colour a geometric representation item. Without this the box renders default-white in every
    viewer -- the swept solids carry no colour on their own. We mirror the source room IFCs
    (IfcStyledItem -> IfcPresentationStyleAssignment -> IfcSurfaceStyle) for the widest support."""
    psa = f.create_entity("IfcPresentationStyleAssignment", Styles=[style])
    f.create_entity("IfcStyledItem", Item=item, Styles=[psa])


def _signed_area(fp):
    a = 0.0
    for i in range(len(fp)):
        x1, y1 = fp[i]
        x2, y2 = fp[(i + 1) % len(fp)]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def _offset_ring(fp, d):
    """Ring offset outward by `d` (negative = inward) with mitred corners. A direct port of
    twin.js `offsetRing`, so the exported walls sit exactly where the Twin preview drew them."""
    n = len(fp)
    sign = 1.0 if _signed_area(fp) >= 0 else -1.0  # custom boxes keep click winding; IFC is CCW
    nrm = []
    for i in range(n):
        x1, y1 = fp[i]
        x2, y2 = fp[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1.0
        nrm.append((sign * dy / L, -sign * dx / L))  # outward for this winding
    out = []
    for i in range(n):
        ax, ay = nrm[(i - 1) % n]
        bx, by = nrm[i]
        mx, my = ax + bx, ay + by
        ml = math.hypot(mx, my)
        if ml < 1e-6:
            out.append((fp[i][0] + bx * d, fp[i][1] + by * d))
            continue
        mx /= ml
        my /= ml
        cos = max(mx * bx + my * by, 0.2)  # cap the miter at 5x thickness
        out.append((fp[i][0] + mx * d / cos, fp[i][1] + my * d / cos))
    return out


def _band_offsets(thickness, anchor, offset):
    """[inner, outer] outward offsets of the wall band from the footprint line. Mirrors twin.js
    `bandOffsets`: anchor picks the side, `offset` shifts the whole band (+ is outward)."""
    t = max(thickness, 1e-4)
    if anchor == "inside":
        base = (-t, 0.0)
    elif anchor == "outside":
        base = (0.0, t)
    else:  # centre
        base = (-t / 2.0, t / 2.0)
    return (base[0] + offset, base[1] + offset)


def build_room_ifc(footprint, height, out_path: str | Path, name: str = "Room",
                   wall_thickness: float = 0.1, floor_thickness: float = 0.1,
                   wall_color=(0.80, 0.80, 0.82), floor_color=(0.55, 0.57, 0.60),
                   wall_anchor: str = "center", wall_offset: float = 0.0) -> str:
    """Write an IFC4 room box (metres, floor at z=0) and return the path.

    footprint: [[x, y], ...] in metres, centroid-relative -- exactly what the crop/SDF use.
    wall_color / floor_color: '#rrggbb' or an rgb triple (0..1) -- the Twin-preview colours the user
    picked. Without these the export is colourless and every viewer draws it white; the fallbacks are
    a light grey wall over a darker grey floor, so the box still reads at a glance.
    """
    wall_color = wall_color if wall_color is not None else (0.80, 0.80, 0.82)
    floor_color = floor_color if floor_color is not None else (0.55, 0.57, 0.60)
    wall_anchor = wall_anchor if wall_anchor else "center"
    wall_offset = float(wall_offset) if wall_offset is not None else 0.0
    footprint = [[float(x), float(y)] for x, y in footprint]
    if len(footprint) < 3:
        raise ValueError("footprint needs at least 3 points")
    height = float(height)
    out_path = Path(out_path)

    f = ifcopenshell.file(schema="IFC4")

    # --- units + representation context (metres) ---
    unit = f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    area_u = f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE")
    vol_u = f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE")
    units = f.create_entity("IfcUnitAssignment", Units=[unit, area_u, vol_u])

    wcs = _placement(f, ref=(1.0, 0.0))
    ctx = f.create_entity("IfcGeometricRepresentationContext", ContextType="Model",
                          CoordinateSpaceDimension=3, Precision=1e-5, WorldCoordinateSystem=wcs)
    body = f.create_entity("IfcGeometricRepresentationSubContext", ContextIdentifier="Body",
                           ContextType="Model", ParentContext=ctx, TargetView="MODEL_VIEW")

    # --- spatial structure: project -> site -> building -> storey ---
    project = f.create_entity("IfcProject", GlobalId=guid.new(), Name=name,
                              UnitsInContext=units, RepresentationContexts=[ctx])
    site = f.create_entity("IfcSite", GlobalId=guid.new(), Name="Site",
                           ObjectPlacement=f.create_entity("IfcLocalPlacement", RelativePlacement=wcs))
    building = f.create_entity("IfcBuilding", GlobalId=guid.new(), Name="Building",
                               ObjectPlacement=f.create_entity("IfcLocalPlacement",
                                                               PlacementRelTo=site.ObjectPlacement,
                                                               RelativePlacement=wcs))
    storey = f.create_entity("IfcBuildingStorey", GlobalId=guid.new(), Name="Storey",
                             ObjectPlacement=f.create_entity("IfcLocalPlacement",
                                                             PlacementRelTo=building.ObjectPlacement,
                                                             RelativePlacement=wcs))
    f.create_entity("IfcRelAggregates", GlobalId=guid.new(), RelatingObject=project,
                    RelatedObjects=[site])
    f.create_entity("IfcRelAggregates", GlobalId=guid.new(), RelatingObject=site,
                    RelatedObjects=[building])
    f.create_entity("IfcRelAggregates", GlobalId=guid.new(), RelatingObject=building,
                    RelatedObjects=[storey])

    products = []
    wall_style = _surface_style(f, "Wall", wall_color)
    floor_style = _surface_style(f, "Floor", floor_color)

    def shape(solid):
        rep = f.create_entity("IfcShapeRepresentation", ContextOfItems=body,
                              RepresentationIdentifier="Body", RepresentationType="SweptSolid",
                              Items=[solid])
        return f.create_entity("IfcProductDefinitionShape", Representations=[rep])

    def local():
        return f.create_entity("IfcLocalPlacement", PlacementRelTo=storey.ObjectPlacement,
                               RelativePlacement=wcs)

    # --- walls: one prism per footprint edge, between mitred inner/outer rings offset from the
    #     footprint line. Anchor + offset place the band exactly as the Twin preview drew it, and the
    #     mitred rings keep the corners closed for any anchor (a plain per-edge slab would gap there).
    n = len(footprint)
    d_in, d_out = _band_offsets(wall_thickness, wall_anchor, wall_offset)
    inner = _offset_ring(footprint, d_in)
    outer = _offset_ring(footprint, d_out)
    for i in range(n):
        j = (i + 1) % n
        if math.dist(footprint[i], footprint[j]) < 1e-6:
            continue
        # the wall segment's footprint quad, in world XY, extruded up to the ceiling
        quad = [inner[i], inner[j], outer[j], outer[i]]
        prof = _profile(f, quad, name=f"Wall_{i}")
        solid = _extruded(f, prof, _placement(f), (0.0, 0.0, 1.0), height)
        _apply_style(f, solid, wall_style)
        wall = f.create_entity("IfcWall", GlobalId=guid.new(), Name=f"Wall_{i}",
                               ObjectPlacement=local(), Representation=shape(solid))
        products.append(wall)

    # --- floor slab: the outer wall ring extruded downward from z=0, so the slab reaches the walls'
    #     outer face and tracks the anchor/offset with them (matches the Twin preview's slab, which
    #     also uses the outer ring). At anchor=center offset=0 this is the footprint grown by t/2. ---
    floor_prof = _profile(f, outer, name="Floor")
    floor_solid = _extruded(f, floor_prof, _placement(f), (0.0, 0.0, -1.0), floor_thickness)
    _apply_style(f, floor_solid, floor_style)
    slab = f.create_entity("IfcSlab", GlobalId=guid.new(), Name="Floor", PredefinedType="FLOOR",
                           ObjectPlacement=local(), Representation=shape(floor_solid))
    products.append(slab)

    # --- room space: metadata only, NO geometry. A full-height extrusion of the footprint would
    #     render as a solid block filling the room's interior (the "white filling"); the walls and
    #     floor slab are the only geometry we want visible, so the IfcSpace carries no representation.
    space = f.create_entity("IfcSpace", GlobalId=guid.new(), Name=name,
                            LongName=name, PredefinedType="INTERNAL",
                            ObjectPlacement=local())
    products.append(space)

    f.create_entity("IfcRelContainedInSpatialStructure", GlobalId=guid.new(),
                    RelatingStructure=storey, RelatedElements=products)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    f.write(str(out_path))
    return str(out_path)


if __name__ == "__main__":
    import sys
    fp = [[-1.5, -1.0], [1.5, -1.0], [1.5, 1.0], [-1.5, 1.0]]
    print(build_room_ifc(fp, 2.5, sys.argv[1] if len(sys.argv) > 1 else "/tmp/room.ifc"))
