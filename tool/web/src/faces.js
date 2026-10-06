/**
 * The per-face crop model.
 *
 * A 4-wall room (Libra Lab) has exactly six rows -- Wall 0..3, Floor, Ceiling -- which is the
 * "6 faces of the cube" case. A 57-wall room gets one master row that drives every wall, plus an
 * expander for per-wall overrides. Same model underneath: every wall always has its own
 * offset/feather; the master just writes all of them at once.
 *
 * DOM-free: the React FacesPanel renders it and calls the setters below; `onChange` fires after
 * every edit with the live params, exactly as the old DOM panel did.
 */

// Slider range is a comfortable default, not a limit -- the number box next to it accepts any
// value (rooms vary from 3 m² to 505 m², and you may want to cut far outside the walls).
export const SLIDER_MIN = -3;
export const SLIDER_MAX = 3;

export class FaceModel {
  /**
   * @param {{walls:object[], height:number, footprint?:number[][]}} room
   * @param {(params:object)=>void} onChange  called live while dragging
   * @param {object|null} initial  saved crop (export/sidecar shape) to seed with, so a re-opened
   *   export comes back with the exact offsets/feathers it was exported at
   */
  constructor(room, onChange, initial = null) {
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
  }

  /** Small rooms list every wall outright; big ones hide per-wall rows behind an expander. */
  get simple() { return this.n <= 8; }

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

  _changed() { this.onChange(this.params); }

  // ---- setters (each fires onChange) -------------------------------------------------------

  /** "All walls": writes every wall at once and clears the per-wall overrides. */
  setMaster(key, v) {
    (key === "offset" ? this.params.wallOffset : this.params.wallFeather).fill(v);
    this.overridden.clear();
    this._changed();
  }

  setWall(i, key, v) {
    (key === "offset" ? this.params.wallOffset : this.params.wallFeather)[i] = v;
    this.overridden.add(i);
    this._changed();
  }

  /** Floor / ceiling: key is one of floorOffset, floorFeather, ceilOffset, ceilFeather. */
  setParam(key, v) {
    this.params[key] = v;
    this._changed();
  }

  /**
   * "Resize crop": Scale/Width/Height for a rectangular room, in metres of grow (+) or trim (−) per
   * side. Each drives its wall pair's offset directly (grow = −offset), so it only moves the crop
   * boundary -- the splat is never rescaled, and the exported cleaned.ifc (built from the original
   * footprint) is unchanged. Composes with the per-wall Offset sliders: whoever writes last wins.
   */
  resizeGroups() {
    const rc = this.rect;
    if (!rc) return [];
    return [
      { key: "scale", label: "Scale", idxs: [...rc.width, ...rc.height] },  // uniform: both pairs
      { key: "width", label: "Width", idxs: rc.width },
      { key: "height", label: "Depth", idxs: rc.height },
    ];
  }

  getGrow(idxs) { return -this.params.wallOffset[idxs[0]]; }

  setGrow(idxs, grow) {
    for (const i of idxs) this.params.wallOffset[i] = -grow;
    this._changed();
  }

  /** The resulting crop footprint size, so you can dial it to the region you want to keep. */
  dims() {
    const rc = this.rect;
    if (!rc) return null;
    const p = this.params;
    return {
      w: rc.baseW - 2 * p.wallOffset[rc.width[0]],    // grow = −offset, applied both sides
      h: rc.baseH - 2 * p.wallOffset[rc.height[0]],
      baseW: rc.baseW, baseH: rc.baseH,
    };
  }

  /** Floater slider range follows the room's extent. */
  floaterRange() {
    const fp = this.room.footprint ?? [];
    const ext = fp.length ? Math.max(
      Math.max(...fp.map((q) => q[0])) - Math.min(...fp.map((q) => q[0])),
      Math.max(...fp.map((q) => q[1])) - Math.min(...fp.map((q) => q[1]))) : 10;
    return { max: +(0.05 * ext).toFixed(3), step: +(ext / 2000).toPrecision(2) };
  }

  /** Reflect a changed ceiling height (shown in the Ceiling row's label). */
  setHeight(h) {
    this.room = { ...this.room, height: h };
  }
}
