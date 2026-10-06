/**
 * The headless engine: three stages over one piece of state, no DOM except the three canvas hosts.
 *
 * Stage 2 uses two viewports side by side because before solving, the splat and the room live in
 * unrelated coordinate systems -- one merged scene would put a 3 m room somewhere inside a 90 m
 * cloud of floaters. After solving, stage 3 merges them: the splat carries the transform, so the
 * scene's world space *is* room space, which is exactly what the crop shader assumes.
 *
 * Everything the user sees goes through `store` (store.js); React renders it and calls the
 * actions exported at the bottom. The 3D side (viewports, meshes, gizmos, crop) lives here in `S`.
 */

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { api } from "./api.js";
import { store } from "./store.js";
import { Viewport, robustBox, buildSplatPoints } from "./viewer.js";
import { RoomModel } from "./room.js";
import { FaceModel } from "./faces.js";
import { PointEditor, IDENTITY_REFINE, isIdentityRefine } from "./refine.js";
import { CropModifier, parseSdfBin } from "./crop-dyno.js";
import {
  buildCustomRoom, makeRoomFromFootprint, polygonSelfIntersects, customMatrixForHeight,
  insertCorner, deleteCorner, flipFootprint, flipMatrix, flipBasis, flipRefine,
} from "./customroom.js";
import { loadTwinStyle, saveTwinStyle, TWIN_DEFAULTS, TWIN_FRONTEND_BG } from "./twin.js";

// Rooms whose Align pane lets you click the *real* tessellated IFC solids (walls with thickness),
// not just the generated footprint wireframe. smart_lab is a plain rectangle: the box gives only 8
// corners, so aligning off features on the actual walls is far easier. The solids sit in the same
// room frame as the footprint, so picks land in room space exactly like the box corners do.
const ALIGN_ON_REAL_IFC = new Set(["smart_lab"]);

const S = {
  datasets: null,
  splatId: null, roomId: null,
  room: null, sdf: null,
  pairs: [],          // {splat:[x,y,z]|null, room:[x,y,z]|null}
  solution: null,     // {matrix4_row_major, rms, residuals, scale, ...}
  stage: "select",
  views: {},          // splat | room | clean
  meshes: {},
  crop: null,
  facePanel: null,    // FaceModel (kept under the old name: the e2e hooks drive it)
  refine: IDENTITY_REFINE(),   // manual nudge composed on top of the solve
  pointEditor: null,
  twinStyle: loadTwinStyle(),  // how the IFC/twin reads over the splat; persisted across sessions
  alignGizmos: null,  // {splat, room} TransformControls for moving a pair's points in Align
  alignSel: null,     // pair index currently selected for dragging in Align (null = none)
};

const ui = () => store.get();

// ---------------------------------------------------------------- helpers

/**
 * Pair identity: the same letter AND the same colour in both panes, so "A goes with A" is
 * readable at a glance and you can see which corners you have already done.
 */
export const PAIR_COLORS = [
  0xff6b5e, 0x4da3ff, 0x4dd6a8, 0xffb454, 0xc57cff, 0x2ee6d6,
  0xff8ac4, 0xa3e635, 0x38bdf8, 0xfb923c, 0x818cf8, 0xf472b6,
];
const pairColor = (i) => PAIR_COLORS[i % PAIR_COLORS.length];
const pairLabel = (i) =>
  (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + (i % 26)) + Math.floor(i / 26));
const hex = (c) => "#" + c.toString(16).padStart(6, "0");

let toastId = 0;
function toast(msg, isErr = false) {
  store.set({ toast: { id: ++toastId, msg, err: isErr } });
}
function status(text, { busy = false, tone = "neutral" } = {}) {
  store.set({ status: { text, busy, tone } });
}
const fail = (e) => toast(e.message, true);

/** Resolves after React has committed and the browser has painted (two frames). */
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/**
 * Switch stage and wait for it to be on screen. Viewports are built on the stage's canvas hosts,
 * and a host that is still display:none measures 0x0 -- Spark would initialise against that and
 * draw nothing until the next camera change -- so callers construct views only after this resolves.
 */
async function setStage(name) {
  S.stage = name;
  store.set({ stage: name });
  await nextPaint();
  // Only the visible panes render; the rest sit idle until their stage comes back.
  const live = name === "align" ? ["splat", "room"] : name === "clean" ? ["clean"] : [];
  for (const [key, v] of Object.entries(S.views)) {
    if (!v) continue;
    if (live.includes(key)) v.resume(); else v.pause();
  }
}

function matrix4FromRowMajor(m) {
  // THREE.Matrix4.set() takes row-major arguments, so this maps straight across.
  return new THREE.Matrix4().set(...m);
}

/** A viewport on one of the persistent canvas hosts React renders (#host-splat/room/clean). */
function makeView(which, accent) {
  const v = new Viewport(document.getElementById(`host-${which}`), { accent, navToggle: false });
  v.onNavChange = (mode) => store.slice("nav", { [which]: mode });
  return v;
}

function ensureAlignViews() {
  if (!S.views.splat) {
    S.views.splat = makeView("splat", 0xffb454);
    S.views.room = makeView("room", 0x4dd6a8);
  }
}

// ---------------------------------------------------------------- stage 1

