/**
 * The crop/feather formula, in GLSL (for the live preview) and JS (for tests).
 *
 * `server/crop.py` is the source of truth -- it is what the export actually runs. The two
 * functions below must agree with it, and `tests/test_parity.py` checks that they do against
 * the real machine_shop grid. Keep CROP_GLSL and cropAlphaJS line-for-line equivalent: they sit
 * together so a change to one makes the other's staleness obvious.
 *
 * Sampling deliberately uses texelFetch + manual bilinear rather than GPU linear filtering:
 * it avoids depending on OES_texture_float_linear, and it reproduces numpy's clamp-then-lerp
 * exactly, which is what makes preview == export.
 */

export const CROP_GLSL = /* glsl */ `
float cropFade(float d, float f) {
  // 1 well inside (d <= -f), 0 outside (d >= 0). f<=0 is a hard cut.
  if (f <= 1e-9) { return d < 0.0 ? 1.0 : 0.0; }
  float t = clamp((d + f) / f, 0.0, 1.0);
  return 1.0 - (t * t * (3.0 - 2.0 * t));
}

// grid = (originX, originY, cell, nWalls); floorCeil = (floorZ, floorFeather, ceilZ, ceilFeather)
float cropAlpha(vec3 p, sampler2D distTex, sampler2D idxTex, sampler2D wallTex,
                vec4 grid, vec2 gridSize, vec4 floorCeil) {
  float W = gridSize.x;
  float H = gridSize.y;
  float fx = (p.x - grid.x) / grid.z;
  float fy = (p.y - grid.y) / grid.z;

  // nearest-neighbour for the wall index -- interpolating an index is meaningless
  int ix = int(clamp(floor(fx + 0.5), 0.0, W - 1.0));
  int iy = int(clamp(floor(fy + 0.5), 0.0, H - 1.0));
  int widx = int(texelFetch(idxTex, ivec2(ix, iy), 0).r + 0.5);

  // bilinear for the distance; note t is taken against the *clamped* corner, as numpy does
  float fx0 = clamp(floor(fx), 0.0, W - 1.0);
  float fy0 = clamp(floor(fy), 0.0, H - 1.0);
  float fx1 = clamp(fx0 + 1.0, 0.0, W - 1.0);
  float fy1 = clamp(fy0 + 1.0, 0.0, H - 1.0);
  float tx = clamp(fx - fx0, 0.0, 1.0);
  float ty = clamp(fy - fy0, 0.0, 1.0);

  float d00 = texelFetch(distTex, ivec2(int(fx0), int(fy0)), 0).r;
  float d10 = texelFetch(distTex, ivec2(int(fx1), int(fy0)), 0).r;
  float d01 = texelFetch(distTex, ivec2(int(fx0), int(fy1)), 0).r;
  float d11 = texelFetch(distTex, ivec2(int(fx1), int(fy1)), 0).r;
  float d = mix(mix(d00, d10, tx), mix(d01, d11, tx), ty);

  vec2 wp = texelFetch(wallTex, ivec2(widx, 0), 0).rg;   // (offset, feather)
  float aWall = cropFade(d + wp.x, wp.y);

  float aFloor = cropFade(floorCeil.x - p.z, floorCeil.y);
  float aCeil  = cropFade(p.z - floorCeil.z, floorCeil.w);

  return aWall * aFloor * aCeil;
}

// Floater filter -- server/crop.py floater_keep(). floater = (maxScale, minOpacity), <= 0 = off.
// scales: the gaussian's std-dev axes in room units; a: its own linear opacity (pre-crop).
float floaterKeep(vec3 scales, float a, vec2 floater) {
  float k = 1.0;
  if (floater.x > 0.0 && max(scales.x, max(scales.y, scales.z)) >= floater.x) { k = 0.0; }
  if (floater.y > 0.0 && a < floater.y) { k = 0.0; }
  return k;
}
`;

// ---- JS mirror of the above (tests only) -----------------------------------

export function floaterKeepJS(scaleMax, a, maxScale, minOpacity) {
  let k = 1;
  if (maxScale > 0 && scaleMax >= maxScale) k = 0;
  if (minOpacity > 0 && a < minOpacity) k = 0;
  return k;
}

export function cropFadeJS(d, f) {
  if (f <= 1e-9) return d < 0 ? 1 : 0;
  const t = Math.min(Math.max((d + f) / f, 0), 1);
  return 1 - t * t * (3 - 2 * t);
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const mix = (a, b, t) => a * (1 - t) + b * t;

/**
 * @param {{x:number,y:number,z:number}} p          point in room space
 * @param {{dist:Float32Array, widx:Float32Array, width:number, height:number,
 *          origin:[number,number], cell:number}} grid
 * @param {{wallOffset:Float32Array|number[], wallFeather:Float32Array|number[],
 *          floorZ:number, floorFeather:number, ceilZ:number, ceilFeather:number}} params
 */
export function cropAlphaJS(p, grid, params) {
  const W = grid.width, H = grid.height;
  const fx = (p.x - grid.origin[0]) / grid.cell;
  const fy = (p.y - grid.origin[1]) / grid.cell;

  const ix = clamp(Math.floor(fx + 0.5), 0, W - 1);
  const iy = clamp(Math.floor(fy + 0.5), 0, H - 1);
  const widx = Math.round(grid.widx[iy * W + ix]);

  const fx0 = clamp(Math.floor(fx), 0, W - 1);
  const fy0 = clamp(Math.floor(fy), 0, H - 1);
  const fx1 = clamp(fx0 + 1, 0, W - 1);
  const fy1 = clamp(fy0 + 1, 0, H - 1);
  const tx = clamp(fx - fx0, 0, 1);
  const ty = clamp(fy - fy0, 0, 1);

  const at = (x, y) => grid.dist[y * W + x];
  const d = mix(mix(at(fx0, fy0), at(fx1, fy0), tx), mix(at(fx0, fy1), at(fx1, fy1), tx), ty);

  const aWall = cropFadeJS(d + params.wallOffset[widx], params.wallFeather[widx]);
  const aFloor = cropFadeJS(params.floorZ - p.z, params.floorFeather);
  const aCeil = cropFadeJS(p.z - params.ceilZ, params.ceilFeather);
  return aWall * aFloor * aCeil;
}
