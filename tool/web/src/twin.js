/**
 * Twin preview: what the room will look like as a *building* sitting in the splat.
 *
 * Stage 3 already draws two things: the green wireframe prism (the crop boundary) and, optionally,
 * the real IFC solids as a faint reference. Neither answers the question this panel exists for --
 * "when the frontend puts this IFC over this splat, does it look right?" The digital-twin frontend
 * renders opaque shaded solids on a dark grey background (see components/digital-twin/ifc-viewer),
 * so the reference render here matches that: same background, same light rig, same solid shading.
 *
 * Two sources, because they answer different questions:
 *   - "ifc"       the server-tessellated IFC solids: the real building, real wall thickness. What
 *                 you have. Thickness/offset are baked into that geometry, so those controls are
 *                 inert here.
 *   - "generated" walls built from the room footprint at a thickness *you* choose. This is the
 *                 geometry `cleaned.ifc` describes, so it is the one that predicts the frontend --
 *                 and the thickness you settle on is written into the export.
 */

import * as THREE from "three";

/** The frontend's viewer background and light rig (ifc-viewer.tsx `scene.setup`). */
export const TWIN_FRONTEND_BG = "#242424";

export const TWIN_DEFAULTS = {
  source: "ifc",        // "ifc" | "generated"
  shading: "solid",     // "solid" | "ghost" | "wire"
  wallColor: "#9aa6b4",
  slabColor: "#6c7683",
  edgeColor: "#7fd4ff",
  opacity: 1,
  edges: true,
  thickness: 0.2,       // generated: wall thickness in metres
  anchor: "center",     // generated: where the slab sits on the footprint line
  offset: 0,            // generated: extra lateral shift, + is outward
  floorSlab: true,
  ceilSlab: false,
  bg: TWIN_FRONTEND_BG,
  twinLight: true,      // match the frontend's ambient/key intensities
};

const STORE_KEY = "splat-ifc:twin-style";

/** Style is a look, not a per-room setting -- carry it across rooms and reloads. */
export function loadTwinStyle() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return { ...TWIN_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  } catch {
    return { ...TWIN_DEFAULTS };
  }
}

export function saveTwinStyle(style) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(style)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- geometry

function signedArea(fp) {
  let a = 0;
  for (let i = 0; i < fp.length; i++) {
    const [x1, y1] = fp[i], [x2, y2] = fp[(i + 1) % fp.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Ring offset outward by `d` (negative = inward), with mitred corners.
 *
 * Offsetting each edge independently leaves gaps at convex corners and overlaps at concave ones;
 * pushing each *vertex* along the bisector by d/cos(half-angle) closes both. The cos is clamped so
 * a near-spike corner (the 57-wall machine shop has a few) produces a long-but-finite miter rather
 * than shooting off to infinity.
 */
export function offsetRing(fp, d) {
  const n = fp.length;
  const sign = signedArea(fp) >= 0 ? 1 : -1; // custom boxes keep the click winding; IFC is CCW
  const nrm = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = fp[i], [x2, y2] = fp[(i + 1) % n];
    const dx = x2 - x1, dy = y2 - y1;
    const L = Math.hypot(dx, dy) || 1;
    nrm.push([(sign * dy) / L, (-sign * dx) / L]); // outward for this winding
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = nrm[(i - 1 + n) % n], b = nrm[i];
    let mx = a[0] + b[0], my = a[1] + b[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) { out.push([fp[i][0] + b[0] * d, fp[i][1] + b[1] * d]); continue; }
    mx /= ml; my /= ml;
    const cos = Math.max(mx * b[0] + my * b[1], 0.2); // cap the miter at 5x thickness
    out.push([fp[i][0] + (mx * d) / cos, fp[i][1] + (my * d) / cos]);
  }
  return out;
}

/**
 * Polygon with each edge moved inward by its own offset (offsets[i] > 0 shrinks, < 0 grows), with
 * mitred corners. This mirrors the crop exactly: the SDF applies a per-wall offset and the corner
 * is where the two moved edges meet, so this is the true crop boundary to draw live. Corners come
 * from intersecting adjacent moved edge-lines (a shared bisector won't do when the offsets differ).
 */
export function offsetPolygonPerEdge(fp, offsets) {
  const n = fp.length;
  const sign = signedArea(fp) >= 0 ? 1 : -1;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = fp[i], [x2, y2] = fp[(i + 1) % n];
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    const nx = (sign * dy) / L, ny = (-sign * dx) / L;          // outward normal for this winding
    const o = offsets[i] ?? 0;                                  // inward = along −outward normal
    lines.push({ px: x1 - nx * o, py: y1 - ny * o, dx, dy });   // a point on the moved edge + its dir
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];             // corner i joins edges i−1 and i
    const den = A.dx * B.dy - A.dy * B.dx;
    if (Math.abs(den) < 1e-9) { out.push([B.px, B.py]); continue; }  // ~parallel: no clean miter
    const t = ((B.px - A.px) * B.dy - (B.py - A.py) * B.dx) / den;
    out.push([A.px + A.dx * t, A.py + A.dy * t]);
  }
  return out;
}