// The backend re-mounts the vault on its own (see server/vault.py); poll the cheap mount check
// until it's back, then re-fetch the scan list instead of leaving the picker empty.
async function waitForVault() {
  for (let attempt = 1; ; attempt++) {
    status(`Vault not mounted — reconnecting… (attempt ${attempt})`, { busy: true, tone: "warn" });
    let v = null;
    try {
      v = await api.vault();
    } catch { /* backend restarting; keep polling */ }
    if (v?.splat_root_exists) break;
    if (attempt === 1) {
      toast(`Splat volume not mounted: ${S.datasets.splat_root}${v?.error ? ` (${v.error})` : ""} — retrying`, true);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  status("Vault mounted — loading scans…", { busy: true });
  try {
    S.datasets = await api.datasets();
  } catch (e) {
    return toast(`Vault is back but the scan list failed: ${e.message}`, true);
  }
  publishDatasets(S.datasets);
  toast("Vault reconnected");
  loadExports();
}

function publishDatasets(d) {
  status(`${d.splats.length} scans · ${d.rooms.length} rooms`, { tone: "ok" });
  store.set({ datasets: d });
  store.slice("clean", { saveNote: { dir: d.out_root, onVault: !!d.out_on_vault } });
}

async function boot() {
  try {
    S.datasets = await api.datasets();
  } catch (e) {
    status("API unreachable", { tone: "warn" });
    return toast(`Cannot reach the backend: ${e.message}. Is uvicorn running on :8777?`, true);
  }
  publishDatasets(S.datasets);
  if (!S.datasets.splat_root_exists) waitForVault();
  setStage("select");
  loadExports();
}

function selectSplat(id) {
  S.splatId = id;
  store.slice("sel", { splatId: id });
}

/** "__auto__" (detect the box), "__custom__" (draw it), or a real IFC room id. */
function selectRoom(id) {
  if (id !== "__auto__" && id !== "__custom__") {
    const r = S.datasets?.rooms.find((x) => x.id === id);
    if (r?.error) return toast(r.error, true);
  }
  S.roomId = id;
  S.customMode = id === "__auto__" || id === "__custom__";
  store.slice("sel", { roomId: id, customMode: S.customMode });
}

// ---- reopen a previous export ---------------------------------------------

const basisToJSON = (b) => b && ({
  e1: b.e1.toArray(), e2: b.e2.toArray(), up: b.up.toArray(),
  center: b.center.toArray(), fromCeiling: !!b.fromCeiling,
});
const basisFromJSON = (b) => b && ({
  e1: new THREE.Vector3(...b.e1), e2: new THREE.Vector3(...b.e2),
  up: new THREE.Vector3(...b.up), center: new THREE.Vector3(...b.center),
  fromCeiling: !!b.fromCeiling,
});
const normRefine = (r) => r
  ? { scale: r.scale ?? 1,
      rotation_euler_xyz: [...(r.rotation_euler_xyz ?? [0, 0, 0])],
      translation: [...(r.translation ?? [0, 0, 0])] }
  : IDENTITY_REFINE();

/** List previous exports (if any) as one-click entries that jump back into Clean. */
async function loadExports() {
  try {
    const data = await api.exports();
    store.set({ exports: data.exports ?? [] });
  } catch { /* no backend / no exports -> just don't show the list */ }
}

/** Reopen an entry from the exports list, explaining why when it can't be. */
function reopen(e) {
  if (!e.splat_available) return toast("Source scan not mounted — cannot reopen.", true);
  if (!e.reload?.reloadable) return toast("Predates reopen support — re-export it once to enable.", true);
  return reopenExport(e.reload).catch(fail);
}

/** Restore a previous export's state and drop straight into the Clean stage. */
async function reopenExport(rl) {
  if (!rl?.reloadable) return toast("This export can't be reopened.", true);
  S.splatId = rl.splat_id;
  S.customMode = !!rl.custom_mode;
  S.pairs = [];
  // The stored matrix is the *final* transform (refine already composed), so Clean shows exactly
  // what was exported; a later nudge re-solves from the restored pairs/box + refine.
  S.solution = {
    matrix4_row_major: rl.matrix4_row_major, rms: rl.rms ?? 0, residuals: [],
    scale: 1, rotation_euler_xyz: [0, 0, 0], translation: [0, 0, 0],
  };
  if (S.customMode) {
    S.roomId = "__custom__";
    const c = rl.custom;
    S.room = makeRoomFromFootprint(c.footprint, c.height, c.name || "custom box");
    S.customMatrix = c.matrix4_row_major;
    S.customBasis = basisFromJSON(c.basis);
  } else {
    S.roomId = rl.room_id;
    S.pairs = (rl.pairs ?? []).map((p) => ({ splat: p.splat, room: p.room }));
    store.slice("align", { yawOnly: !!rl.yaw_only });
    status("Loading room…", { busy: true });
    S.room = await api.room(S.roomId);
  }
  store.slice("sel", { splatId: S.splatId, roomId: rl.auto ? "__auto__" : S.roomId, customMode: S.customMode });
  // The look this export was tuned at, so reopening shows the walls you exported, not the last
  // look you happened to leave the panel on.
  if (rl.twin) S.twinStyle = { ...S.twinStyle, ...rl.twin };
  if (!rl.auto) toast(`Reopening ${rl.room_name} — restoring your clean`);
  await enterClean({ refine: rl.refine, crop: rl.crop, roomHeight: rl.room_height });
}

// ---------------------------------------------------------------- stage 2

/** Show either the point-pairs panel (IFC) or the draw-a-box panel (custom). */
function setAlignMode(custom) {
  store.slice("align", { mode: custom ? "draw" : "pairs" });
}

/** Load the splat into the align/draw splat pane, honouring the Points toggle. Shared. */
async function loadSplatIntoAlignPane() {
  const sv = S.views.splat;
  if (S.meshes.splatAlign) {
    sv.scene.remove(S.meshes.splatAlign);
    S.meshes.splatAlign.dispose();
  }
  store.slice("align", { splatCount: null });
  const mesh = await loadSplat(api.splatSogUrl(S.splatId));
  S.meshes.splatAlign = mesh;
  sv.scene.add(mesh);
  sv.pickTargets = [mesh];
  S.splatBox = robustBox(mesh);
  sv.frame(S.splatBox, 1.2);
  if (S.meshes.splatPoints) {
    sv.scene.remove(S.meshes.splatPoints);
    S.meshes.splatPoints.geometry.dispose();
    S.meshes.splatPoints.material.dispose();
    S.meshes.splatPoints = null;
  }
  if (ui().align.splatPoints) applySplatPoints(true);
  store.slice("align", { splatCount: mesh.packedSplats.numSplats });
  return mesh;
}

/** Continue from Select: Auto detects then opens Clean; custom draws; an IFC room aligns. */
async function enterNext() {
  store.set({ entering: true });
  try {
    await enterAlign();
  } finally {
    store.set({ entering: false });
  }
}

/** Auto room: detect the box server-side, then open Clean exactly as a reopened custom box. */
async function enterAuto() {
  status("Detecting the room from the splat… (first time per scan ≈ 1 min)", { busy: true });
  const rl = await api.autoRoom(S.splatId);
  toast(`Detected a ${rl.auto.n_corners}-corner room — tweak in Clean, then Export`);
  await reopenExport(rl);
}

async function enterAlign() {
  if (S.roomId === "__auto__") return enterAuto();
  if (S.customMode) return enterDraw();
  await setStage("align");
  setAlignMode(false);
  ensureAlignViews();
  resetPairs();

  // One translate-gizmo per pane, so a placed point can be nudged after the fact -- the same
  // move-after-clicking the custom Draw stage gives its corners, now for real IFC pairs too.
  // Created once and reused (the panes are), because TransformControls owns DOM listeners.
  if (!S.alignGizmos) {
    S.alignGizmos = {
      splat: makeAlignGizmo(S.views.splat, "splat"),
      room: makeAlignGizmo(S.views.room, "room"),
    };
  }

  status("Loading room…", { busy: true });
  S.room = await api.room(S.roomId);
  store.slice("align", { roomLabel: `${S.room.name} · ${S.room.footprint.length} walls` });

  // room pane
  const rv = S.views.room;
  if (S.meshes.roomModel) {
    rv.scene.remove(S.meshes.roomModel.group);
    S.meshes.roomModel.dispose();
  }
  const rm = new RoomModel(S.room);
  S.meshes.roomModel = rm;
  rv.scene.add(rm.group);
  rv.pickTargets = [rm.pickMesh];
  rv.frame(rm.box);
  rv.onPick = (hit) => {
    if (gizmoBusy(S.alignGizmos?.room)) return; // grabbing the gizmo, not dropping a new point
    const { point, snapped } = rm.snap(hit.point, rv);
    addPoint("room", point, snapped);
  };

  // smart_lab: show the real tessellated IFC (solid, opaque walls) in the room pane and make it
  // clickable, so you can pick features off the actual walls rather than only the footprint box.
  if (ALIGN_ON_REAL_IFC.has(S.roomId)) {
    try {
      if (!S.ifcMesh || S.ifcMesh.roomId !== S.roomId) {
        const m = await api.roomMesh(S.roomId);
        S.ifcMesh = { roomId: S.roomId, ...m };
      }
      rm.setTwinStyle({ ...S.twinStyle, source: "ifc", shading: "solid" });
      const solid = rm.setSolid(S.ifcMesh.vertices, S.ifcMesh.indices);
      rm.setSolidVisible(true);
      if (solid) {
        // Pick against a dedicated invisible MESH of the real IFC triangles -- not the visible
        // `solid` group. That group also carries edge LineSegments, and line raycasting uses a ~1 m
        // threshold, so a stray edge (a desk, a column) grabs the click instead of the wall surface
        // -- the "random" placement, worst when you fly in close among the geometry. Nor the
        // footprint shell (rm.pickMesh), whose invisible ceiling cap would catch the ray up high.
        // A mesh-only, double-sided target drops the point exactly on the surface you click, from
        // either side of a wall. No corner snap: snapping is to the 8 box corners, which would fight
        // clicking arbitrary features on the actual geometry.
        const pg = new THREE.BufferGeometry();
        pg.setAttribute("position", new THREE.Float32BufferAttribute(S.ifcMesh.vertices, 3));
        pg.setIndex(S.ifcMesh.indices);
        const pickMesh = new THREE.Mesh(
          pg, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false }),
        );
        rm.group.add(pickMesh);
        rv.pickTargets = [pickMesh];
        rv.onPick = (hit) => {
          if (gizmoBusy(S.alignGizmos?.room)) return;
          addPoint("room", hit.point.clone(), false);
        };
      }
    } catch (e) {
      toast(`Could not load IFC solids for alignment: ${e.message}`, true);
    }
  }

  // splat pane
  status("Loading splat…", { busy: true });
  try {
    const mesh = await loadSplatIntoAlignPane();
    S.views.splat.onPick = (hit) => {
      if (gizmoBusy(S.alignGizmos?.splat)) return;
      addPoint("splat", hit.point, false);
    };
    status(`${mesh.packedSplats.numSplats.toLocaleString()} splats · ${S.room.name}`, { tone: "ok" });
  } catch (e) {
    status("Splat failed to load", { tone: "warn" });
    toast(`Could not load the splat: ${e.message}`, true);
  }
}

// ---- Align: move a placed point after clicking --------------------------------------------
// The custom Draw stage lets you select a corner and drag it; these give the real-IFC panes the
// same. Selection comes from the sidebar pair list (a bare click in a pane still *adds* a point),
// which is exactly how the Draw stage disambiguates the two.

/** True while the pointer is grabbing a gizmo axis, so pane clicks don't also add a point. */
const gizmoBusy = (g) => !!g && (g.dragging || g.axis != null);

