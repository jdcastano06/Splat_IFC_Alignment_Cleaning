/** A self-contained three.js viewport: renderer, camera, orbit controls, markers, picking. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer } from "@sparkjsdev/spark";

/**
 * Percentile bounding box over sampled splat centres.
 *
 * These scans reconstruct ±50 m of floaters and sky around a room that may be 2 m across, so the
 * true bounding box is useless for framing -- it shows a dust cloud with the room as one pixel
 * in the middle. Trimming the tails finds the dense part you actually want to look at and click.
 */
export function robustBox(mesh, { lo = 0.02, hi = 0.98, maxSamples = 20000 } = {}) {
  const n = mesh.packedSplats?.numSplats ?? 0;
  if (!n) return new THREE.Box3();
  const stride = Math.max(1, Math.floor(n / maxSamples));
  const xs = [], ys = [], zs = [];
  mesh.forEachSplat((i, center, scales, quat, opacity) => {
    if (i % stride) return;
    if (opacity < 0.05) return; // near-invisible splats shouldn't drag the box out
    xs.push(center.x); ys.push(center.y); zs.push(center.z);
  });
  if (!xs.length) return mesh.getBoundingBox(true);
  for (const a of [xs, ys, zs]) a.sort((p, q) => p - q);
  const at = (a, t) => a[Math.min(a.length - 1, Math.max(0, Math.round(t * (a.length - 1))))];
  return new THREE.Box3(
    new THREE.Vector3(at(xs, lo), at(ys, lo), at(zs, lo)),
    new THREE.Vector3(at(xs, hi), at(ys, hi), at(zs, hi)),
  );
}

/**
 * A blue point cloud of splat centres, à la SuperSplat's "centers" view.
 *
 * A translucent gaussian blob hides the geometry you are trying to click; the raw centres make
 * walls, edges and corners legible, which is exactly what you need to place alignment points.
 * Built once per splat (it is a ~2 s pass over 5.3 M splats) and cached by the caller.
 *
 * Points are screen-constant size and ignore depth, so they read as a crisp overlay regardless
 * of how the arbitrary splat scale places the camera.
 */
export function buildSplatPoints(mesh, { color = 0x2b6cff, maxPoints = 6_000_000 } = {}) {
  const n = mesh.packedSplats?.numSplats ?? 0;
  if (!n) return null;
  const stride = Math.max(1, Math.ceil(n / maxPoints));
  const pos = new Float32Array(Math.ceil(n / stride) * 3);
  let j = 0;
  mesh.forEachSplat((i, center, scales, quat, opacity) => {
    if (i % stride) return;
    if (opacity < 0.03) return; // floaters are mostly transparent -- don't draw them
    pos[j++] = center.x; pos[j++] = center.y; pos[j++] = center.z;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, j), 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({
    color, size: 1.7, sizeAttenuation: false,
    transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
  }));
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  pts.userData.pointCount = j / 3;
  return pts;
}

