/**
 * Post-alignment refinement, for the merged (Clean) stage.
 *
 * Two ways to fix an alignment once you can finally see both models on top of each other:
 *
 *   RefinePanel  -- nudge the whole splat (yaw/pitch/roll, translate, scale) by hand. Rotation
 *                   is about the room centre so it nudges rather than swings.
 *   PointEditor  -- drag a lettered room point onto the splat feature it should sit on, and
 *                   re-solve. You place these points in stage 2 without being able to see the
 *                   splat, so being able to correct them here is the whole idea.
 */

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

const DEG = Math.PI / 180;

export const IDENTITY_REFINE = () => ({
  scale: 1,
  rotation_euler_xyz: [0, 0, 0],
  translation: [0, 0, 0],
});

export class RefinePanel {
  /** @param {HTMLElement} host @param {()=>void} onChange */
  constructor(host, onChange, { roomSize = 5 } = {}) {
    this.host = host;
    this.onChange = onChange;
    this.value = IDENTITY_REFINE();
    // Translation range follows the room: ±half its size is plenty to nudge, never to lose it.
    this.tRange = Math.max(roomSize * 0.5, 1);
    this._render();
  }

  _row(label, opts) {
    const { min, max, step, get, set, fmt } = opts;
    const row = document.createElement("div");
    row.className = "refine-row";
    row.innerHTML = `<label>${label}</label>`;

    const range = document.createElement("input");
    range.type = "range";
    range.min = min; range.max = max; range.step = step;
    range.value = get();

    const num = document.createElement("input");
    num.type = "number";
    num.className = "val num";
    num.step = step;
    num.value = fmt(get());

    const commit = (v, from) => {
      if (!Number.isFinite(v)) return;
      set(v);
      if (from !== "range") range.value = String(Math.min(Math.max(v, min), max));
      if (from !== "number") num.value = fmt(v);
      this.onChange(this.value);
    };
    range.addEventListener("input", () => commit(Number(range.value), "range"));
    num.addEventListener("input", () => commit(Number(num.value), "number"));
    num.addEventListener("keydown", (e) => e.stopPropagation());

    row._sync = () => {
      const v = get();
      range.value = String(Math.min(Math.max(v, min), max));
      num.value = fmt(v);
    };
    row.append(range, num);
    return row;
  }

  _render() {
    this.host.innerHTML = "";
    // Read through `this.value` rather than capturing it: set() may swap the object, and a
    // captured reference would leave the sliders mutating an orphan while onChange reports the
    // untouched one.
    const f2 = (x) => Number(x).toFixed(2);
    const f1 = (x) => Number(x).toFixed(1);
    this.rows = [];

    const add = (r) => { this.rows.push(r); this.host.append(r); };

    // Rotation in degrees at the UI, radians in the model -- the API speaks radians.
    const rot = (i, name) => this._row(name, {
      min: -180, max: 180, step: 0.1, fmt: f1,
      get: () => this.value.rotation_euler_xyz[i] / DEG,
      set: (d) => { this.value.rotation_euler_xyz[i] = d * DEG; },
    });
    add(rot(2, "Yaw °"));
    add(rot(0, "Pitch °"));
    add(rot(1, "Roll °"));

    const tr = (i, name) => this._row(name, {
      min: -this.tRange, max: this.tRange, step: 0.01, fmt: f2,
      get: () => this.value.translation[i],
      set: (x) => { this.value.translation[i] = x; },
    });
    add(tr(0, "X m"));
    add(tr(1, "Y m"));
    add(tr(2, "Z m"));

    add(this._row("Scale ×", {
      min: 0.5, max: 2, step: 0.001, fmt: (x) => Number(x).toFixed(3),
      get: () => this.value.scale,
      set: (x) => { this.value.scale = Math.max(x, 1e-6); },
    }));
  }

  set(value) {
    this.value = value;
    for (const r of this.rows) r._sync();
  }