/** A translate gizmo for one pane; dragging its handle rewrites that side of the pair. */
function makeAlignGizmo(view, side) {
  const g = new TransformControls(view.camera, view.renderer.domElement);
  g.setMode("translate");
  g.setSpace("world");
  g.addEventListener("dragging-changed", (e) => {
    view.controls.enabled = !e.value;           // don't orbit while dragging a handle
    if (!e.value && g.object) applyAlignMove(side, g.object.userData.pairIndex, g.object.position.toArray());
  });
  const helper = g.getHelper ? g.getHelper() : g;
  view.scene.add(helper);
  return g;
}

/** The marker Group for pair `i` in a pane, or null (partial pairs lack one side). */
function alignMarker(view, i) {
  if (i == null) return null;
  return view?.markers.children.find((m) => m.userData.pairIndex === i) ?? null;
}

/** Point each pane's gizmo at the selected pair's marker (or detach if that side isn't placed). */
function attachAlignGizmos() {
  const attach = (g, obj) => { if (g) obj ? g.attach(obj) : g.detach(); };
  attach(S.alignGizmos?.splat, alignMarker(S.views.splat, S.alignSel));
  attach(S.alignGizmos?.room, alignMarker(S.views.room, S.alignSel));
}

/** Select a pair for dragging (click its row again to deselect). */
function selectAlignPair(i) {
  S.alignSel = S.alignSel === i ? null : i;
  attachAlignGizmos();
  renderPairs();
}

function clearAlignSelection() {
  S.alignSel = null;
  S.alignGizmos?.splat?.detach();
  S.alignGizmos?.room?.detach();
}

/** Commit a dragged point: rewrite the pair, invalidate the (now stale) solve, refresh the list. */
function applyAlignMove(side, pairIndex, xyz) {
  if (pairIndex == null || !S.pairs[pairIndex]) return;
  S.pairs[pairIndex][side] = xyz;
  S.solution = null;             // the fit no longer matches the points; re-solve
  renderPairs();
  toast(`Point ${pairLabel(pairIndex)} moved — re-solve`);
}

// ---- draw-your-own-box (no IFC) ------------------------------------------

async function enterDraw() {
  await setStage("align");
  setAlignMode(true);
  ensureAlignViews();
  S.room = null;
  S.drawPoints = [];
  S.drawClosed = false;   // polygon is an open path until you click the start / press Close
  S.customMatrix = null;
  S.customBuilt = null;
  const sv = S.views.splat;

  status("Loading splat…", { busy: true });
  try {
    await loadSplatIntoAlignPane();
  } catch (e) {
    status("Splat failed to load", { tone: "warn" });
    return toast(`Could not load the splat: ${e.message}`, true);
  }
  sv.clearMarkers();

  // A gizmo-backed editor: the corners are draggable handles (like the Clean stage), and clicking
  // a corner in the sidebar selects it so you can move it -- not only delete-and-re-click.
  S.drawPointEditor?.dispose();
  S.drawPointEditor = new PointEditor(sv, (i, xyz) => {
    S.drawPoints[i] = xyz;
    renderDrawPoints();
    rebuildDrawBox();     // move updates the box live
  }, { clickSelect: false });   // clicks add corners; selection comes from the sidebar
  S.drawPointEditor.onSelect = () => store.slice("draw", { selected: S.drawPointEditor.selected });

  // Clicking the splat adds a corner along the perimeter. Clicking the first corner again (once
  // there are >=3) closes the polygon into a box -- so you trace a proper, non-crossing outline
  // instead of an auto-closed shape that can cross itself.
  sv.onPick = (hit) => {
    if (S.drawPointEditor?.overGizmo) return;
    if (S.drawClosed) return; // closed: edit corners by dragging / deleting, not by adding
    if (S.drawPoints.length >= 3 && nearStartCorner(hit.point)) {
      closeDrawPolygon();
    } else {
      addDrawPoint(hit.point);
    }
  };
  store.slice("align", { splatPoints: true });   // the whole point of custom is clicking the blue dots
  applySplatPoints(true);
  refreshDrawHandles();
  renderDrawPoints();
  rebuildDrawBox();
  status(`${S.meshes.splatAlign.packedSplats.numSplats.toLocaleString()} splats · draw a box`, { tone: "ok" });
}

function drawHandleSize() {
  const b = S.splatBox;
  if (!b || b.isEmpty()) return 0.05;
  return Math.max(b.getSize(new THREE.Vector3()).length() * 0.01, 0.01);
}

/** Authoritative box height (the number box is unbounded; the slider is just a quick range). */
const drawH = () => ui().draw.height;

/** Rebuild the draggable corner handles from S.drawPoints, preserving the selection. */
function refreshDrawHandles() {
  if (!S.drawPointEditor) return;
  const sel = S.drawPointEditor.selected;
  S.drawPointEditor.setPoints(S.drawPoints, drawHandleSize(),
    (i) => pairColor(i), (i) => pairLabel(i));
  if (sel != null && sel < S.drawPoints.length) S.drawPointEditor.select(sel);
}

function addDrawPoint(point) {
  S.drawPoints.push([point.x, point.y, point.z]);
  refreshDrawHandles();
  S.drawPointEditor.select(S.drawPoints.length - 1); // newest is ready to nudge
  renderDrawPoints();
  rebuildDrawBox();
}

/** Is a clicked point close (on screen) to the first corner? Used to close the polygon. */
function nearStartCorner(point) {
  const sv = S.views.splat;
  const start = new THREE.Vector3(...S.drawPoints[0]);
  return sv.toScreen(start).distanceTo(sv.toScreen(point)) < 22;
}

/** Close the traced outline into a box (with a self-intersection guard). */
function closeDrawPolygon() {
  if (S.drawPoints.length < 3) return;
  S.drawClosed = true;
  S.drawPointEditor.select(null);
  renderDrawPoints();
  rebuildDrawBox();
  if (ui().draw.canContinue) toast("Box closed — adjust height or drag corners, then continue");
}

function selectDrawPoint(i) {
  if (!S.drawPointEditor) return;
  S.drawPointEditor.select(S.drawPointEditor.selected === i ? null : i);
  renderDrawPoints();
}

function deleteDrawPoint(i) {
  S.drawPoints.splice(i, 1);
  if (S.drawPoints.length < 3) S.drawClosed = false; // reopened
  S.drawPointEditor.select(null);
  refreshDrawHandles();
  renderDrawPoints();
  rebuildDrawBox();
}

function renderDrawPoints() {
  const closed = S.drawClosed;
  const n = S.drawPoints.length;
  const points = S.drawPoints.map((p, i) => ({
    label: pairLabel(i), color: hex(pairColor(i)),
    text: p.map((v) => v.toFixed(2)).join(", "),
    // Flag the start corner while the outline is still open, so it's obvious what closes it.
    isStart: !closed && i === 0 && n >= 3,
  }));
  const patch = { points, closed, selected: S.drawPointEditor?.selected ?? null };
  // Continue is enabled only once a valid (closed, non-crossing) box exists; when closed,
  // rebuildDrawBox fills the message and the flag based on validity.
  if (n < 3) {
    Object.assign(patch, { canContinue: false,
      msg: { tone: "neutral", text: `${n}/3 corners — click the floor corners around the room.` } });
  } else if (!closed) {
    Object.assign(patch, { canContinue: false,
      msg: { tone: "neutral", text: `${n} corners — click corner A again or press Close box.` } });
  }
  store.slice("draw", patch);
}

/**
 * Draw the outline in splat space. While open it's just the perimeter polyline; once closed it's
 * the extruded box. A closed outline that crosses itself is flagged and blocks Continue.
 */
