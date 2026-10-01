/**
 * The per-face control panel.
 *
 * A 4-wall room (Libra Lab) renders exactly six rows -- Wall 0..3, Floor, Ceiling -- which is
 * the "6 faces of the cube" case. A 57-wall room renders one master row that drives every wall,
 * plus an expander for per-wall overrides. Same model underneath: every wall always has its own
 * offset/feather; the master just writes all of them at once.
 */

// Slider range is a comfortable default, not a limit -- the number box next to it accepts any
// value (rooms vary from 3 m² to 505 m², and you may want to cut far outside the walls).
const SLIDER_MIN = -3;
const SLIDER_MAX = 3;

export class FacePanel {
  /**
   * @param {HTMLElement} host
   * @param {{walls:object[], height:number}} room
   * @param {(params:object)=>void} onChange  called live while dragging
   * @param {object|null} initial  saved crop (export/sidecar shape) to seed the sliders with, so a
   *   re-opened export comes back with the exact offsets/feathers it was exported at
   */
  constructor(host, room, onChange, initial = null) {
    this.host = host;
    this.room = room;
    this.onChange = onChange;
    this.n = room.walls.length;

    this.params = {
      wallOffset: new Float32Array(this.n),
      wallFeather: new Float32Array(this.n).fill(0.25),
      floorOffset: 0, floorFeather: 0.1,
      ceilOffset: 0, ceilFeather: 0.25,
      maxScale: 0, minOpacity: 0,      // floater filter, 0 = off
    };
    // Tracks whether a wall was touched individually, so the master doesn't stomp bespoke values
    // silently -- it still can, but the UI says so.
    this.overridden = new Set();
    if (initial) this._seed(initial);
    // Rectangular rooms get a Scale/Width/Height "Resize crop" control (see _rectAxes); null otherwise.
    this.rect = this._rectAxes();
    this._render();
  }

  /**
   * For a 4-wall room, classify the walls into the two parallel pairs so a Width/Height control can
   * drive the right ones. A wall's offset moves it along its normal: an edge running along Y is a
   * left/right wall (offset changes the X-extent = width); an edge along X is a top/bottom wall
   * (offset changes the Y-extent = height). Returns null for anything that isn't a clean rectangle.
   */
  _rectAxes() {
    if (this.n !== 4) return null;
    const width = [], height = [], xs = [], ys = [];
    for (let i = 0; i < 4; i++) {
      const { a, b } = this.room.walls[i];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      (Math.abs(ey) > Math.abs(ex) ? width : height).push(i);
      xs.push(a[0], b[0]); ys.push(a[1], b[1]);
    }
    if (width.length !== 2 || height.length !== 2) return null;
    return {
      width, height,
      baseW: Math.max(...xs) - Math.min(...xs),
      baseH: Math.max(...ys) - Math.min(...ys),
    };
  }

  /** Seed params from a saved crop (server/export shape: snake_case, per-wall arrays). */
  _seed(c) {
    const arr = (dst, src) => {
      if (!Array.isArray(src)) return;
      for (let i = 0; i < this.n; i++) if (src[i] != null) dst[i] = src[i];
    };
    arr(this.params.wallOffset, c.wall_offset);
    arr(this.params.wallFeather, c.wall_feather);
    if (c.floor_offset != null) this.params.floorOffset = c.floor_offset;
    if (c.floor_feather != null) this.params.floorFeather = c.floor_feather;
    if (c.ceil_offset != null) this.params.ceilOffset = c.ceil_offset;
    if (c.ceil_feather != null) this.params.ceilFeather = c.ceil_feather;
    if (c.max_scale != null) this.params.maxScale = c.max_scale;
    if (c.min_opacity != null) this.params.minOpacity = c.min_opacity;
    // Flag walls that differ from the master so its override note is accurate on reopen.
    for (let i = 1; i < this.n; i++) {
      if (this.params.wallOffset[i] !== this.params.wallOffset[0]
          || this.params.wallFeather[i] !== this.params.wallFeather[0]) this.overridden.add(i);
    }
  }