export class Viewport {
  constructor(host, { accent = 0x4da3ff } = {}) {
    this.host = host;
    this.accent = accent;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x0d1013, 1);
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5000);
    this.camera.position.set(4, -4, 3);
    this.camera.up.set(0, 0, 1); // z-up: matches both the IFC and room space

    // Spark needs its renderer in the scene to composite splats.
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    // In fly mode, hold the camera at a fixed anchor so a drag only changes its facing. Fires
    // after every OrbitControls update, including the ones it runs itself during a drag.
    this._flyAnchor = null;
    this.controls.addEventListener("change", () => this._holdFlyAnchor());

    // Navigation mode. "orbit": drag rotates around a pivot (the classic feel). "fly": drag looks
    // around the camera like an FPS, so WASD-and-look stop fighting the orbit pivot. Building the
    // toggle here means every pane (both align panes and the clean pane) gets it for free.
    this.navMode = "orbit";
    this._buildNavToggle();

    // Kept as fields so the twin preview can swap in the frontend's rig (see setLighting).
    this.ambient = new THREE.AmbientLight(0xffffff, 1.6);
    this.scene.add(this.ambient);
    this.key = new THREE.DirectionalLight(0xffffff, 1.1);
    this.key.position.set(2, -3, 5);
    this.scene.add(this.key);
    this._defaultLights = { ambient: 1.6, key: 1.1, keyPos: [2, -3, 5] };
    this._defaultBg = 0x0d1013;

    this.markers = new THREE.Group();
    this.scene.add(this.markers);

    // Depth-occlusion of markers/handles. Off by default (splats stay smooth); when on, the splat
    // renders "stochastic" so it writes depth and depth-tested markers hide behind it -- the only
    // way to occlude against gaussian content. Markers created while this is on are depth-tested.
    this.occlude = false;

    this.raycaster = new THREE.Raycaster();
    this.pickTargets = [];
    this.onPick = null;
    this._bindPick();

    // WASD fly. Orbiting alone is painful in a 50 m scan -- you cannot get near a far corner
    // without fighting the pivot. Movement is scaled to the scene by frame().
    this.moveSpeed = 1;
    this._keys = new Set();
    this._hover = false;
    this._bindKeys();

    this._clock = new THREE.Clock();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(host);
    this.resize();

    this._running = true;
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Keys act on whichever viewport the pointer is over, so the two panes never fight. */
  _bindKeys() {
    const host = this.host;
    host.addEventListener("pointerenter", () => { this._hover = true; });
    host.addEventListener("pointerleave", () => { this._hover = false; this._keys.clear(); });

    const KEYS = new Set(["w", "a", "s", "d", "q", "e", "shift", " "]);
    this._onKeyDown = (e) => {
      if (!this._hover) return;
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === "f") { // quick flip between orbit and fly without reaching for the pill
        this.setNavMode(this.navMode === "orbit" ? "fly" : "orbit");
        e.preventDefault();
        return;
      }
      if (!KEYS.has(k)) return;
      this._keys.add(k);
      e.preventDefault();
    };
    this._onKeyUp = (e) => this._keys.delete(e.key.toLowerCase());
    this._onBlur = () => this._keys.clear();
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onBlur);
  }

  /** Move camera and orbit pivot together, so orbiting still works after flying. */
  _fly(dt) {
    if (!this._keys.size) return;
    const k = this._keys;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const up = this.camera.up.clone().normalize();

    const dir = new THREE.Vector3();
    if (k.has("w")) dir.add(fwd);
    if (k.has("s")) dir.sub(fwd);
    if (k.has("d")) dir.add(right);
    if (k.has("a")) dir.sub(right);
    if (k.has("e") || k.has(" ")) dir.add(up);
    if (k.has("q")) dir.sub(up);
    if (dir.lengthSq() === 0) return;

    const speed = this.moveSpeed * (k.has("shift") ? 4 : 1);
    dir.normalize().multiplyScalar(speed * dt);
    this.camera.position.add(dir);
    this.controls.target.add(dir);
    // Flying relocates the fixed look-anchor, so the hold keeps the camera *here* now.
    if (this.navMode === "fly") this._flyAnchor?.add(dir);
  }

  _tick() {
    if (!this._running) return;
    this._fly(Math.min(this._clock.getDelta(), 0.1));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._tick);
  }

  /**
   * First-person look, enforced after every OrbitControls update.
   *
   * OrbitControls can only rotate the camera *around its target*, so a drag always slides the
   * camera position -- which reads as the model swinging. And it calls update() from inside its
   * own pointermove handler, not just from our rAF loop, so wrapping the loop isn't enough. This
   * runs on the controls' "change" event (fired after every update, from wherever) and translates
   * the whole rig so the camera returns to a fixed anchor: only its facing changed. The target
   * rides along, so it stays exactly one step ahead in the new look direction -- the pivot the
   * next drag rotates about. WASD moves the anchor (see _fly), so flying still works.
   */
  _holdFlyAnchor() {
    if (this.navMode !== "fly" || !this._flyAnchor) return;
    const shift = this._flyAnchor.clone().sub(this.camera.position);
    if (shift.lengthSq() < 1e-20) return;
    this.camera.position.add(shift);
    this.controls.target.add(shift);
  }

  /** Distinguish a click from an orbit-drag, so rotating the view never drops a marker. */
  _bindPick() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener("pointerup", (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4 || !this.onPick) return;
      const hit = this.pick(e);
      if (hit) this.onPick(hit);
    });
  }

  /** Clear colour. The twin preview sets the frontend's #242424 so the two renders compare. */
  setBackground(color) {
    this.renderer.setClearColor(new THREE.Color(color ?? this._defaultBg), 1);
  }

  /**
   * Swap the light rig. The tool's default is flat and bright (you are clicking corners, not
   * admiring geometry); the frontend's is dimmer-ambient with a strong key, which is what makes
   * solid walls read as surfaces. Passing nothing restores the tool's own.
   */
  setLighting(rig = null) {
    const r = rig ?? this._defaultLights;
    this.ambient.intensity = r.ambient;
    this.key.intensity = r.key;
    this.key.position.set(...r.keyPos);
  }

  /** Toggle depth occlusion: splat writes depth (grainier), markers/handles hide behind it. */
  setOcclude(on) {
    this.occlude = on;
    try { this.spark.defaultView.stochastic = on; } catch (e) { /* older Spark */ }
    // Retro-fit existing markers so the change is immediate.
    this.markers.traverse((o) => {
      if (o.material && "depthTest" in o.material) {
        o.material.depthTest = on;
        o.material.needsUpdate = true;
      }
    });
  }

  /**
   * Switch between orbit and first-person (fly) navigation.
   *
   * "orbit": OrbitControls as-is -- drag rotates around the pivot, wheel dollies, right-drag pans.
   *          Entering orbit re-pivots on what's ahead WITHOUT moving the camera (see
   *          _focusTargetAhead), so the switch never lurches the view.
   * "fly":   the camera is held at a fixed anchor and a drag only turns its facing (see
   *          _holdFlyAnchor); zoom/pan are off and you move with WASD. Neither mode disables
   *          clicking, so you can still place points in either.
   */
  setNavMode(mode) {
    if (mode !== "orbit" && mode !== "fly") return;
    const c = this.controls;
    this.navMode = mode;
    if (mode === "fly") {
      this._pinTargetAhead();                       // put the pivot a step ahead in the look direction
      this._flyAnchor = this.camera.position.clone(); // ...and hold the camera right here
      c.enableZoom = false;
      c.enablePan = false;
    } else {
      this._flyAnchor = null;
      this._focusTargetAhead();        // give orbit a real pivot ahead, camera unmoved
      c.enableZoom = true;
      c.enablePan = true;
    }
    this._syncNavToggle();
  }

  /** Put the orbit target a short step in front of the camera -- the pivot for fly-mode look. */
  _pinTargetAhead() {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const d = Math.max(this.moveSpeed, 0.5);
    this.controls.target.copy(this.camera.position).addScaledVector(fwd, d);
  }

  /**
   * Leaving fly mode, choose an orbit pivot **without moving the camera** -- only the target
   * changes, so switching to orbit never lurches the view. In priority:
   *   1. the geometry straight ahead (orbit around what you were looking at), else
   *   2. the framed scene centre if it's in front of you (orbit around the model), else
   *   3. a point one scene-radius ahead, so the pivot is never right on the lens.
   */
  _focusTargetAhead() {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);

    if (this.pickTargets?.length) {
      this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      const hits = this.raycaster.intersectObjects(this.pickTargets, true);
      if (hits.length) {
        this.controls.target.copy(hits[0].point);
        this.controls.update();
        return;
      }
    }

    if (this._framedCenter) {
      const toCenter = this._framedCenter.clone().sub(this.camera.position);
      if (toCenter.dot(fwd) > 0) { // in front of us, not behind
        this.controls.target.copy(this._framedCenter);
        this.controls.update();
        return;
      }
    }

    const d = this._framedRadius ? Math.max(this._framedRadius, 1) : Math.max(this.moveSpeed * 6, 2);
    this.controls.target.copy(this.camera.position).addScaledVector(fwd, d);
    this.controls.update();
  }

  /** An on-canvas pill that flips the mode; two lines so the current controls are always visible. */
  _buildNavToggle() {
    const b = document.createElement("button");
    b.className = "nav-toggle";
    b.type = "button";
    this._navToggle = b;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setNavMode(this.navMode === "orbit" ? "fly" : "orbit");
      b.blur(); // else Space (fly-up) would re-trigger the focused button
    });
    this.host.appendChild(b);
    this._syncNavToggle();
  }

  _syncNavToggle() {
    const b = this._navToggle;
    if (!b) return;
    b.classList.toggle("fly", this.navMode === "fly");
    b.title = this.navMode === "orbit"
      ? "Orbit mode — drag rotates around a pivot. Click for first-person Fly."
      : "Fly (first-person) mode — WASD to move, drag to look. Click for Orbit.";
    b.innerHTML = this.navMode === "orbit"
      ? `<span class="nm">⟳ Orbit</span><span class="nk">drag rotates · WASD flies</span>`
      : `<span class="nm">✜ Fly</span><span class="nk">WASD moves · drag looks</span>`;
  }

  pick(event) {
    return this.pickFrom(event, this.pickTargets);
  }

  pickFrom(event, targets) {
    if (!targets?.length) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - r.left) / r.width) * 2 - 1,
      -((event.clientY - r.top) / r.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(targets, true);
    return hits.length ? { point: hits[0].point.clone(), object: hits[0].object, ndc } : null;
  }

  /** Project a world point to client pixels -- used for corner snapping. */
  toScreen(p) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = p.clone().project(this.camera);
    return new THREE.Vector2((v.x * 0.5 + 0.5) * r.width, (-v.y * 0.5 + 0.5) * r.height);
  }

  /**
   * A lettered, coloured marker at a world point.
   *
   * Everything here is screen-constant (sizeAttenuation: false). Sizing markers in world units
   * cannot work across these scenes -- a 2 m room and a 90 m photogrammetry cloud are both
   * normal here, and any fixed world size is invisible in one and enormous in the other.
   *
   * @param {THREE.Vector3} point
   * @param {string|number} label  pairs use the same letter in both panes
   * @param {number} color         per-pair colour, so A↔A matches by hue as well as letter
   */
  addMarker(point, label, color = this.accent) {
    const g = new THREE.Group();

    // Exact position: a constant-size dot, so you can see precisely where the click landed.
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const dot = new THREE.Points(dg, new THREE.PointsMaterial({
      color, size: 7, sizeAttenuation: false, depthTest: this.occlude,
    }));
    dot.renderOrder = 999;
    g.add(dot);

    g.add(this._badge(label, color));
    g.position.copy(point);
    g.userData.markerColor = color;
    this.markers.add(g);
    return g;
  }

  _badge(text, color) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d");
    x.fillStyle = "#" + new THREE.Color(color).getHexString();
    x.beginPath();
    x.arc(32, 32, 25, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = "#06101c";
    x.lineWidth = 4;
    x.stroke();
    x.fillStyle = "#06101c";
    x.font = "bold 34px ui-sans-serif, system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(String(text), 32, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: t, depthTest: this.occlude, sizeAttenuation: false,
    }));
    // Fraction of viewport height, so the badge stays legible at any zoom.
    s.scale.setScalar(0.045);
    s.center.set(0.5, -0.25); // sit just above the dot rather than covering it
    s.renderOrder = 1000;
    return s;
  }

  clearMarkers() {
    for (const m of [...this.markers.children]) this.markers.remove(m);
  }

  /** Frame a box with a comfortable margin. */
  frame(box, pad = 1.5) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const radius = Math.max(s.length() * 0.5, 0.001);
    const dist = (radius * pad) / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.copy(c).add(new THREE.Vector3(1, -1, 0.65).normalize().multiplyScalar(dist));
    this.camera.near = Math.max(dist / 5000, 0.005);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    // ~2 scene-radii per second: usable in a 2 m room and a 90 m scan alike.
    this.moveSpeed = Math.max(radius * 0.6, 0.05);
    // Remembered so switching back to orbit can pivot on the model, not a point off the lens.
    this._framedCenter = c.clone();
    this._framedRadius = radius;
  }

  dispose() {
    this._running = false;
    this._ro.disconnect();
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