function rebuildDrawBox() {
  const sv = S.views.splat;
  if (!sv) return;
  if (S.meshes.drawBox) {
    sv.scene.remove(S.meshes.drawBox);
    S.meshes.drawBox.geometry.dispose();
    S.meshes.drawBox.material.dispose();
    S.meshes.drawBox = null;
  }
  const P = (S.drawPoints ?? []).map((p) => new THREE.Vector3(...p));
  if (P.length < 2) return;

  const seg = [];
  const push = (a, b) => seg.push(a.x, a.y, a.z, b.x, b.y, b.z);

  if (!S.drawClosed) {
    // open perimeter path: v0-v1-...-vN, no closing edge, no extrusion
    for (let i = 0; i < P.length - 1; i++) push(P[i], P[i + 1]);
    S.customBuilt = null;
    S.meshes.drawBox = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(seg, 3)),
      new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.9 }));
    S.meshes.drawBox.renderOrder = 6;
    sv.scene.add(S.meshes.drawBox);
    return;
  }

  // closed: build the box
  let built;
  try {
    built = buildCustomRoom(P, drawH(), ui().draw.flip);
  } catch (e) {
    store.slice("draw", { canContinue: false, msg: { tone: "warn", text: e.message } });
    return;
  }
  S.customBuilt = built;

  const crosses = polygonSelfIntersects(built.room.footprint);
  store.slice("draw", {
    canContinue: !crosses,
    msg: crosses
      ? { tone: "warn", text: "Edges cross — drag or delete corners so the outline doesn't self-intersect." }
      : { tone: "ok", text: `${built.room.footprint.length} walls · ${built.room.area.toFixed(2)} units² · h ${drawH().toFixed(2)}` },
  });

  // Extrude toward the room: up from a clicked floor, DOWN from a clicked ceiling.
  const ext = built.up.clone().multiplyScalar(drawH() * (built.fromCeiling ? -1 : 1));
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    push(a, b);
    push(a.clone().add(ext), b.clone().add(ext));
    push(a, a.clone().add(ext));
  }
  S.meshes.drawBox = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(seg, 3)),
    new THREE.LineBasicMaterial({ color: crosses ? 0xff6b5e : 0x4dd6a8, transparent: true, opacity: 0.9 }));
  S.meshes.drawBox.renderOrder = 6;
  sv.scene.add(S.meshes.drawBox);
}

async function finishDraw() {
  if (!S.customBuilt) return;
  const built = buildCustomRoom(
    S.drawPoints.map((p) => new THREE.Vector3(...p)),
    drawH(), ui().draw.flip);
  S.room = built.room;
  S.customMatrix = built.matrix4;
  // Keep the basis so a Room-height change in Clean can re-anchor a ceiling box (floor moves,
  // ceiling stays under the clicked points).
  S.customBasis = { e1: built.e1, e2: built.e2, up: built.up, center: built.center,
    fromCeiling: built.fromCeiling };
  S.solution = { matrix4_row_major: built.matrix4, rms: 0, residuals: [], scale: 1,
    rotation_euler_xyz: [0, 0, 0], translation: [0, 0, 0] };
  await enterClean();
}

function loadSplat(url) {
  return new Promise((resolve, reject) => {
    const mesh = new SplatMesh({
      url,
      // The API URL has no extension and Spark 2.x sniffs the type from the first streamed
      // chunk -- our gs.sog zips put meta.json last, so the sniff never sees it. Say so.
      fileType: SplatFileType.PCSOGSZIP,
      onLoad: () => resolve(mesh),
      onProgress: (p) => {
        const pct = typeof p === "number" ? p : p?.progress;
        if (typeof pct === "number") status(`Loading splat… ${Math.round(pct * 100)}%`, { busy: true });
      },
    });
    mesh.quaternion.set(0, 0, 0, 1);
    mesh.initialized.catch((e) => {
      window.__lastSplatError = e;   // e2e / debugging: Spark rejects with non-Error values too
      reject(e instanceof Error ? e : new Error(String(e?.message ?? e ?? "unknown load error")));
    });
    setTimeout(() => reject(new Error("timed out after 240 s")), 240000);
  });
}

/** Toggle the blue splat-centre overlay in the align splat pane. Builds lazily, caches. */
function applySplatPoints(on) {
  const sv = S.views.splat;
  const mesh = S.meshes.splatAlign;
  if (!sv || !mesh) return;
  if (on && !S.meshes.splatPoints) {
    status("Building point view…", { busy: true });
    // Yield a frame so the spinner paints before the ~2 s forEachSplat pass blocks the thread.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const pts = buildSplatPoints(mesh);
      S.meshes.splatPoints = pts;
      if (pts && ui().align.splatPoints) sv.scene.add(pts);
      status(`${mesh.packedSplats.numSplats.toLocaleString()} splats · `
        + `${(pts?.userData.pointCount ?? 0).toLocaleString()} points`, { tone: "ok" });
    }));
    return;
  }
  if (S.meshes.splatPoints) {
    if (on) sv.scene.add(S.meshes.splatPoints);
    else sv.scene.remove(S.meshes.splatPoints);
  }
}

function resetPairs() {
  S.pairs = [];
  S.solution = null;
  clearAlignSelection();
  S.views.splat?.clearMarkers();
  S.views.room?.clearMarkers();
  renderPairs();
}

/** Fill the open slot, or start a new pair. Order doesn't matter. */
function addPoint(side, point, snapped) {
  let p = S.pairs.find((q) => q[side] === null);
  if (!p) {
    p = { splat: null, room: null };
    S.pairs.push(p);
  }
  p[side] = [point.x, point.y, point.z];

  const view = side === "splat" ? S.views.splat : S.views.room;
  const i = S.pairs.indexOf(p);
  const marker = view.addMarker(point, pairLabel(i), pairColor(i));
  marker.userData.pairIndex = i;                 // so a gizmo can find and drag it later
  if (snapped) toast(`Point ${pairLabel(i)} snapped to corner`);
  renderPairs();
}

function deletePair(i) {
  S.pairs.splice(i, 1);
  S.solution = null;
  clearAlignSelection();       // indices just shifted; safest to drop the selection
  redrawMarkers();
  renderPairs();
}

/** Draggable handles are real geometry, so they do need a world size. Markers do not. */
function roomHandleSize() {
  const b = S.meshes.cleanRoom?.box ?? S.meshes.roomModel?.box;
  if (!b || b.isEmpty()) return 0.05;
  return Math.max(b.getSize(new THREE.Vector3()).length() * 0.012, 0.01);
}

const completeIndex = (i) =>
  S.pairs.slice(0, i + 1).filter((p) => p.splat && p.room).length - 1;

function renderPairs() {
  const pairs = S.pairs.map((p, i) => {
    const res = p.splat && p.room ? S.solution?.residuals?.[completeIndex(i)] : null;
    return {
      label: pairLabel(i), color: hex(pairColor(i)),
      splat: !!p.splat, room: !!p.room,
      res: res ?? null,
      bad: res != null && res > (S.solution.rms || 0) * 2 && res > 0.05,
    };
  });
  const s = S.solution;
  store.slice("align", {
    pairs,
    selected: S.alignSel,
    complete: S.pairs.filter((p) => p.splat && p.room).length,
    solution: s?.residuals?.length ? {
      rms: s.rms, worst: Math.max(...s.residuals), scale: s.scale,
      yawDeg: (s.rotation_euler_xyz[2] * 180) / Math.PI, good: s.rms < 0.05,
    } : null,
    solveError: null,
  });
}

function redrawMarkers() {
  // Rebuilding the marker groups orphans any attached gizmo, so drop the selection first, then
  // re-tag and re-attach to whatever the selected pair became.
  S.alignGizmos?.splat?.detach();
  S.alignGizmos?.room?.detach();
  S.views.splat.clearMarkers();
  S.views.room.clearMarkers();
  S.pairs.forEach((p, i) => {
    if (p.splat) S.views.splat.addMarker(new THREE.Vector3(...p.splat), pairLabel(i), pairColor(i)).userData.pairIndex = i;
    if (p.room) S.views.room.addMarker(new THREE.Vector3(...p.room), pairLabel(i), pairColor(i)).userData.pairIndex = i;
  });
  attachAlignGizmos();
}

/** Solve (and compose the manual refine) on the server -- the export runs the same code. */
async function solve() {
  const pairs = S.pairs.filter((p) => p.splat && p.room);
  store.slice("align", { solving: true });
  try {
    S.solution = await api.solve(pairs, ui().align.yawOnly, S.refine, S.roomId);
  } catch (e) {
    store.slice("align", { solving: false, solveError: e.message });
    return;
  }
  store.slice("align", { solving: false });
  renderPairs();
}

// ---------------------------------------------------------------- stage 3

