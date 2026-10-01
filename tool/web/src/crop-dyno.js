/**
 * Live crop/feather preview as a Spark `worldModifier`.
 *
 * The whole point of baking (distance, nearest-wall-index) server-side is that every control on
 * the panel is *only* a uniform here. Dragging a slider writes a few floats into a 2-pixel-tall
 * texture; nothing re-bakes, nothing re-uploads, nothing re-compiles. That is what makes 5.3M
 * splats feather in real time.
 *
 * Runs in world space, and the scene's world space *is* room space (metres, footprint centroid
 * at the origin, z=0 at the floor), so `gsplat.center` here is already what crop.py sees.
 */

import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";
import { CROP_GLSL } from "./crop-shared.js";

const { Dyno, DynoOutput, Gsplat, defineGsplat, dynoBlock, uniform } = dyno;

function floatTexture(data, width, height, format) {
  const t = new THREE.DataTexture(data, width, height, format, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** The custom GLSL node: Gsplat in -> Gsplat out, with opacity scaled by cropAlpha(). */
class CropDyno extends Dyno {
  constructor({ gsplat, distTex, idxTex, wallTex, grid, gridSize, floorCeil, floater, enabled }) {
    super({
      inTypes: {
        gsplat: Gsplat,
        distTex: "sampler2D",
        idxTex: "sampler2D",
        wallTex: "sampler2D",
        grid: "vec4",
        gridSize: "vec2",
        floorCeil: "vec4",
        floater: "vec2",
        enabled: "float",
      },
      outTypes: { gsplat: Gsplat },
      inputs: { gsplat, distTex, idxTex, wallTex, grid, gridSize, floorCeil, floater, enabled },
      globals: () => [defineGsplat, CROP_GLSL],
      statements: ({ inputs, outputs }) => {
        const o = outputs.gsplat;
        if (!o) return [];
        const i = inputs;
        if (!i.gsplat) return [`${o}.flags = 0u;`];
        // Debug probes for e2e/drive.mjs: isolate "is the modifier running at all?" from
        // "is the SDF maths right?". Set window.__cropDebug before entering the clean stage.
        const dbg = typeof window !== "undefined" ? window.__cropDebug : null;
        if (dbg === "zero") {
          return [`${o} = ${i.gsplat};`, `${o}.rgba.a = 0.0;`, `${o}.flags = 0u;`];
        }
        const alphaExpr = dbg === "dist"
          // visualise raw sampled distance instead of cropping
          ? [`float _a = cropAlpha(${o}.center, ${i.distTex}, ${i.idxTex}, ${i.wallTex},`,
             `                     ${i.grid}, ${i.gridSize}, ${i.floorCeil});`,
             `${o}.rgba.rgb = vec3(_a, 1.0 - _a, 0.0);`]
          : [];
        return [
          `${o} = ${i.gsplat};`,
          `float _a = cropAlpha(${o}.center, ${i.distTex}, ${i.idxTex}, ${i.wallTex},`,
          `                     ${i.grid}, ${i.gridSize}, ${i.floorCeil});`,
          `_a *= floaterKeep(${o}.scales, ${o}.rgba.a, ${i.floater});`,
          `_a = mix(1.0, _a, ${i.enabled});`,
          `${o}.rgba.a *= _a;`,
          // Fully-faded splats still cost sort + raster; drop them from the pipeline.
          `if (${o}.rgba.a < ${(1.0 / 255.0).toFixed(8)}) { ${o}.flags = 0u; }`,
        ];
      },
    });
  }
  dynoOut() {
    return new DynoOutput(this, "gsplat");
  }
}

export class CropModifier {
  /**
   * @param {{width:number,height:number,origin:[number,number],cell:number,nWalls:number}} meta
   * @param {Float32Array} dist  length width*height
   * @param {Float32Array} widx  length width*height
   * @param {number} height      room height (metres)
   */
  constructor(meta, dist, widx, height) {
    this.meta = meta;
    this.roomHeight = height;
    this.nWalls = meta.nWalls;

    this.distTex = floatTexture(dist, meta.width, meta.height, THREE.RedFormat);
    this.idxTex = floatTexture(widx, meta.width, meta.height, THREE.RedFormat);

    // Nx1 RG texture: (offset, feather) per wall. This is the whole slider surface.
    this.wallData = new Float32Array(this.nWalls * 2);
    this.wallTex = floatTexture(this.wallData, this.nWalls, 1, THREE.RGFormat);

    this.uDist = uniform("cropDistTex", "sampler2D", this.distTex);
    this.uIdx = uniform("cropIdxTex", "sampler2D", this.idxTex);
    this.uWall = uniform("cropWallTex", "sampler2D", this.wallTex);
    this.uGrid = uniform("cropGrid", "vec4",
      new THREE.Vector4(meta.origin[0], meta.origin[1], meta.cell, this.nWalls));
    this.uGridSize = uniform("cropGridSize", "vec2",
      new THREE.Vector2(meta.width, meta.height));
    this.uFloorCeil = uniform("cropFloorCeil", "vec4",
      new THREE.Vector4(0, 0, height, 0));
    this.uFloater = uniform("cropFloater", "vec2", new THREE.Vector2(0, 0));
    this.uEnabled = uniform("cropEnabled", "float", 1.0);

    this.setParams({
      wallOffset: new Float32Array(this.nWalls),
      wallFeather: new Float32Array(this.nWalls).fill(0.25),
      floorOffset: 0, floorFeather: 0.1, ceilOffset: 0, ceilFeather: 0.25,
    });
  }

  /** Uniform-only update -- safe to call on every pointermove. */
  setParams(p) {
    for (let i = 0; i < this.nWalls; i++) {
      this.wallData[i * 2] = p.wallOffset[i] ?? 0;
      this.wallData[i * 2 + 1] = p.wallFeather[i] ?? 0;
    }
    this.wallTex.needsUpdate = true;
    this.uFloorCeil.value.set(
      0 + (p.floorOffset ?? 0),
      p.floorFeather ?? 0,
      this.roomHeight - (p.ceilOffset ?? 0),
      p.ceilFeather ?? 0,
    );
    this.uFloater.value.set(p.maxScale ?? 0, p.minOpacity ?? 0);
    this.params = p;
    this._invalidate();
  }

  setEnabled(on) {
    this.uEnabled.value = on ? 1.0 : 0.0;
    this._invalidate();
  }

  /** Override the ceiling height (IFC extrusions are often not to scale). */
  setHeight(h) {
    this.roomHeight = h;
    this.setParams(this.params); // recomputes the ceiling reference + invalidates
  }

  /**
   * SparkRenderer only re-runs the splat generator when a generator's `version` changes -- it
   * does not watch uniforms. Without this bump the panel would appear to do nothing after the
   * first build: the crop is baked into the accumulator, not evaluated per frame.
   */
  _invalidate() {
    this.mesh?.updateVersion();
  }

  /** Params in the shape server/crop.py and /api/export expect. */
  toExportCrop() {
    const p = this.params;
    return {
      wall_offset: Array.from(p.wallOffset),
      wall_feather: Array.from(p.wallFeather),
      floor_offset: p.floorOffset, floor_feather: p.floorFeather,
      ceil_offset: p.ceilOffset, ceil_feather: p.ceilFeather,
      height: this.roomHeight, // overridden ceiling height, so the export crops where you see it
      max_scale: p.maxScale ?? 0, min_opacity: p.minOpacity ?? 0,
    };
  }

  /** Attach to a SplatMesh. Recompiles the generator once. */
  attach(splatMesh) {
    this.mesh = splatMesh;
    splatMesh.worldModifier = dynoBlock(
      { gsplat: Gsplat }, { gsplat: Gsplat },
      ({ gsplat }) => {
        const out = new CropDyno({
          gsplat,
          distTex: this.uDist, idxTex: this.uIdx, wallTex: this.uWall,
          grid: this.uGrid, gridSize: this.uGridSize, floorCeil: this.uFloorCeil,
          floater: this.uFloater, enabled: this.uEnabled,
        });
        return { gsplat: out };
      },
    );
    splatMesh.updateGenerator();
    return this;
  }

  detach(splatMesh) {
    splatMesh.worldModifier = undefined;
    splatMesh.updateGenerator();
    if (this.mesh === splatMesh) this.mesh = null;
  }

  dispose() {
    this.distTex.dispose();
    this.idxTex.dispose();
    this.wallTex.dispose();
  }
}

/** Parse the packed SDF1 blob from /api/room/<id>/sdf.bin */
export function parseSdfBin(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "SDF1") throw new Error(`bad SDF magic "${magic}"`);
  const width = dv.getUint32(8, true);
  const height = dv.getUint32(12, true);
  const meta = {
    width, height,
    origin: [dv.getFloat32(16, true), dv.getFloat32(20, true)],
    cell: dv.getFloat32(24, true),
    nWalls: Math.round(dv.getFloat32(28, true)),
  };
  const n = width * height;
  const dist = new Float32Array(buf.slice(32, 32 + n * 4));
  const widx = new Float32Array(buf.slice(32 + n * 4, 32 + n * 8));
  return { meta, dist, widx };
}