  _row({ name, sub, cls = "", get, set, ranges }) {
    const el = document.createElement("div");
    el.className = `face ${cls}`;
    el.innerHTML = `
      <div class="face-head">
        <div class="face-name">${name}${sub ? `<small>${sub}</small>` : ""}</div>
      </div>
      <div class="sliders"></div>`;
    const sl = el.querySelector(".sliders");

    for (const spec of ranges) {
      const label = document.createElement("label");
      label.textContent = spec.label;

      const input = document.createElement("input");
      input.type = "range";
      input.min = spec.min; input.max = spec.max; input.step = spec.step ?? 0.01;
      const dp = spec.dp ?? 2;
      input.value = get(spec.key);

      // The number box is authoritative: type any offset you like, past the slider's range.
      const num = document.createElement("input");
      num.type = "number";
      num.className = "val num";
      num.step = spec.step ?? 0.05;
      if (spec.hardMin !== undefined) num.min = spec.hardMin;
      num.value = Number(get(spec.key)).toFixed(dp);

      const commit = (v, from) => {
        if (!Number.isFinite(v)) return;
        if (spec.hardMin !== undefined) v = Math.max(v, spec.hardMin);
        set(spec.key, v);
        // Let the slider ride along, clamped, without clamping the underlying value.
        if (from !== "range") input.value = String(Math.min(Math.max(v, spec.min), spec.max));
        if (from !== "number") num.value = v.toFixed(dp);
        el.classList.toggle("out-of-range", v < spec.min || v > spec.max);
        this.onChange(this.params);
      };

      input.addEventListener("input", () => commit(Number(input.value), "range"));
      num.addEventListener("input", () => commit(Number(num.value), "number"));
      // Arrow keys on the number box shouldn't also fly the camera.
      num.addEventListener("keydown", (e) => e.stopPropagation());

      spec._input = input;
      spec._num = num;
      spec._commit = commit;
      sl.append(label, input, num);
    }
    el._ranges = ranges;
    return el;
  }

  _syncRow(el) {
    for (const spec of el._ranges) {
      const v = spec.read();
      spec._input.value = String(Math.min(Math.max(v, spec.min), spec.max));
      spec._num.value = Number(v).toFixed(spec.dp ?? 2);
      el.classList.toggle("out-of-range", v < spec.min || v > spec.max);
    }
  }