async function enterClean(restore = null) {
  await setStage("clean");
  store.slice("clean", { ready: false, exportResult: null, exportError: null });
  clearAlignSelection();   // the Align gizmos belong to the other panes; don't leave one attached
  if (!S.views.clean) S.views.clean = makeView("clean", 0x4dd6a8);
  const v = S.views.clean;
  const c0 = ui().clean;

  // room outline in room space (identity -- world space IS room space here)
  if (S.meshes.cleanRoom) {
    v.scene.remove(S.meshes.cleanRoom.group);
    S.meshes.cleanRoom.dispose();
  }
  // A fresh room starts un-nudged; a re-opened export restores its saved nudge.
  S.refine = restore ? normRefine(restore.refine) : IDENTITY_REFINE();
  const rm = new RoomModel(S.room);
  S.meshes.cleanRoom = rm;
  rm.setVisible(c0.showRoom);
  v.scene.add(rm.group);
  // Show the *new* room straight away -- header, framing, an empty crop panel -- rather than the
  // previous one lingering for however long the SDF and splat take to arrive.
  S.facePanel = null;
  S.roomHeight = restore?.roomHeight ?? S.room.height;
  publishRoomInfo();
  store.slice("clean", { roomHeight: S.roomHeight, points: { rows: [], selected: null, rms: null, error: null } });
  v.frame(rm.box, 1.8);
  // Real IFC solids only exist for real IFC rooms; a custom box has none, so it is forced onto
  // generated walls and the "IFC walls" toggle goes away (the Twin toggle still drives it).
  if (S.customMode) S.twinStyle.source = "generated";
  store.slice("clean", { custom: !!S.customMode });
  applyTwinStyle();
  if (!S.customMode) attachIfcSolid(rm);

  // Fetch the SDF *before* the splat is in the scene. Adding the mesh first would show it
  // uncropped for however long the SDF takes, then snap -- a flash of the thing you are here
  // to remove.
  status("Loading SDF…", { busy: true });
  const sdfBuf = S.customMode
    ? await api.customSdf(S.room.footprint)
    : await api.sdfBin(S.roomId);
  const { meta, dist, widx } = parseSdfBin(sdfBuf);

  status("Loading splat into room space…", { busy: true });
  if (S.meshes.splatClean) {
    v.scene.remove(S.meshes.splatClean);
    S.meshes.splatClean.dispose();
  }
  const mesh = await loadSplat(api.splatSogUrl(S.splatId));
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix4FromRowMajor(S.solution.matrix4_row_major));
  mesh.matrixWorldNeedsUpdate = true;
  S.meshes.splatClean = mesh;

  // Attach the crop before the first render, so the splat is never shown uncropped.
  S.crop?.dispose();
  S.crop = new CropModifier(meta, dist, widx, S.room.height);
  S.crop.attach(mesh);
  v.scene.add(mesh);

  S.facePanel = new FaceModel(S.room, onCleanCrop, restore?.crop);
  onCleanCrop(S.facePanel.params);
  S.crop.setEnabled(c0.cropOn);

  // ---- room height override (IFC extrusions are often not to scale)
  const h0 = restore?.roomHeight ?? S.room.height;
  S.roomHeight = h0;
  store.slice("clean", { roomHeight: h0 });
  // Re-apply an overridden ceiling so the crop, wireframe and (for a ceiling-anchored custom box)
  // the transform all match what was exported. No-op when the height is the room's own.
  if (Math.abs(h0 - S.room.height) > 1e-9) applyRoomHeight(h0);

  publishRoomInfo();
  applyTwinStyle();

  // ---- refine: manual nudge on top of the solve
  const size = rm.box.getSize(new THREE.Vector3()).length();
  store.slice("clean", { roomSize: size });
  publishRefine();

  // ---- draggable points. For IFC: a pair's room point (drag corrects a misclick, re-solves).
  //      For a custom box: a footprint corner (drag reshapes the box, re-bakes the SDF).
  S.pointEditor?.dispose();
  S.pointEditor = new PointEditor(v, (i, xyz) => {
    if (S.customMode) {
      S.room.footprint[i] = [xyz[0], xyz[1]]; // corners live in the floor plane (z=0)
      S.room = rebuildCustomRoomShape();
      scheduleCustomSdf();
      publishRoomInfo();
      toast(`Corner ${pairLabel(i)} moved`);
    } else {
      const complete = S.pairs.filter((p) => p.splat && p.room);
      if (complete[i]) {
        complete[i].room = xyz;
        scheduleResolve();
        toast(`Point ${pairLabel(S.pairs.indexOf(complete[i]))} moved — re-solving`);
      }
    }
    renderCleanPairs();
  });
  S.pointEditor.onSelect = () => renderCleanPairs();
  refreshPointEditor();
  store.slice("clean", { showPoints: false });
  S.pointEditor.setVisible(false);
  v.setOcclude(c0.occlude);

  renderCleanPairs();

  store.slice("clean", { ready: true });
  status(`${mesh.packedSplats.numSplats.toLocaleString()} splats · ${S.room.name}`, { tone: "ok" });
}

function publishRoomInfo() {
  store.slice("clean", {
    room: { walls: S.room.footprint.length, area: S.room.area, height: S.room.height, name: S.room.name },
    facesV: ui().clean.facesV + 1,
  });
}

function publishRefine() {
  const r = S.refine;
  store.slice("clean", {
    refine: { scale: r.scale, rotation_euler_xyz: [...r.rotation_euler_xyz], translation: [...r.translation] },
    nudged: !isIdentityRefine(r),
  });
}

function publishTwin() {
  store.slice("clean", { twin: { ...S.twinStyle } });
}

/**
 * Rebuild the twin geometry to the current style, then update the pane chrome.
 *
 * Separate from the chrome because the geometry only changes when the *style* does (a slider, a
 * colour, the source), while the background and lights also have to follow the *visibility*
 * toggle -- see applyTwinChrome.
 */
function applyTwinStyle() {
  S.meshes.cleanRoom?.setTwinStyle(S.twinStyle);
  S.meshes.cleanRoom?.setSolidVisible(ui().clean.twinOn);
  publishTwin();
  applyTwinChrome();
}

/**
 * Background + light rig, gated on whether the twin is actually shown.
 *
 * The frontend renders shaded solids on #242424; matching that is the whole point of the preview.
 * But the *clean stage itself* -- aligning, cropping, editing points -- is done on the tool's dark
 * background under flat light, and forcing the frontend look on it when the twin is hidden would
 * change how every one of those tasks reads (and, incidentally, break the ink-based crop tests).
 * So: frontend look only while the twin is visible; tool defaults otherwise.
 *
 * The splat is left alone either way -- gaussian splats carry baked lighting, so the rig only
 * changes how the solids read, which is exactly the comparison this view exists to make.
 */
function applyTwinChrome() {
  const v = S.views.clean;
  if (!v) return;
  const showing = ui().clean.twinOn;
  const st = S.twinStyle;
  v.setBackground(showing ? st.bg : null);          // null -> the tool's own dark clear colour
  // The frontend's rig (ifc-viewer.tsx): ambient 1.1, key 1.6. Its scene is y-up, so the light
  // position is swizzled into this z-up world rather than copied.
  v.setLighting(showing && st.twinLight ? { ambient: 1.1, key: 1.6, keyPos: [30, -25, 50] } : null);
}

/** Show/hide the IFC/twin solids. Visibility-only: no geometry rebuild, just the pane chrome. */
function setTwinVisible(on) {
  store.slice("clean", { twinOn: on });
  S.meshes.cleanRoom?.setSolidVisible(on);
  applyTwinChrome();
}

/** Patch the twin look; every control writes here and the walls follow live. */
function setTwinStyle(patch) {
  Object.assign(S.twinStyle, patch);
  saveTwinStyle(S.twinStyle);
  applyTwinStyle();
}

function resetTwinStyle() {
  setTwinStyle({ ...TWIN_DEFAULTS, source: S.twinStyle.source });
}

/** Solid shading on the digital-twin background, edges off -- how the frontend renders it. */
function matchFrontend() {
  setTwinStyle({ shading: "solid", opacity: 1, edges: false, bg: TWIN_FRONTEND_BG,
    twinLight: true, floorSlab: true });
}

/**
 * Load the real IFC solids for the current room (cached) and attach them to a RoomModel. The
 * solids show the true wall thickness -- independent of the height override, which is a crop
 * adjustment, not a change to the real geometry.
 */
async function attachIfcSolid(rm) {
  try {
    if (!S.ifcMesh || S.ifcMesh.roomId !== S.roomId) {
      const m = await api.roomMesh(S.roomId);
      S.ifcMesh = { roomId: S.roomId, ...m };
    }
    if (S.meshes.cleanRoom !== rm) return; // stage moved on while we fetched
    rm.setTwinStyle(S.twinStyle);
    rm.setSolid(S.ifcMesh.vertices, S.ifcMesh.indices);
    rm.setSolidVisible(ui().clean.twinOn);
  } catch (e) {
    toast(`Could not load IFC solids: ${e.message}`, true);
  }
}

/**
 * Apply an overridden ceiling height: move the crop's ceiling plane, rebuild the room wireframe
 * so the box matches, relabel the Ceiling control, and remember it for export.
 */
