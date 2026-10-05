/**
 * Build a room box from points clicked on the splat, for when there is no IFC.
 *
 * The blue point overlay makes a room's floor and walls obvious, so you can just click the floor
 * corners and get the same {footprint, height, transform} a real IFC would give -- which means the
 * whole downstream pipeline (SDF, per-wall crop, feather, export) works unchanged.
 *
 * The one thing we must derive is *up*: a photogrammetry scan is not gravity-aligned, so extruding
 * the footprint along the splat's own Z would give slanted walls. Instead we best-fit a plane to
 * the clicked floor points -- its normal is up -- and level the splat into a frame where that
 * plane is z=0 and up is +Z. Everything the crop assumes then holds.
 *
 * This module is the sole author of the custom transform: the client computes it once and sends
 * the exact footprint + matrix to the server for export, so preview and export cannot diverge.
 */

import * as THREE from "three";

/**
 * Eigen-decomposition of a symmetric 3x3 via cyclic Jacobi rotations. Returns eigenvectors as
 * columns of V and eigenvalues in d, ascending. Robust and tiny -- no external dependency.
 */
function jacobiEigenSym3(A) {
  const a = [
    [A[0][0], A[0][1], A[0][2]],
    [A[1][0], A[1][1], A[1][2]],
    [A[2][0], A[2][1], A[2][2]],
  ];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const d = [a[0][0], a[1][1], a[2][2]];
  const order = [0, 1, 2].sort((i, j) => d[i] - d[j]);
  return {
    values: order.map((i) => d[i]),
    vectors: order.map((i) => new THREE.Vector3(V[0][i], V[1][i], V[2][i]).normalize()),
  };
}