  _render() {
    this.host.innerHTML = "";
    const p = this.params;
    const simple = this.n <= 8; // small rooms get every wall listed outright

    // ---- master walls row (always present; the only wall control when N is large)
    this.masterEl = this._row({
      name: "All walls",
      sub: `${this.n} ${this.n === 1 ? "wall" : "walls"}`,
      cls: "master",
      get: (k) => (k === "offset" ? p.wallOffset[0] : p.wallFeather[0]),
      set: (k, v) => {
        const arr = k === "offset" ? p.wallOffset : p.wallFeather;
        arr.fill(v);
        this.overridden.clear();
        for (const el of this.wallEls ?? []) this._syncRow(el);
        this._updateOverrideNote();
        if (k === "offset") { this._syncResize?.(); this._updateDims?.(); }
      },
      ranges: [
        { label: "Offset", key: "offset", min: SLIDER_MIN, max: SLIDER_MAX, read: () => p.wallOffset[0] },
        { label: "Feather", key: "feather", min: 0, max: SLIDER_MAX, hardMin: 0, read: () => p.wallFeather[0] },
      ],
    });
    this.host.append(this.masterEl);

    // ---- per-wall rows
    this.wallEls = [];
    const perWall = document.createElement("div");
    perWall.className = "per-wall" + (simple ? "" : " hidden");

    for (let i = 0; i < this.n; i++) {
      const w = this.room.walls[i];
      const el = this._row({
        name: `Wall ${i}`,
        sub: `${w.length.toFixed(2)} m`,
        cls: "dim",
        get: (k) => (k === "offset" ? p.wallOffset[i] : p.wallFeather[i]),
        set: (k, v) => {
          (k === "offset" ? p.wallOffset : p.wallFeather)[i] = v;
          this.overridden.add(i);
          this._updateOverrideNote();
          if (k === "offset") { this._syncResize?.(); this._updateDims?.(); }
        },
        ranges: [
          { label: "Offset", key: "offset", min: SLIDER_MIN, max: SLIDER_MAX, read: () => p.wallOffset[i] },
          { label: "Feather", key: "feather", min: 0, max: SLIDER_MAX, hardMin: 0, read: () => p.wallFeather[i] },
        ],
      });
      this.wallEls.push(el);
      perWall.append(el);
    }

    if (!simple) {
      const exp = document.createElement("button");
      exp.className = "expander";
      exp.textContent = `▸ Per-wall overrides (${this.n})`;
      exp.addEventListener("click", () => {
        const hidden = perWall.classList.toggle("hidden");
        exp.textContent = `${hidden ? "▸" : "▾"} Per-wall overrides (${this.n})`;
      });
      this.host.append(exp);
      this.overrideNote = document.createElement("div");
      this.overrideNote.className = "hint";
      this.host.append(this.overrideNote);
    }
    this.host.append(perWall);

    // ---- floor / ceiling
    this.host.append(this._row({
      name: "Floor", sub: "z = 0",
      get: (k) => (k === "offset" ? p.floorOffset : p.floorFeather),
      set: (k, v) => { if (k === "offset") p.floorOffset = v; else p.floorFeather = v; },
      ranges: [
        { label: "Offset", key: "offset", min: SLIDER_MIN, max: SLIDER_MAX, read: () => p.floorOffset },
        { label: "Feather", key: "feather", min: 0, max: SLIDER_MAX, hardMin: 0, read: () => p.floorFeather },
      ],
    }));
    this.ceilRow = this._row({
      name: "Ceiling", sub: `z = ${this.room.height.toFixed(2)} m`,
      get: (k) => (k === "offset" ? p.ceilOffset : p.ceilFeather),
      set: (k, v) => { if (k === "offset") p.ceilOffset = v; else p.ceilFeather = v; },
      ranges: [
        { label: "Offset", key: "offset", min: SLIDER_MIN, max: SLIDER_MAX, read: () => p.ceilOffset },
        { label: "Feather", key: "feather", min: 0, max: SLIDER_MAX, hardMin: 0, read: () => p.ceilFeather },
      ],
    });
    this.host.append(this.ceilRow);

    // ---- floaters: drop oversized needles/blobs and near-invisible haze, wherever they are
    const fp = this.room.footprint ?? [];
    const ext = fp.length ? Math.max(
      Math.max(...fp.map((q) => q[0])) - Math.min(...fp.map((q) => q[0])),
      Math.max(...fp.map((q) => q[1])) - Math.min(...fp.map((q) => q[1]))) : 10;
    this.host.append(this._row({
      name: "Floaters", sub: "0 = off",
      get: (k) => (k === "size" ? p.maxScale : p.minOpacity),
      set: (k, v) => { if (k === "size") p.maxScale = v; else p.minOpacity = v; },
      ranges: [
        { label: "Max size", key: "size", min: 0, max: +(0.05 * ext).toFixed(3), hardMin: 0,
          step: +(ext / 2000).toPrecision(2), dp: 3, read: () => p.maxScale },
        { label: "Min opacity", key: "opacity", min: 0, max: 0.3, hardMin: 0, step: 0.005, dp: 3,
          read: () => p.minOpacity },
      ],
    }));

    // Resize control sits at the very top, above "All walls" -- it's the first thing you reach for.
    if (this.rect) this.host.prepend(this._resizeSection());

    this._updateOverrideNote();
  }