function applyRoomHeight(h) {
  h = Math.max(h, 0.1);
  S.roomHeight = h;
  S.crop?.setHeight(h);
  S.facePanel?.setHeight(h);

  // A ceiling box is anchored at the clicked ceiling (z = height). Changing the height must move
  // the FLOOR, not the ceiling, so re-derive the transform and re-apply it to the splat.
  if (S.customMode && S.customBasis?.fromCeiling) {
    S.customMatrix = customMatrixForHeight(S.customBasis, h);
    runResolve();
  }

  const v = S.views.clean;
  if (v && S.meshes.cleanRoom) {
    v.scene.remove(S.meshes.cleanRoom.group);
    S.meshes.cleanRoom.dispose();
    const rm = new RoomModel({ ...S.room, height: h });
    S.meshes.cleanRoom = rm;
    rm.setVisible(ui().clean.showRoom);
    // Generated walls follow the override (that height is what gets exported); the real IFC
    // solids don't stretch with it -- they're the building as built, so reattach at true scale.
    rm.setTwinStyle(S.twinStyle);
    if (!S.customMode && S.ifcMesh) rm.setSolid(S.ifcMesh.vertices, S.ifcMesh.indices);
    rm.setSolidVisible(ui().clean.twinOn);
    if (S.facePanel) rm.setCropBoundary(S.facePanel.params, h);  // keep the resized box on rebuild
    v.scene.add(rm.group);
  }
  store.slice("clean", { facesV: ui().clean.facesV + 1 });
}

/** Room height from the panel: slider and number box share this; the value is unbounded. */
function setRoomHeight(v) {
  if (!Number.isFinite(v) || v <= 0) return;
  store.slice("clean", { roomHeight: v });
  applyRoomHeight(v);
}

function refreshPointEditor() {
  if (!S.pointEditor) return;
  if (S.customMode) {
    // Footprint corners at floor level (z=0). Dragging one reshapes the box.
    S.pointEditor.setPoints(
      S.room.footprint.map(([x, y]) => [x, y, 0]),
      roomHandleSize(), (i) => pairColor(i), (i) => pairLabel(i));
  } else {
    const complete = S.pairs.filter((p) => p.splat && p.room);
    S.pointEditor.setPoints(
      complete.map((p) => p.room), roomHandleSize(),
      (i) => pairColor(S.pairs.indexOf(complete[i])),
      (i) => pairLabel(S.pairs.indexOf(complete[i])));
  }
  S.pointEditor.setVisible(ui().clean.showPoints);
}

// Every crop change drives both the shader (what's cut) and the wireframe box (what you see cut),
// so resizing -- per wall or via Scale/Width/Depth -- redraws the polygon live.
function onCleanCrop(p) {
  S.crop?.setParams(p);
  S.meshes.cleanRoom?.setCropBoundary(p, S.roomHeight ?? S.room.height);
  store.slice("clean", { facesV: ui().clean.facesV + 1 });
}

/**
 * Replace a custom box's footprint with one that has a different set of walls (corner added or
 * removed, or the whole box flipped). Each new wall inherits the crop settings of `wallSrc[j]`,
 * the face model is rebuilt for the new wall count, and the SDF re-bakes.
 */
function applyFootprintEdit(footprint, wallSrc, { swapFloorCeil = false } = {}) {
  const old = S.facePanel.params;
  const seed = {
    wall_offset: wallSrc.map((k) => old.wallOffset[k]),
    wall_feather: wallSrc.map((k) => old.wallFeather[k]),
    floor_offset: swapFloorCeil ? old.ceilOffset : old.floorOffset,
    floor_feather: swapFloorCeil ? old.ceilFeather : old.floorFeather,
    ceil_offset: swapFloorCeil ? old.floorOffset : old.ceilOffset,
    ceil_feather: swapFloorCeil ? old.floorFeather : old.ceilFeather,
    max_scale: old.maxScale, min_opacity: old.minOpacity,
  };
  S.room.footprint = footprint;
  S.room = rebuildCustomRoomShape();
  S.facePanel = new FaceModel(S.room, onCleanCrop, seed);
  S.facePanel.setHeight(S.roomHeight);
  // The live crop still holds the old SDF (old wall indices) until the re-bake lands, so only
  // the wireframe follows now; scheduleCustomSdf hands the new params to the new crop.
  S.meshes.cleanRoom?.setCropBoundary(S.facePanel.params, S.roomHeight);
  scheduleCustomSdf();
  publishRoomInfo();
  refreshPointEditor();
  renderCleanPairs();
}

/** Add a corner halfway along wall i (between corner i and the next one). */
function addCornerAfter(i) {
  const { footprint, wallSrc } = insertCorner(S.room.footprint, i);
  applyFootprintEdit(footprint, wallSrc);
  store.slice("clean", { showPoints: true });
  S.pointEditor.setVisible(true);
  S.pointEditor.select(i + 1);                 // straight onto the new corner, ready to drag
  renderCleanPairs();
  toast(`Corner added between ${pairLabel(i)} and ${pairLabel((i + 1) % (footprint.length - 1))} — drag it into place`);
}

function removeCorner(i) {
  if (S.room.footprint.length <= 3) return toast("A room needs at least 3 corners.", true);
  const { footprint, wallSrc } = deleteCorner(S.room.footprint, i);
  if (polygonSelfIntersects(footprint)) {
    return toast(`Removing ${pairLabel(i)} would make the walls cross — move it first.`, true);
  }
  applyFootprintEdit(footprint, wallSrc);
  toast(`Corner ${pairLabel(i)} removed`);
}

/**
 * Turn an upside-down scan the right way up, together with its box. The splat, the footprint,
 * the per-wall crop, floor/ceiling settings and any nudge all flip as one, so the same splats stay
 * inside the crop -- only which side is up changes. Flipping twice restores the original exactly.
 */
function flipRoomUpsideDown() {
  if (!S.customMode) return;
  const H = S.roomHeight ?? S.room.height;
  S.customMatrix = flipMatrix(S.customMatrix, H);
  S.customBasis = flipBasis(S.customBasis, H);
  S.refine = flipRefine(S.refine);
  publishRefine();
  const { footprint, wallSrc } = flipFootprint(S.room.footprint);
  applyFootprintEdit(footprint, wallSrc, { swapFloorCeil: true });
  runResolve();                                 // re-applies the flipped transform to the splat
  toast("Flipped upside down — box flipped with it");
}

/** Rebuild walls/area from an edited footprint and redraw the wireframe box. */
function rebuildCustomRoomShape() {
  const room = makeRoomFromFootprint(S.room.footprint, S.roomHeight, S.room.name);
  S.room = room;
  const v = S.views.clean;
  if (v && S.meshes.cleanRoom) {
    v.scene.remove(S.meshes.cleanRoom.group);
    S.meshes.cleanRoom.dispose();
    const rm = new RoomModel(room);
    S.meshes.cleanRoom = rm;
    rm.setVisible(ui().clean.showRoom);
    // A reshaped footprint changes the generated walls too -- rebuild them with it.
    rm.setTwinStyle(S.twinStyle);
    rm.setSolidVisible(ui().clean.twinOn);
    v.scene.add(rm.group);
  }
  return room;
}

/** Re-bake the custom SDF after a footprint edit and swap it into the crop. Debounced. */
let customSdfTimer = null;
function scheduleCustomSdf() {
  clearTimeout(customSdfTimer);
  customSdfTimer = setTimeout(async () => {
    try {
      const { meta, dist, widx } = parseSdfBin(await api.customSdf(S.room.footprint));
      const mesh = S.meshes.splatClean;
      S.crop?.dispose();
      S.crop = new CropModifier(meta, dist, widx, S.roomHeight);
      S.crop.attach(mesh);
      S.crop.setParams(S.facePanel.params);
      S.crop.setEnabled(ui().clean.cropOn);
    } catch (e) {
      toast(`SDF rebuild failed: ${e.message}`, true);
    }
  }, 120);
}

/** Re-solve is a network round trip; coalesce slider spam into one in-flight request. */
let resolveTimer = null;
let resolveBusy = false;
function scheduleResolve() {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(() => runResolve(), 60);
}