  reset() {
    this.set(IDENTITY_REFINE());
    this.onChange(this.value);
  }

  /** True when the user has actually nudged something. */
  isIdentity() {
    const v = this.value;
    return v.scale === 1
      && v.rotation_euler_xyz.every((x) => x === 0)
      && v.translation.every((x) => x === 0);
  }
}

/**
 * Click a lettered room point to select it, drag the gizmo to move it, release to re-solve.
 */
export class PointEditor {
  /**
   * @param {import("./viewer.js").Viewport} viewport
   * @param {(index:number, xyz:number[])=>void} onMoved  fired on drag end
   * @param {{clickSelect?:boolean}} opts  clickSelect=false: don't select on 3D clicks (the Draw
   *   stage uses clicks to *add* corners, so selection comes from the sidebar instead)
   */
  constructor(viewport, onMoved, { clickSelect = true } = {}) {
    this.v = viewport;
    this.onMoved = onMoved;
    this.handles = [];
    this.selected = null;

    this.gizmo = new TransformControls(viewport.camera, viewport.renderer.domElement);
    this.gizmo.setMode("translate");
    this.gizmo.setSpace("world");
    // Orbiting and dragging a handle must not happen at once.
    this.gizmo.addEventListener("dragging-changed", (e) => {
      viewport.controls.enabled = !e.value;
      if (!e.value && this.selected != null) {
        const h = this.handles[this.selected];
        this.onMoved(this.selected, h.position.toArray());
      }
    });
    const helper = this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo;
    viewport.scene.add(helper);
    this._helper = helper;
    if (clickSelect) this._bind();
  }

  /** True while the pointer is over a gizmo axis -- callers use this to suppress rival clicks. */
  get overGizmo() {
    return this.gizmo.dragging || this.gizmo.axis != null;
  }

  _bind() {
    const el = this.v.renderer.domElement;
    let down = null;
    el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener("pointerup", (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4 || this.gizmo.dragging) return;
      const hit = this.v.pickFrom(e, this.handles);
      if (hit) {
        this.select(this.handles.indexOf(hit.object.parent ?? hit.object));
      } else {
        this.select(null);
      }
    });
  }

  /**
   * @param {number[][]} points
   * @param {number} radius   world-space sphere radius -- these are real geometry you grab, so
   *                          unlike the screen-constant markers they need a world size
   * @param {(i:number)=>number} colorOf
   * @param {(i:number)=>string} labelOf
   */
  setPoints(points, radius, colorOf, labelOf) {
    this.clear();
    const depthTest = !!this.v.occlude; // hide handles behind the splat when occlusion is on
    points.forEach((p, i) => {
      const g = new THREE.Group();
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 20, 14),
        new THREE.MeshBasicMaterial({
          color: colorOf(i), depthTest, transparent: true, opacity: 0.9,
        }),
      );
      sphere.renderOrder = 998;
      g.add(sphere);
      // Same lettered badge as the align stage, so a point keeps its identity across stages.
      if (labelOf) g.add(this.v._badge(labelOf(i), colorOf(i)));
      g.position.set(...p);
      g.userData.index = i;
      this.v.scene.add(g);
      this.handles.push(g);
    });
  }

  select(i) {
    this.selected = i;
    if (i == null || !this.handles[i]) this.gizmo.detach();
    else this.gizmo.attach(this.handles[i]);
  }

  clear() {
    this.gizmo.detach();
    this.selected = null;
    for (const h of this.handles) {
      this.v.scene.remove(h);
      h.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.handles = [];
  }

  setVisible(on) {
    for (const h of this.handles) h.visible = on;
    if (!on) this.gizmo.detach();
    else if (this.selected != null) this.gizmo.attach(this.handles[this.selected]);
  }

  dispose() {
    this.clear();
    this.v.scene.remove(this._helper);
    this.gizmo.dispose();
  }
}