/** Best-fit plane of the points: centroid + unit normal (smallest-variance direction). */
export function fitPlane(points) {
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.multiplyScalar(1 / points.length);

  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = [p.x - c.x, p.y - c.y, p.z - c.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const { values, vectors } = jacobiEigenSym3(cov);
  return {
    center: c,
    normal: vectors[0],          // smallest eigenvalue -> plane normal
    values,                      // ascending; values[0]/values[1] small => planar
    inPlane: [vectors[2], vectors[1]], // two largest -> spread directions
  };
}

/**
 * @param {THREE.Vector3[]} points  floor corners clicked on the splat (splat space)
 * @param {number} height           extrusion height in splat units
 * @param {boolean} flipUp          flip the derived up direction
 * @param {boolean} fromCeiling  the clicked points are the CEILING, not the floor: the box
 *   extrudes DOWN to the floor. The model still comes out upright in Clean -- only the anchor and
 *   the draw-stage extrusion direction change; nothing is flipped.
 * @returns {{ room, matrix4, up, e1, e2, center, fromCeiling, planarity }}  or throws on degenerate input
 */
export function buildCustomRoom(points, height, fromCeiling = false) {
  if (points.length < 3) throw new Error("need at least 3 points");
  const { center, normal, values, inPlane } = fitPlane(points);

  // Collinear points (values[1] ~ 0) can't define a footprint plane.
  const planarity = values[1] > 1e-9 ? values[0] / values[1] : 1;
  if (values[1] < 1e-9) throw new Error("points are collinear — click 3+ spread-out corners");

  // Up is always physical up (oriented toward +Z), so the model is never flipped -- picking the
  // ceiling instead of the floor must NOT turn the room upside down in Clean.
  let up = normal.clone();
  if (up.z < 0) up.negate();

  // A stable in-plane basis: e1 from the first corner, e2 = up x e1.
  let e1 = points[0].clone().sub(center);
  e1.addScaledVector(up, -e1.dot(up)); // project into plane
  if (e1.lengthSq() < 1e-12) e1 = inPlane[0].clone(); // first point at centroid: fall back
  e1.normalize();
  const e2 = new THREE.Vector3().crossVectors(up, e1).normalize();

  // Footprint: each corner in the (e1, e2) plane coordinates.
  const footprint = points.map((p) => {
    const d = p.clone().sub(center);
    return [d.dot(e1), d.dot(e2)];
  });

  // room = R (p - center) + (0, 0, zShift), R rows = [e1; e2; up].
  //   floor picking   -> clicked plane sits at z=0 (the floor); room goes up to z=height.
  //   ceiling picking -> clicked plane sits at z=height (the ceiling); room goes down to z=0.
  // Either way up = +physical up, so the splat is upright in Clean.
  const t = new THREE.Vector3(
    -e1.dot(center), -e2.dot(center), -up.dot(center) + (fromCeiling ? height : 0));
  const matrix4 = [
    e1.x, e1.y, e1.z, t.x,
    e2.x, e2.y, e2.z, t.y,
    up.x, up.y, up.z, t.z,
    0, 0, 0, 1,
  ];

  const room = makeRoomFromFootprint(footprint, height, "custom box");
  return { room, matrix4, up, e1, e2, center, fromCeiling, planarity };
}

/** Recompute just the transform for a custom box at a new height (ceiling anchor tracks height). */
export function customMatrixForHeight(basis, height) {
  const { e1, e2, up, center, fromCeiling } = basis;
  return [
    e1.x, e1.y, e1.z, -e1.dot(center),
    e2.x, e2.y, e2.z, -e2.dot(center),
    up.x, up.y, up.z, -up.dot(center) + (fromCeiling ? height : 0),
    0, 0, 0, 1,
  ];
}

/**
 * Does this closed polygon cross itself? A self-intersecting footprint makes an invalid room
 * (the inside/outside test becomes meaningless), so the draw flow blocks it. O(n²) segment test,
 * fine for the handful of corners a room has.
 * @param {number[][]} pts  [[x,y],...] in order, implicitly closed
 */
export function polygonSelfIntersects(pts) {
  const n = pts.length;
  if (n < 4) return false;
  const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
  const crosses = (p1, p2, p3, p4) => {
    const d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2);
    const d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
    return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
  };
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // skip edges that share a vertex (adjacent, and the first/last wrap pair)
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (crosses(a, b, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

// ---- footprint edits in the Clean stage
//
// Each returns the new footprint and `wallSrc`: for every new wall, the old wall whose
// offset/feather it inherits, so per-wall crop settings follow their walls through the edit.
// Wall i runs from corner i to corner i+1.

/** Split wall i at its midpoint: the new corner lands at index i+1; both halves keep wall i's settings. */
export function insertCorner(footprint, i) {
  const n = footprint.length;
  const [a, b] = [footprint[i], footprint[(i + 1) % n]];
  const fp = [...footprint.slice(0, i + 1), [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ...footprint.slice(i + 1)];
  const wallSrc = fp.map((_, j) => (j <= i ? j : j - 1));
  return { footprint: fp, wallSrc };
}

/** Drop corner i: its two walls merge into one, which keeps the earlier wall's settings. */
export function deleteCorner(footprint, i) {
  const n = footprint.length;
  if (n <= 3) throw new Error("A room needs at least 3 corners.");
  const keep = footprint.map((_, k) => k).filter((k) => k !== i);
  // a new wall starts at old corner keep[j], so it continues old wall keep[j] (the merged wall
  // starts at the corner before i, whose old wall ran into i -- also right)
  return { footprint: keep.map((k) => footprint[k]), wallSrc: keep };
}

/**
 * Turn the room upside down in room space: (x, y, z) -> (x, -y, H - z), a 180 deg turn about the
 * room's x axis that maps the box [0, H] onto itself. The crop region is unchanged -- the same
 * splats are kept -- only which face is floor and which is ceiling swaps.
 *
 * Footprint: mirrored in y (floor plane seen from the other side) and re-ordered so it stays
 * counter-clockwise with corner 0 first; new wall j is old wall n-1-j run backwards.
 */
export function flipFootprint(footprint) {
  const n = footprint.length;
  const fp = footprint.map((_, j) => {
    const [x, y] = footprint[(n - j) % n];
    return [x, -y];
  });
  return { footprint: fp, wallSrc: fp.map((_, j) => n - 1 - j) };
}

/** The scan -> room matrix (row-major 4x4) after the flip: rows e2/up negate, z' = H - z. */
export function flipMatrix(m, height) {
  const o = [...m];
  for (let c = 0; c < 4; c++) { o[4 + c] = -m[4 + c]; o[8 + c] = -m[8 + c]; }
  o[11] = height - m[11];
  return o;
}

/**
 * The custom-box basis after the flip, at the current height H. up and e2 reverse (still
 * right-handed), and the box is re-anchored on its NEW floor -- the plane that was the ceiling --
 * so Room height afterwards clips the ceiling like any upright box instead of moving the model.
 * customMatrixForHeight(flipBasis(b, H), h) === flipMatrix(customMatrixForHeight(b, H), H) for
 * every h.
 */
export function flipBasis(b, height) {
  if (!b) return b;
  // the old ceiling plane sits at up.(p - center) = H for a floor-anchored box, at 0 otherwise
  const center = b.fromCeiling ? b.center.clone() : b.center.clone().addScaledVector(b.up, height);
  return { ...b, e2: b.e2.clone().negate(), up: b.up.clone().negate(), center, fromCeiling: false };
}

/**
 * The manual nudge after the flip. Refine rotates about the room centre (0, 0, H/2), which the
 * flip leaves in place, so the flipped nudge is the old one conjugated by diag(1, -1, -1):
 * rotation about x unchanged, about y and z reversed; the y/z shift reversed.
 */
export function flipRefine(r) {
  const [rx, ry, rz] = r.rotation_euler_xyz;
  const [tx, ty, tz] = r.translation;
  return { ...r, rotation_euler_xyz: [rx, -ry, -rz], translation: [tx, -ty, -tz] };
}

/** Client-side twin of ifc_room.room_from_footprint, so the Clean stage treats it like any room. */
export function makeRoomFromFootprint(footprint, height, name = "custom box") {
  const walls = footprint.map(([x1, y1], i) => {
    const [x2, y2] = footprint[(i + 1) % footprint.length];
    return { index: i, label: `Wall ${i}`, a: [x1, y1], b: [x2, y2], length: Math.hypot(x2 - x1, y2 - y1) };
  });
  // Shoelace area (unsigned).
  let a = 0;
  for (let i = 0; i < footprint.length; i++) {
    const [x1, y1] = footprint[i];
    const [x2, y2] = footprint[(i + 1) % footprint.length];
    a += x1 * y2 - x2 * y1;
  }
  return {
    name, footprint, walls, height,
    centroid: [0, 0], area: Math.abs(a) / 2, unit_scale: 1, custom: true,
  };
}