async function runResolve() {
  if (resolveBusy) return scheduleResolve();
  if (!S.customMode && S.pairs.filter((p) => p.splat && p.room).length < 3) return;
  resolveBusy = true;
  try {
    // Custom boxes have no pairs -- the base transform is fixed; the server just composes refine.
    S.solution = S.customMode
      ? await api.solveCustom(S.customMatrix, S.refine, S.roomHeight)
      : await api.solve(S.pairs.filter((p) => p.splat && p.room), ui().align.yawOnly, S.refine, S.roomId);
    const m = S.meshes.splatClean;
    if (m) {
      m.matrix.copy(matrix4FromRowMajor(S.solution.matrix4_row_major));
      m.matrixWorldNeedsUpdate = true;
      // The crop is baked into Spark's accumulator, so a moved splat must re-bake too.
      S.crop?._invalidate();
    }
    renderCleanPairs();
    publishRefine();
  } catch (e) {
    store.slice("clean", { points: { ...ui().clean.points, error: e.message } });
  } finally {
    resolveBusy = false;
  }
}

/** The manual nudge from the Refine panel (degrees already converted to radians). */
function setRefine(value) {
  S.refine = value;
  publishRefine();
  scheduleResolve();
}

function resetRefine() {
  setRefine(IDENTITY_REFINE());
}

function renderCleanPairs() {
  if (S.stage !== "clean" || !S.room) return;
  // Custom box: the editable points are footprint corners. IFC: they are the solved pairs.
  const rows = S.customMode
    ? S.room.footprint.map((c, i) => ({ label: pairLabel(i), color: hex(pairColor(i)),
        text: `${c[0].toFixed(2)}, ${c[1].toFixed(2)}`, res: null, bad: false }))
    : S.pairs.filter((p) => p.splat && p.room).map((p, i) => {
        const gi = S.pairs.indexOf(p);
        const res = S.solution?.residuals?.[i];
        return { label: pairLabel(gi), color: hex(pairColor(gi)), text: p.room.map((v) => v.toFixed(2)).join(", "),
          res: res ?? null, bad: res != null && res > (S.solution.rms || 0) * 2 && res > 0.05 };
      });
  store.slice("clean", {
    points: {
      rows,
      selected: S.pointEditor?.selected ?? null,
      rms: S.solution && !S.customMode ? S.solution.rms : null,
      error: null,
    },
  });
}

function selectCleanPoint(i) {
  if (!S.pointEditor) return;
  store.slice("clean", { showPoints: true });
  S.pointEditor.setVisible(true);
  S.pointEditor.select(S.pointEditor.selected === i ? null : i);
  renderCleanPairs();
}

/** The toggle bar over the Clean viewport. */
function setCleanToggle(key, on) {
  store.slice("clean", { [key]: on });
  if (key === "cropOn") S.crop?.setEnabled(on);
  else if (key === "showRoom") S.meshes.cleanRoom?.setVisible(on);
  else if (key === "twinOn") setTwinVisible(on);
  else if (key === "showPoints") {
    S.pointEditor?.setVisible(on);
    renderCleanPairs();
  } else if (key === "occlude") {
    S.views.clean?.setOcclude(on);
    refreshPointEditor();
  }
}

async function doExport() {
  store.slice("clean", { exporting: true, exportResult: null, exportError: null });
  status("Transforming and cropping the full PLY…", { busy: true });
  try {
    const yawOnly = ui().align.yawOnly;
    const body = {
      splat_id: S.splatId,
      refine: S.refine,
      crop: S.crop.toExportCrop(),
      write_sog: ui().clean.wantSog,
      // The thickness you settled on in Twin preview is the thickness cleaned.ifc is authored at,
      // so what the frontend loads is the wall you were looking at here.
      wall_thickness: S.twinStyle.thickness,
      // Persisted so this export can be re-opened later. The sidecar already records the transform,
      // refine, crop and pairs; this fills what a lossless reload also needs.
      reopen: {
        yaw_only: yawOnly,
        twin: { ...S.twinStyle },
        ...(S.customMode ? {
          custom: {
            footprint: S.room.footprint,
            matrix4_row_major: S.customMatrix,
            basis: basisToJSON(S.customBasis),
          },
        } : {}),
      },
    };
    if (S.customMode) {
      // The client authored the box; send it verbatim so the export matches the preview exactly.
      body.custom = {
        footprint: S.room.footprint,
        height: S.roomHeight,
        matrix4_row_major: S.customMatrix,
        name: S.room.name,
      };
    } else {
      body.room_id = S.roomId;
      body.pairs = S.pairs.filter((p) => p.splat && p.room);
      body.yaw_only = yawOnly;
    }
    const r = await api.export(body);
    // Where the files landed (directory of the sidecar).
    const dir = r.sidecar.replace(/\/[^/]+$/, "");
    store.slice("clean", {
      exportResult: {
        kept: r.splats_out, total: r.splats_in, pct: r.kept_fraction * 100,
        plyBytes: r.bytes, seconds: r.seconds,
        sog: r.sog_result ? { ok: r.sog_result.ok, bytes: r.sog_result.bytes,
          seconds: r.sog_result.seconds, error: String(r.sog_result.error ?? "").slice(0, 160) } : null,
        ifc: r.ifc ? { ok: true } : { ok: false, error: String(r.ifc_error ?? "").slice(0, 120) },
        dir,
      },
    });
    status(`Exported ${r.splats_out.toLocaleString()} splats`, { tone: "ok" });
    toast(`Exported to ${dir.includes("SMART_vault") ? "the vault" : dir}`);
    loadExports(); // keep the "Reopen" list current with this fresh (or overwritten) export
  } catch (e) {
    store.slice("clean", { exportError: e.message });
    status("Export failed", { tone: "warn" });
    toast(`Export failed: ${e.message}`, true);
  } finally {
    store.slice("clean", { exporting: false });
  }
}

// ---------------------------------------------------------------- stage navigation

function goStage(t) {
  if (t === "select") return void setStage("select");
  if (t === "align" && S.splatId && S.roomId && S.roomId !== "__auto__") return enterAlign().catch(fail);
  if (t === "clean" && S.solution) return enterClean().catch(fail);
  toast(t === "align" ? (S.roomId === "__auto__" ? "Auto room goes straight to Clean." : "Pick a splat and a room first.")
    : (S.customMode ? "Draw a box first." : "Solve the alignment first."), true);
}

// ---------------------------------------------------------------- actions (called by React)

export const actions = {
  selectSplat, selectRoom, reopen,
  next: () => enterNext().catch(fail),
  goStage,
  // align
  setYawOnly(on) {
    store.slice("align", { yawOnly: on });
    if (S.solution) (S.stage === "clean" ? runResolve() : solve()).catch(fail);
  },
  setSplatPoints(on) {
    store.slice("align", { splatPoints: on });
    applySplatPoints(on);
  },
  selectPair: selectAlignPair,
  deletePair,
  clearPairs: () => resetPairs(),
  solve: () => solve().catch(fail),
  toClean: () => enterClean().catch(fail),
  // draw
  selectDrawPoint, deleteDrawPoint,
  closeDraw: () => closeDrawPolygon(),
  setDrawHeight(v) {
    if (!Number.isFinite(v) || v <= 0) return;
    store.slice("draw", { height: v });
    rebuildDrawBox();
  },
  setDrawFlip(on) {
    store.slice("draw", { flip: on });
    rebuildDrawBox();
  },
  setDrawOcclude(on) {
    store.slice("draw", { occlude: on });
    S.views.splat?.setOcclude(on);
    refreshDrawHandles(); // rebuild handles so their depth-test matches
  },
  finishDraw: () => finishDraw().catch(fail),
  // clean
  setCleanToggle, setRoomHeight, setRefine, resetRefine,
  setTwinStyle, resetTwinStyle, matchFrontend,
  selectCleanPoint, addCornerAfter, removeCorner,
  flip: () => flipRoomUpsideDown(),
  setWantSog: (on) => store.slice("clean", { wantSog: on }),
  export: () => doExport(),
  // viewports
  setNav: (which, mode) => S.views[which]?.setNavMode(mode),
  fitView: (which) => S.views[which]?.reframe(),
  /** The live FaceModel for the Cleaning panel (mutable; re-render on clean.facesV). */
  faces: () => S.facePanel,
};

export function start() {
  boot();
}

// ---------------------------------------------------------------- e2e hooks

/**
 * Test hooks for e2e/drive.mjs. __e2eSetPairs places pairs through the same addPoint() path a
 * click uses, so the driver exercises the real code rather than a parallel one. __e2eSplatBox
 * lets the driver synthesise a *plausible* alignment (splat core -> room) rather than an
 * arbitrary one that would throw the cloud kilometres away and crop to nothing.
 */
