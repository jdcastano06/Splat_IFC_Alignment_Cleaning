/**
 * The UI store: the one place the headless engine (engine.js) publishes what React shows.
 *
 * State is a plain object of slices (`align`, `draw`, `clean`, ...). The engine replaces a slice
 * when something in it changes; components subscribe with a selector, so dragging a crop slider
 * re-renders the Cleaning panel, not the scan picker.
 */

import { useSyncExternalStore } from "react";
import { TWIN_DEFAULTS } from "./twin.js";

const initial = {
  stage: "select",                 // select | align | clean
  status: { text: "Loading…", busy: true, tone: "neutral" },  // tone: neutral | ok | warn
  toast: null,                     // {id, msg, err}
  datasets: null,
  exports: [],
  sel: { splatId: null, roomId: null, customMode: false },
  entering: false,                 // Continue pressed and the next stage is loading

  nav: { splat: "orbit", room: "orbit", clean: "orbit" },

  align: {
    mode: "pairs",                 // pairs (IFC) | draw (custom box)
    splatCount: null, roomLabel: null, splatPoints: false, yawOnly: true,
    pairs: [],                     // {label, color, splat:bool, room:bool, res, bad}
    selected: null,
    complete: 0,
    solution: null,                // {rms, worst, scale, yawDeg, good}
    solving: false, solveError: null,
  },

  draw: {
    points: [],                    // {label, color, text, isStart}
    closed: false, selected: null,
    height: 2.5, flip: false, occlude: false,
    msg: null,                     // {tone, text}
    canContinue: false,
  },

  clean: {
    ready: false,
    cropOn: true, showRoom: true, twinOn: false, showPoints: false, occlude: false,
    custom: false,
    refine: { scale: 1, rotation_euler_xyz: [0, 0, 0], translation: [0, 0, 0] },
    nudged: false, roomSize: 5,
    points: { rows: [], selected: null, rms: null, error: null },
    room: { walls: 0, area: 0, height: 0, name: "" },
    roomHeight: 2.5,
    facesV: 0,                     // bumped whenever the FaceModel's params change
    twin: { ...TWIN_DEFAULTS },
    wantSog: true,
    saveNote: null,                // {dir, onVault}
    exporting: false, exportResult: null, exportError: null,
  },
};

let state = initial;
const listeners = new Set();

export const store = {
  get: () => state,
  /** Shallow-merge top-level keys. */
  set(patch) {
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    for (const l of listeners) l();
  },
  /** Shallow-merge into one slice, replacing only that slice's identity. */
  slice(key, patch) {
    const cur = state[key];
    store.set({ [key]: { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) } });
  },
  subscribe(l) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** Subscribe to a slice. Selectors must return something already in state (no fresh objects). */
export function useStore(selector) {
  return useSyncExternalStore(store.subscribe, () => selector(state));
}