/** Where the wall slab sits across the footprint line, as [inner, outer] offsets. */
export function bandOffsets({ thickness, anchor, offset }) {
  const t = Math.max(thickness, 1e-4);
  const base = anchor === "inside" ? [-t, 0] : anchor === "outside" ? [0, t] : [-t / 2, t / 2];
  return [base[0] + offset, base[1] + offset];
}

/**
 * The wall band: a closed prism between the inner and outer rings, floor to ceiling, capped on
 * top and bottom so the wall reads as a solid with real thickness from any angle.
 *
 * Non-indexed on purpose -- each triangle owns its vertices, so computeVertexNormals() gives flat
 * architectural faces instead of smoothing the corners round.
 */
function wallBandGeometry(footprint, height, style) {
  const [dIn, dOut] = bandOffsets(style);
  const inner = offsetRing(footprint, dIn);
  const outer = offsetRing(footprint, dOut);
  const n = footprint.length;
  const p = [];
  const tri = (a, b, c) => p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const at = (ring, i, z) => [ring[i % n][0], ring[i % n][1], z];

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // outer skin (normals point away from the room)
    tri(at(outer, i, 0), at(outer, j, 0), at(outer, j, height));
    tri(at(outer, i, 0), at(outer, j, height), at(outer, i, height));
    // inner skin (reverse winding: normals point into the room)
    tri(at(inner, i, 0), at(inner, j, height), at(inner, j, 0));
    tri(at(inner, i, 0), at(inner, i, height), at(inner, j, height));
    // top cap ring (+z) and bottom cap ring (-z)
    tri(at(inner, i, height), at(outer, i, height), at(outer, j, height));
    tri(at(inner, i, height), at(outer, j, height), at(inner, j, height));
    tri(at(inner, i, 0), at(outer, j, 0), at(outer, i, 0));
    tri(at(inner, i, 0), at(inner, j, 0), at(outer, j, 0));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** A floor or ceiling slab: the outer ring extruded `t` thick, its top face at z = `top`. */
function slabGeometry(footprint, top, style) {
  const [, dOut] = bandOffsets(style);
  const ring = offsetRing(footprint, dOut);
  const shape = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y)));
  const t = Math.max(style.thickness, 1e-4);
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
  g.translate(0, 0, top - t);
  return g;
}

/**
 * Build the twin geometry for a room footprint. Returned separately because walls and slabs are
 * coloured independently -- a grey floor under lighter walls is what reads as a building.
 */
export function buildTwinGeometry(footprint, height, style) {
  return {
    walls: wallBandGeometry(footprint, height, style),
    floor: style.floorSlab ? slabGeometry(footprint, 0, style) : null,
    ceil: style.ceilSlab ? slabGeometry(footprint, height + style.thickness, style) : null,
  };
}

// ---------------------------------------------------------------- materials

/**
 * Materials for a shading mode.
 *
 * "solid" is the frontend look: opaque MeshStandardMaterial, lit, no polygon-offset games needed
 * because it writes depth like any normal mesh. "ghost" is the old faint-faces reference (useful
 * when you want to see the splat *through* the walls while judging alignment). "wire" is drawn as
 * edge lines by the caller, not by a material -- see twinEdgeMaterial.
 */
export function twinMaterial(color, style) {
  const opacity = Math.min(Math.max(style.opacity, 0), 1);
  const ghost = style.shading === "ghost";
  const o = ghost ? opacity * 0.18 : opacity;
  const transparent = o < 0.999;
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.85, metalness: 0.0,
    side: ghost ? THREE.FrontSide : THREE.DoubleSide,
    transparent, opacity: o,
    // Translucent faces must not write depth or they occlude each other in draw order; opaque
    // ones must, or they stop hiding the splat behind them (the whole point of "solid").
    depthWrite: !transparent,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

/**
 * Edge lines.
 *
 * These are EdgesGeometry lines, never a wireframe material: a wireframe draws every triangulation
 * diagonal, which on a 57-wall floorplate turns the floor slab into a fan of meaningless triangles
 * radiating across the room. Real edges draw the building.
 */
export function twinEdgeMaterial(style) {
  const wire = style.shading === "wire";
  return new THREE.LineBasicMaterial({
    color: style.edgeColor, transparent: true,
    opacity: wire ? Math.max(style.opacity, 0.2) : style.shading === "ghost" ? 0.85 : 0.55,
  });
}