window.__e2eSetPairs = (pairs) => {
  resetPairs();
  for (const p of pairs) {
    addPoint("splat", new THREE.Vector3(...p.splat), false);
    addPoint("room", new THREE.Vector3(...p.room), false);
  }
};
// Align point-editing hooks: select a pair, inspect its gizmos, drive a drag end-to-end.
window.__e2eAlignSelect = (i) => selectAlignPair(i);
window.__e2eAlignGizmo = (side) => {
  const g = S.alignGizmos?.[side];
  return g ? { attached: !!g.object, pairIndex: g.object?.userData.pairIndex ?? null } : null;
};
window.__e2eAlignMove = (side, xyz) => {
  const g = S.alignGizmos?.[side];
  if (!g?.object) throw new Error(`no ${side} marker selected`);
  g.object.position.set(...xyz);                 // as a gizmo drag would
  applyAlignMove(side, g.object.userData.pairIndex, xyz);
  const pi = g.object.userData.pairIndex;
  return { pair: S.pairs[pi]?.[side], solutionCleared: S.solution === null };
};
window.__e2eSplatBox = () => (S.splatBox && !S.splatBox.isEmpty()
  ? { min: S.splatBox.min.toArray(), max: S.splatBox.max.toArray() }
  : null);
window.__e2eRoom = () => S.room;
// Custom-box hooks: add a floor corner exactly as a splat click would, then inspect the box.
window.__e2eAddDrawPoint = (xyz) => addDrawPoint(new THREE.Vector3(...xyz));
window.__e2eDrawState = () => ({
  points: S.drawPoints?.length ?? 0,
  closed: !!S.drawClosed,
  boxBuilt: !!S.customBuilt,
  cleanEnabled: ui().draw.canContinue,
  closeShown: !S.drawClosed && (S.drawPoints?.length ?? 0) >= 3,
  footprint: S.customBuilt?.room.footprint.length ?? 0,
  fromCeiling: !!S.customBuilt?.fromCeiling,
});
window.__e2eCloseDraw = () => closeDrawPolygon();
window.__e2eMoveFootprint = (i, xyz) => {
  S.room.footprint[i] = [xyz[0], xyz[1]];
  S.room = rebuildCustomRoomShape();
  scheduleCustomSdf();
};
// Draw-stage corner editing: select from the sidebar, inspect the gizmo, move a corner.
window.__e2eDrawSelectRow = (i) => selectDrawPoint(i);
window.__e2eDrawGizmo = () => {
  const p = S.drawPointEditor;
  return p ? { selected: p.selected, attached: !!p.gizmo.object, handles: p.handles.length } : null;
};
window.__e2eBoxHeight = () => drawH();
window.__e2eOccludeState = () => {
  const v = S.stage === "clean" ? S.views.clean : S.views.splat;
  const mat = v?.markers.children[0]?.children?.[0]?.material;
  return {
    stochastic: !!v?.spark?.material?.depthWrite,
    occlude: !!v?.occlude,
    markersDepthTest: mat ? mat.depthTest : (S.drawPointEditor?.handles[0]?.children[0]?.material.depthTest ?? null),
  };
};
window.__e2eDrawMove = (i, xyz) => {
  // Drive the exact onMoved path a gizmo-drag fires: move the handle, then call back.
  const h = S.drawPointEditor.handles[i];
  h.position.set(...xyz);
  S.drawPointEditor.onMoved(i, xyz);
};
window.__e2eCropParams = () => S.crop?.toExportCrop();
// Corner add/remove + flip: the custom box's state, and a way to set one wall's crop like a slider.
window.__e2eCustom = () => ({
  footprint: S.room?.footprint, matrix: S.customMatrix, refine: S.refine,
  fromCeiling: S.customBasis?.fromCeiling ?? null, height: S.roomHeight,
  panelWalls: S.facePanel?.n, wallOffset: Array.from(S.facePanel?.params.wallOffset ?? []),
  floorOffset: S.facePanel?.params.floorOffset, ceilOffset: S.facePanel?.params.ceilOffset,
});
window.__e2eSetFace = (key, i, v) => {
  const p = S.facePanel.params;
  if (i == null) p[key] = v; else p[key][i] = v;
  S.facePanel.onChange(p);
};
window.__e2eSetRefine = (r) => { setRefine(r); return runResolve(); };
window.__e2eMarkerCount = (which) => S.views[which]?.markers.children.length ?? -1;
window.__e2eGizmo = () => {
  const p = S.pointEditor;
  if (!p) return { error: "no point editor" };
  let inScene = false;
  S.views.clean.scene.traverse((o) => { if (o === p._helper) inScene = true; });
  return {
    handles: p.handles.length,
    visible: p.handles[0]?.visible ?? null,
    selected: p.selected,
    attached: !!p.gizmo.object,
    inScene,
    gizmoVisible: p._helper?.visible ?? null,
  };
};
window.__e2eCam = (which) => S.views[which]?.camera.position.toArray();
window.__e2eMatrix = () => S.solution?.matrix4_row_major;
window.__e2eRms = () => S.solution?.rms;
window.__e2ePointCloud = () => (S.meshes.splatPoints
  ? { inScene: !!S.meshes.splatPoints.parent, points: S.meshes.splatPoints.userData.pointCount }
  : null);
window.__e2eSetHeight = (h) => setRoomHeight(h);
window.__e2eRoomCornerZ = () => S.meshes.cleanRoom?.box?.max.z ?? null;
window.__e2eIfcSolid = () => {
  // A Group of [mesh, edge lines] per part -- one part for the real IFC solids, up to three
  // (walls, floor slab, ceiling slab) for generated walls.
  const s = S.meshes.cleanRoom?.solid;
  if (!s) return null;
  // Wire shading draws edges only, so fall back to the line segments for the measurements.
  const meshes = s.children.filter((c) => c.isMesh);
  const parts = meshes.length ? meshes : s.children.filter((c) => c.isLineSegments);
  if (!parts.length) return null;
  const box = new THREE.Box3();
  let tris = 0;
  for (const m of parts) {
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox);
    // Generated walls are non-indexed (flat faces need unshared vertices).
    tris += (m.geometry.index?.count ?? m.geometry.getAttribute("position").count) / 3;
  }
  return {
    visible: s.visible,
    tris,
    zMax: box.max.z,
    hasEdges: s.children.some((c) => c.isLineSegments),
    source: S.twinStyle.source,
    thickness: S.twinStyle.thickness,
    parts: parts.length,
    faces: meshes.length,
  };
};
window.__e2eSetTwinStyle = (patch) => {
  setTwinStyle(patch);
  return S.twinStyle;
};
/** Move pair `i`'s room point exactly as a gizmo drag would, and re-solve. */
window.__e2eMovePoint = (i, xyz) => {
  const complete = S.pairs.filter((p) => p.splat && p.room);
  if (!complete[i]) throw new Error(`no pair ${i}`);
  complete[i].room = xyz;
  if (S.pointEditor?.handles[i]) S.pointEditor.handles[i].position.set(...xyz);
  return runResolve();
};
window.__e2eDebug = () => {
  const m = S.meshes.splatClean, c = S.crop;
  if (!m || !c) return { error: "clean stage not ready" };
  // Where do a few splats actually land in world space, and what does the CPU mirror say?
  const box = new THREE.Box3();
  let n = 0;
  m.forEachSplat((i, center) => {
    if (i % 200000) return;
    box.expandByPoint(center.clone().applyMatrix4(m.matrixWorld));
    n++;
  });
  return {
    hasWorldModifier: (m.worldModifiers?.length ?? 0) > 0,
    numSplats: m.packedSplats.numSplats,
    matrixWorld: m.matrixWorld.elements.map((v) => +v.toFixed(4)),
    sampledWorldBox: { min: box.min.toArray().map((v) => +v.toFixed(3)),
                       max: box.max.toArray().map((v) => +v.toFixed(3)), n },
    grid: c.uGrid.value.toArray(),
    gridSize: c.uGridSize.value.toArray(),
    floorCeil: c.uFloorCeil.value.toArray(),
    enabled: c.uEnabled.value,
    wallData: Array.from(c.wallData.slice(0, 8)),
    distTexSize: [c.distTex.image.width, c.distTex.image.height],
    distStats: (() => {
      const d = c.distTex.image.data;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < d.length; i += 97) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
      return [+mn.toFixed(3), +mx.toFixed(3)];
    })(),
  };
};

// The whole action table and the store, for drivers that script the app the way the UI does
// (e2e/screenshots.mjs) instead of poking at component DOM.
window.__e2eActions = actions;
window.__e2eStore = store;
