/**
 * Room geometry from the IFC footprint, in room space (metres, centroid at origin, z=0 floor).
 *
 * Two jobs: something to look at, and something to click. The pick mesh is invisible but solid
 * so a ray always lands somewhere sensible; corner snapping then pulls the hit onto an actual
 * room corner, which is what you are really aiming at.
 */

import * as THREE from "three";
import { buildTwinGeometry, twinMaterial, twinEdgeMaterial, TWIN_DEFAULTS, offsetPolygonPerEdge } from "./twin.js";

const ROOM = 0x4dd6a8;
const SNAP_PX = 22;

export class RoomModel {
  /** @param {{footprint:number[][], height:number, walls:object[], name:string}} room */
  constructor(room) {
    this.room = room;
    this.group = new THREE.Group();

    const fp = room.footprint;
    const h = room.height;

    // Outline / floor-fill / corner dots -- rebuilt live by setCropBoundary as offsets change.
    this._outlineParts = [];
    this._buildOutline(fp, 0, h);

    // --- pick mesh: walls (extruded footprint shell) + floor + ceiling, invisible
    this.pickMesh = new THREE.Mesh(
      this._shellGeometry(fp, h),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false }),
    );
    this.group.add(this.pickMesh);
  }

  /**
   * (Re)build the wireframe outline, translucent floor fill and corner dots for a footprint at a
   * given z-range. Called once from the constructor (the true room) and again by setCropBoundary
   * with the offset polygon, so the box you see is the box the crop keeps.
   */
  _buildOutline(fp, zLo, zHi) {
    for (const o of this._outlineParts) {
      this.group.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    this._outlineParts = [];
    const n = fp.length;

    // --- corners: floor ring then ceiling ring
    this.corners = [];
    for (const [x, y] of fp) this.corners.push(new THREE.Vector3(x, y, zLo));
    for (const [x, y] of fp) this.corners.push(new THREE.Vector3(x, y, zHi));

    // --- outline: floor loop, ceiling loop, vertical edges
    const seg = [];
    const push = (a, b) => seg.push(a.x, a.y, a.z, b.x, b.y, b.z);
    for (let i = 0; i < n; i++) {
      const a = this.corners[i], b = this.corners[(i + 1) % n];
      const a2 = this.corners[n + i], b2 = this.corners[n + ((i + 1) % n)];
      push(a, b);
      push(a2, b2);
      push(a, a2);
    }
    const og = new THREE.BufferGeometry();
    og.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    this.outline = new THREE.LineSegments(
      og, new THREE.LineBasicMaterial({ color: ROOM, transparent: true, opacity: 0.85 }),
    );
    this.group.add(this.outline);

    // --- floor fill: gives the eye a ground plane and the ray something to hit
    const shape = new THREE.Shape(fp.map(([x, y]) => new THREE.Vector2(x, y)));
    this.floor = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({
        color: ROOM, transparent: true, opacity: 0.07, side: THREE.DoubleSide,
      }),
    );
    this.floor.position.z = zLo;
    this.group.add(this.floor);

    // --- corner dots
    const cg = new THREE.BufferGeometry().setFromPoints(this.corners);
    this.cornerDots = new THREE.Points(
      cg, new THREE.PointsMaterial({ color: ROOM, size: 6, sizeAttenuation: false }),
    );
    this.group.add(this.cornerDots);

    this._outlineParts.push(this.outline, this.floor, this.cornerDots);
    this.box = new THREE.Box3().setFromPoints(this.corners);
    this.setVisible(this._outlineVisible ?? true);
  }

  /**
   * Redraw the outline as the *crop boundary*: each wall moved in/out by its offset (mitred at the
   * corners, exactly as the SDF cuts), floor/ceiling at the cropped z-range. Called live from the
   * face panel, so resizing -- per wall or via Scale/Width/Height -- shows the polygon change in
   * real time. The pick mesh stays at the true footprint; only the visual outline moves.
   */
  setCropBoundary(params, height) {
    const off = params.wallOffset ?? params.wall_offset ?? [];
    const fp = offsetPolygonPerEdge(this.room.footprint, Array.from(off));
    const zLo = params.floorOffset ?? params.floor_offset ?? 0;
    const zHi = (height ?? this.room.height) - (params.ceilOffset ?? params.ceil_offset ?? 0);
    this._buildOutline(fp, zLo, zHi);
  }

  /** Wall quads + floor/ceiling caps as one triangle soup. */
  _shellGeometry(fp, h) {
    const pos = [];
    const n = fp.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = fp[i];
      const [x2, y2] = fp[(i + 1) % n];
      // two triangles per wall quad
      pos.push(x1, y1, 0, x2, y2, 0, x2, y2, h);
      pos.push(x1, y1, 0, x2, y2, h, x1, y1, h);
    }
    const shape = new THREE.Shape(fp.map(([x, y]) => new THREE.Vector2(x, y)));
    const cap = new THREE.ShapeGeometry(shape);
    const cp = cap.getAttribute("position");
    const ci = cap.getIndex();
    for (const z of [0, h]) {
      for (let k = 0; k < ci.count; k++) {
        const v = ci.getX(k);
        pos.push(cp.getX(v), cp.getY(v), z);
      }
    }
    cap.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  /** Snap a picked point to the nearest corner if one is within SNAP_PX on screen. */
  snap(point, viewport) {
    const target = viewport.toScreen(point);
    let best = null, bestD = SNAP_PX;
    for (const c of this.corners) {
      const d = viewport.toScreen(c).distanceTo(target);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best ? { point: best.clone(), snapped: true } : { point: point.clone(), snapped: false };
  }

  /**
   * Hand over the real IFC solids (walls with thickness, floor slab), tessellated server-side.
   *
   * Stored rather than drawn: what actually gets drawn is decided by the twin style, which may
   * prefer walls generated from the footprint at a thickness the user picked. Re-attaching after
   * a height change keeps the previous style and visibility, so nothing flickers back to default.
   */
  setSolid(vertices, indices) {
    this.ifcGeom = vertices?.length ? { vertices, indices } : null;
    return this._buildSolid();
  }

  /**
   * Set the twin look (source, shading, colours, wall thickness) and rebuild.
   *
   * Rebuilding rather than mutating materials is deliberate: source and thickness change the
   * geometry, not just the paint, and a room is a few thousand triangles -- cheap enough that one
   * code path for every control beats a fast path that can drift out of sync with a slow one.
   */
  setTwinStyle(style) {
    this.twinStyle = { ...TWIN_DEFAULTS, ...style };
    return this._buildSolid();
  }

  /**
   * Draw the twin: shaded faces plus optional edge lines.
   *
   * Edges earn their keep over splats -- lines never z-fight and read clearly against gaussian
   * mush -- but they are optional now, because the frontend doesn't draw them and the point of
   * this view is to predict the frontend.
   */
  _buildSolid() {
    if (this.solid) {
      this.group.remove(this.solid);
      this.solid.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      this.solid = null;
    }
    const style = this.twinStyle ?? TWIN_DEFAULTS;
    const parts = [];   // [geometry, colour]

    if (style.source === "generated") {
      const { walls, floor, ceil } = buildTwinGeometry(this.room.footprint, this.room.height, style);
      parts.push([walls, style.wallColor]);
      if (floor) parts.push([floor, style.slabColor]);
      if (ceil) parts.push([ceil, style.slabColor]);
    } else {
      if (!this.ifcGeom) return null; // solids not fetched yet (or a custom box has none)
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(this.ifcGeom.vertices, 3));
      g.setIndex(this.ifcGeom.indices);
      g.computeVertexNormals();
      parts.push([g, style.wallColor]);
    }

    const grp = new THREE.Group();
    const wire = style.shading === "wire";
    for (const [geom, color] of parts) {
      // Wire mode is edges only -- no faces at all, so the scan shows through completely.
      if (!wire) {
        const mesh = new THREE.Mesh(geom, twinMaterial(color, style));
        mesh.renderOrder = 1;
        grp.add(mesh);
      }
      if (wire || style.edges) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), twinEdgeMaterial(style));
        edges.renderOrder = 3;
        grp.add(edges);
      }
    }

    grp.visible = this._solidVisible ?? false; // opt-in, but survives a rebuild
    this.solid = grp;
    this.group.add(grp);
    return grp;
  }

  setSolidVisible(v) {
    this._solidVisible = v;
    if (this.solid) this.solid.visible = v;
  }

  setVisible(v) {
    this._outlineVisible = v;   // remembered so a live rebuild keeps the current toggle state
    this.outline.visible = v;
    this.floor.visible = v;
    this.cornerDots.visible = v;
  }

  dispose() {
    this.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
}
