/**
 * Post-alignment refinement, for the merged (Clean) stage.
 *
 * Two ways to fix an alignment once you can finally see both models on top of each other:
 *
 *   refine value -- nudge the whole splat (yaw/pitch/roll, translate, scale) by hand. Rotation
 *                   is about the room centre so it nudges rather than swings. Edited by the
 *                   React RefinePanel; this module only defines its identity.
 *   PointEditor  -- drag a lettered room point onto the splat feature it should sit on, and
 *                   re-solve. You place these points in stage 2 without being able to see the
 *                   splat, so being able to correct them here is the whole idea.
 */

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

export const IDENTITY_REFINE = () => ({
  scale: 1,
  rotation_euler_xyz: [0, 0, 0],
  translation: [0, 0, 0],
});

/** True when nothing has actually been nudged. */
export function isIdentityRefine(v) {
  return v.scale === 1
    && v.rotation_euler_xyz.every((x) => x === 0)
    && v.translation.every((x) => x === 0);
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
    this.onSelect = null;

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
    this.onSelect?.(i);   // lets the sidebar list follow a selection made in 3D
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