  /**
   * "Resize crop": Scale/Width/Height for a rectangular room, in metres of grow (+) or trim (−) per
   * side. Each drives its wall pair's offset directly (grow = −offset), so it only moves the crop
   * boundary -- the splat is never rescaled, and the exported cleaned.ifc (built from the original
   * footprint) is unchanged. Composes with the per-wall Offset sliders: whoever writes last wins.
   */
  _resizeSection() {
    const rc = this.rect, p = this.params;
    const el = document.createElement("div");
    el.className = "face resize";
    el.innerHTML = `
      <div class="face-head">
        <div class="face-name">Resize crop<small>grow + / trim − per side · moves the cut only, not the IFC</small></div>
      </div>
      <div class="sliders"></div>
      <div class="hint resize-dims"></div>`;
    const sl = el.querySelector(".sliders");
    this._dimsEl = el.querySelector(".resize-dims");

    const groups = [
      { label: "Scale", idxs: [...rc.width, ...rc.height] },  // uniform: both pairs
      { label: "Width", idxs: rc.width },
      { label: "Height", idxs: rc.height },
    ];
    this._resizeSpecs = [];
    for (const g of groups) {
      const label = document.createElement("label");
      label.textContent = g.label;

      const input = document.createElement("input");
      input.type = "range";
      input.min = SLIDER_MIN; input.max = SLIDER_MAX; input.step = 0.01;

      const num = document.createElement("input");
      num.type = "number"; num.className = "val num"; num.step = 0.05;

      const read = () => -p.wallOffset[g.idxs[0]];   // grow shown is the negation of the offset
      const commit = (grow, from) => {
        if (!Number.isFinite(grow)) return;
        for (const i of g.idxs) p.wallOffset[i] = -grow;
        for (const i of g.idxs) this._syncRow(this.wallEls[i]);
        if (from !== "range") input.value = String(Math.min(Math.max(grow, SLIDER_MIN), SLIDER_MAX));
        if (from !== "number") num.value = grow.toFixed(2);
        this._syncResize();      // keep Scale/Width/Height consistent with each other
        this._updateDims();
        this.onChange(this.params);
      };

      input.addEventListener("input", () => commit(Number(input.value), "range"));
      num.addEventListener("input", () => commit(Number(num.value), "number"));
      num.addEventListener("keydown", (e) => e.stopPropagation());  // don't also fly the camera

      this._resizeSpecs.push({ input, num, read });
      sl.append(label, input, num);
    }
    this._syncResize();
    this._updateDims();
    return el;
  }

  /** Refresh the Resize sliders from the current offsets (after a per-wall or master edit). */
  _syncResize() {
    for (const s of this._resizeSpecs ?? []) {
      const v = s.read();
      s.input.value = String(Math.min(Math.max(v, SLIDER_MIN), SLIDER_MAX));
      s.num.value = Number(v).toFixed(2);
    }
  }

  /** Show the resulting crop footprint size, so you can dial it to the region you want to keep. */
  _updateDims() {
    if (!this._dimsEl || !this.rect) return;
    const p = this.params, rc = this.rect;
    const effW = rc.baseW - 2 * p.wallOffset[rc.width[0]];    // grow = −offset, applied both sides
    const effH = rc.baseH - 2 * p.wallOffset[rc.height[0]];
    this._dimsEl.textContent =
      `≈ ${effW.toFixed(2)} × ${effH.toFixed(2)} m  (footprint ${rc.baseW.toFixed(2)} × ${rc.baseH.toFixed(2)})`;
  }

  /** Reflect a changed ceiling height in the Ceiling row's label. */
  setHeight(h) {
    this.room = { ...this.room, height: h };
    const small = this.ceilRow?.querySelector(".face-name small");
    if (small) small.textContent = `z = ${h.toFixed(2)} m`;
  }

  _updateOverrideNote() {
    if (!this.overrideNote) return;
    const k = this.overridden.size;
    this.overrideNote.textContent = k
      ? `${k} wall${k === 1 ? "" : "s"} overridden — moving “All walls” resets them.`
      : "";
  }
}
