/**
 * App shell: three stages over one piece of state.
 *
 * Stage 2 uses two viewports side by side because before solving, the splat and the room live in
 * unrelated coordinate systems -- one merged scene would put a 3 m room somewhere inside a 90 m
 * cloud of floaters. After solving, stage 3 merges them: the splat carries the transform, so the
 * scene's world space *is* room space, which is exactly what the crop shader assumes.
 */

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { SplatMesh } from "@sparkjsdev/spark";
import { api } from "./api.js";
import { Viewport, robustBox, buildSplatPoints } from "./viewer.js";
import { RoomModel } from "./room.js";
import { FacePanel } from "./faces.js";
import { RefinePanel, PointEditor, IDENTITY_REFINE } from "./refine.js";
import { CropModifier, parseSdfBin } from "./crop-dyno.js";
import {
  buildCustomRoom, makeRoomFromFootprint, polygonSelfIntersects, customMatrixForHeight,
  insertCorner, deleteCorner, flipFootprint, flipMatrix, flipBasis, flipRefine,
} from "./customroom.js";
import { TwinPanel, loadTwinStyle } from "./twin.js";

// Rooms whose Align pane lets you click the *real* tessellated IFC solids (walls with thickness),
// not just the generated footprint wireframe. smart_lab is a plain rectangle: the box gives only 8
// corners, so aligning off features on the actual walls is far easier. The solids sit in the same
// room frame as the footprint, so picks land in room space exactly like the box corners do.
const ALIGN_ON_REAL_IFC = new Set(["smart_lab"]);

const $ = (s) => document.querySelector(s);
const el = {
  status: $("#status"), toast: $("#toast"), stages: $("#stages"),
  splatList: $("#splat-list"), roomList: $("#room-list"),
  reopenCard: $("#reopen-card"), reopenList: $("#reopen-list"),
  chosen: $("#chosen"), goAlign: $("#go-align"),
  hostSplat: $("#host-splat"), hostRoom: $("#host-room"), hostClean: $("#host-clean"),
  pairs: $("#pairs"), pairHint: $("#pair-hint"), solve: $("#solve"), solveOut: $("#solve-out"),
  yawOnly: $("#yaw-only"), goClean: $("#go-clean"),
  splatCount: $("#splat-count"), roomName: $("#room-name"), splatPoints: $("#splat-points"),
  roomHeight: $("#room-height"), roomHeightNum: $("#room-height-num"),
  faces: $("#faces"), cropOn: $("#crop-on"), showRoom: $("#show-room"), showIfc: $("#show-ifc"),
  twinOn: $("#twin-on"), twin: $("#twin"), twinState: $("#twin-state"),
  export: $("#export"), exportOut: $("#export-out"), wantSog: $("#want-sog"), saveNote: $("#save-note"),
  cleanHint: $("#clean-hint"), cleanHintShort: $("#clean-hint-short"),
  refine: $("#refine"), refineReset: $("#refine-reset"), refineState: $("#refine-state"),
  flipRoom: $("#flip-room"),
  showPoints: $("#show-points"), cleanPairs: $("#clean-pairs"),
  cleanSolveOut: $("#clean-solve-out"), pointsState: $("#points-state"),
  sectPoints: $("#sect-points"),
  alignSide: $("#align-side"), drawSide: $("#draw-side"), stageAlign: $("#stage-align"),
  roomPane: $("#room-pane"), splatPaneHint: $("#splat-pane-hint"),
  drawPointsList: $("#draw-points"), drawHeight: $("#draw-height"),
  drawHeightNum: $("#draw-height-num"), drawFlip: $("#draw-flip"),
  drawOut: $("#draw-out"), drawClean: $("#draw-clean"), drawClose: $("#draw-close"),
  drawOcclude: $("#draw-occlude"), cleanOcclude: $("#clean-occlude"),
};

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
  facePanel: null,
  refine: IDENTITY_REFINE(),   // manual nudge composed on top of the solve
  refinePanel: null,
  pointEditor: null,
  twinStyle: loadTwinStyle(),  // how the IFC/twin reads over the splat; persisted across sessions
  twinPanel: null,
  alignGizmos: null,  // {splat, room} TransformControls for moving a pair's points in Align
  alignSel: null,     // pair index currently selected for dragging in Align (null = none)
};

// ---------------------------------------------------------------- helpers

/**
 * Pair identity: the same letter AND the same colour in both panes, so "A goes with A" is
 * readable at a glance and you can see which corners you have already done.
 */
const PAIR_COLORS = [
  0xff6b5e, 0x4da3ff, 0x4dd6a8, 0xffb454, 0xc57cff, 0x2ee6d6,
  0xff8ac4, 0xa3e635, 0x38bdf8, 0xfb923c, 0x818cf8, 0xf472b6,
];
const pairColor = (i) => PAIR_COLORS[i % PAIR_COLORS.length];
const pairLabel = (i) =>
  (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + (i % 26)) + Math.floor(i / 26));
const hex = (c) => "#" + c.toString(16).padStart(6, "0");

let toastTimer;
function toast(msg, isErr = false) {
  el.toast.textContent = msg;
  el.toast.className = `toast show${isErr ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.className = "toast"), isErr ? 6000 : 3000);
}
const status = (m) => (el.status.innerHTML = m);
const mb = (b) => `${(b / 1e6).toFixed(0)} MB`;

function setStage(name) {
  S.stage = name;
  for (const s of document.querySelectorAll(".panel-stage")) {
    s.classList.toggle("active", s.id === `stage-${name}`);
  }
  for (const b of el.stages.children) b.classList.toggle("active", b.dataset.stage === name);
  // Viewports sized while hidden read 0x0; re-measure on reveal.
  requestAnimationFrame(() => Object.values(S.views).forEach((v) => v?.resize()));
}

function matrix4FromRowMajor(m) {
  // THREE.Matrix4.set() takes row-major arguments, so this maps straight across.
  return new THREE.Matrix4().set(...m);
}

// ---------------------------------------------------------------- stage 1

// The backend re-mounts the vault on its own (see server/vault.py); poll the cheap mount check
// until it's back, then re-fetch the scan list instead of leaving the picker empty.
async function waitForVault() {
  for (let attempt = 1; ; attempt++) {
    status(`<span style="color:var(--warn)">Vault not mounted — reconnecting… (attempt ${attempt})</span>`);
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
  status("Vault mounted — loading scans…");
  try {
    S.datasets = await api.datasets();
  } catch (e) {
    return toast(`Vault is back but the scan list failed: ${e.message}`, true);
  }
  renderSplats(S.datasets);
  toast("Vault reconnected");
  loadExports();
}

function renderSplats(d) {
  status(`${d.splats.length} scans · ${d.rooms.length} rooms`);
  if (el.saveNote) {
    el.saveNote.innerHTML = `Saves PLY + SOG + IFC to <b>${d.out_root}</b>`
      + (d.out_on_vault ? "" : ` <span style="color:var(--warn)">(vault not mounted — saving locally)</span>`);
  }
  el.splatList.replaceChildren();
  for (const s of d.splats) {
    const b = document.createElement("button");
    b.className = "item";
    b.innerHTML = `<div class="n">${s.project}</div>
      <div class="r">${mb(s.sog_bytes)} SOG</div>
      <div class="m">${s.scan}</div>
      <div class="r">${s.has_ply ? mb(s.ply_bytes) + " PLY" : "SOG only"}</div>`;
    if (!s.has_ply) b.title = "No gs.ply — export decodes the SOG (first export takes a little longer)";
    b.addEventListener("click", () => {
      S.splatId = s.id;
      for (const o of el.splatList.children) o.classList.remove("sel");
      b.classList.add("sel");
      refreshChosen();
    });
    el.splatList.append(b);
  }
}

async function boot() {
  try {
    S.datasets = await api.datasets();
  } catch (e) {
    status(`<span style="color:var(--warn)">API unreachable</span>`);
    return toast(`Cannot reach the backend: ${e.message}. Is uvicorn running on :8777?`, true);
  }
  const d = S.datasets;
  renderSplats(d);
  if (!d.splat_root_exists) waitForVault();

  // "No IFC" option, automatic: the room box is detected from the splat itself.
  const auto = document.createElement("button");
  auto.className = "item auto-item";
  auto.innerHTML = `<div class="n">⚡ Auto room</div>
    <div class="r">no IFC</div>
    <div class="m">detect walls, floor &amp; ceiling from the splat — straight to Clean</div>`;
  auto.addEventListener("click", () => {
    S.roomId = "__auto__";
    S.customMode = true;
    for (const o of el.roomList.children) o.classList.remove("sel");
    auto.classList.add("sel");
    refreshChosen();
  });
  el.roomList.append(auto);

  // "No IFC" option: draw the box yourself on the splat.
  const custom = document.createElement("button");
  custom.className = "item custom-item";
  custom.innerHTML = `<div class="n">✏️ Draw a custom box</div>
    <div class="r">no IFC</div>
    <div class="m">click the room's floor corners on the splat</div>`;
  custom.addEventListener("click", () => {
    S.roomId = "__custom__";
    S.customMode = true;
    for (const o of el.roomList.children) o.classList.remove("sel");
    custom.classList.add("sel");
    refreshChosen();
  });
  el.roomList.append(custom);

  for (const r of d.rooms) {
    const b = document.createElement("button");
    b.className = "item" + (r.error ? " bad" : "");
    b.innerHTML = `<div class="n">${r.name}</div>
      <div class="r">${r.error ? "unreadable" : r.area_m2 + " m²"}</div>
      <div class="m">${r.id}</div>
      <div class="r">${r.error ? "" : `${r.points} pts · h ${r.height_m} m`}</div>`;
    if (r.error) b.title = r.error;
    b.addEventListener("click", () => {
      if (r.error) return toast(r.error, true);
      S.roomId = r.id;
      S.customMode = false;
      for (const o of el.roomList.children) o.classList.remove("sel");
      b.classList.add("sel");
      refreshChosen();
    });
    el.roomList.append(b);
  }
  setStage("select");
  loadExports();
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
  let data;
  try {
    data = await api.exports();
  } catch {
    return; // no backend / no exports -> just don't show the panel
  }
  const list = data.exports ?? [];
  if (!list.length) return;
  el.reopenCard.hidden = false;
  el.reopenList.innerHTML = "";
  for (const e of list) {
    const disabled = !e.reload?.reloadable || !e.splat_available;
    const b = document.createElement("button");
    b.className = "item" + (disabled ? " bad" : "");
    const when = e.created ? new Date(e.created).toLocaleString() : "";
    const pct = e.kept_fraction != null ? ` · ${(e.kept_fraction * 100).toFixed(0)}% kept` : "";
    b.innerHTML = `<div class="n">${e.room_name}${e.custom_mode ? " ✏️" : ""}</div>
      <div class="r">${e.label}</div>
      <div class="m">${e.splat_id}</div>
      <div class="r">${when}${pct}</div>`;
    if (!e.splat_available) b.title = "Source scan not mounted — cannot reopen.";
    else if (!e.reload?.reloadable) b.title = "Predates reopen support — re-export it once to enable.";
    b.addEventListener("click", () => {
      if (disabled) return toast(b.title, true);
      reopenExport(e.reload).catch((err) => toast(err.message, true));
    });
    el.reopenList.append(b);
  }
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
    el.yawOnly.checked = !!rl.yaw_only;
    status(`<span class="spin">◐</span> loading room…`);
    S.room = await api.room(S.roomId);
  }
  // The look this export was tuned at, so reopening shows the walls you exported, not the last
  // look you happened to leave the panel on.
  if (rl.twin) S.twinStyle = { ...S.twinStyle, ...rl.twin };
  if (!rl.auto) toast(`Reopening ${rl.room_name} — restoring your clean`);
  await enterClean({ refine: rl.refine, crop: rl.crop, roomHeight: rl.room_height });
}

function refreshChosen() {
  const s = S.datasets.splats.find((x) => x.id === S.splatId);
  const roomName = S.roomId === "__auto__" ? "auto room" : S.customMode ? "custom box"
    : (S.datasets.rooms.find((x) => x.id === S.roomId)?.name ?? null);
  el.chosen.innerHTML = s || roomName
    ? `<b>${s ? s.project : "—"}</b> → <b>${roomName ?? "—"}</b>`
    : "Pick a splat and a room.";
  el.goAlign.disabled = !(S.splatId && S.roomId);
  el.goAlign.textContent = S.roomId === "__auto__" ? "Detect room → Clean"
    : S.customMode ? "Continue to Draw →" : "Continue to Align →";
}

// ---------------------------------------------------------------- stage 2

/** Show either the point-pairs panel (IFC) or the draw-a-box panel (custom). */
function setAlignMode(custom) {
  el.stageAlign.classList.toggle("custom", custom);
  el.alignSide.hidden = custom;
  el.drawSide.hidden = !custom;
  for (const b of el.stages.children) {
    if (b.dataset.stage === "align") b.querySelector("b").nextSibling.textContent = custom ? " Draw" : " Align";
  }
}

/** Load the splat into the align/draw splat pane, honouring the Points toggle. Shared. */
async function loadSplatIntoAlignPane() {
  const sv = S.views.splat;
  if (S.meshes.splatAlign) {
    sv.scene.remove(S.meshes.splatAlign);
    S.meshes.splatAlign.dispose();
  }
  const mesh = await loadSplat(api.splatSogUrl(S.splatId), sv);
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
  if (el.splatPoints.checked) applySplatPoints(true);
  el.splatCount.textContent = ` ${mesh.packedSplats.numSplats.toLocaleString()} splats`;
  return mesh;
}

/** Auto room: detect the box server-side, then open Clean exactly as a reopened custom box. */
async function enterAuto() {
  el.goAlign.disabled = true;
  status(`<span class="spin">◐</span> detecting the room from the splat… (first time per scan ≈ 1 min)`);
  try {
    const rl = await api.autoRoom(S.splatId);
    toast(`Detected a ${rl.auto.n_corners}-corner room — tweak in Clean, then Export`);
    await reopenExport(rl);
  } finally {
    el.goAlign.disabled = false;
  }
}

async function enterAlign() {
  if (S.roomId === "__auto__") return enterAuto();
  if (S.customMode) return enterDraw();
  setStage("align");
  setAlignMode(false);
  resetPairs();

  if (!S.views.room) {
    S.views.splat = new Viewport(el.hostSplat, { accent: 0xffb454 });
    S.views.room = new Viewport(el.hostRoom, { accent: 0x4dd6a8 });
  }
  // One translate-gizmo per pane, so a placed point can be nudged after the fact -- the same
  // move-after-clicking the custom Draw stage gives its corners, now for real IFC pairs too.
  // Created once and reused (the panes are), because TransformControls owns DOM listeners.
  if (!S.alignGizmos) {
    S.alignGizmos = {
      splat: makeAlignGizmo(S.views.splat, "splat"),
      room: makeAlignGizmo(S.views.room, "room"),
    };
  }

  status(`<span class="spin">◐</span> loading room…`);
  S.room = await api.room(S.roomId);
  el.roomName.textContent = ` ${S.room.name} · ${S.room.footprint.length} walls`;

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
  status(`<span class="spin">◐</span> loading splat…`);
  try {
    const mesh = await loadSplatIntoAlignPane();
    S.views.splat.onPick = (hit) => {
      if (gizmoBusy(S.alignGizmos?.splat)) return;
      addPoint("splat", hit.point, false);
    };
    status(`${mesh.packedSplats.numSplats.toLocaleString()} splats · ${S.room.name}`);
  } catch (e) {
    status(`<span style="color:var(--warn)">splat failed</span>`);
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
  setStage("align");
  setAlignMode(true);
  S.room = null;
  S.drawPoints = [];
  S.drawClosed = false;   // polygon is an open path until you click the start / press Close
  S.customMatrix = null;

  if (!S.views.splat) {
    S.views.splat = new Viewport(el.hostSplat, { accent: 0xffb454 });
    S.views.room = new Viewport(el.hostRoom, { accent: 0x4dd6a8 });
  }
  const sv = S.views.splat;

  status(`<span class="spin">◐</span> loading splat…`);
  try {
    await loadSplatIntoAlignPane();
  } catch (e) {
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
  el.splatPoints.checked = true;   // the whole point of custom is clicking the blue dots
  applySplatPoints(true);
  refreshDrawHandles();
  renderDrawPoints();
  rebuildDrawBox();
  status(`${S.meshes.splatAlign.packedSplats.numSplats.toLocaleString()} splats · draw a box`);
}

function drawHandleSize() {
  const b = S.splatBox;
  if (!b || b.isEmpty()) return 0.05;
  return Math.max(b.getSize(new THREE.Vector3()).length() * 0.01, 0.01);
}

/** Authoritative box height: the number box is unbounded; the slider is just a quick range. */
function drawH() {
  const v = Number(el.drawHeightNum.value);
  return Number.isFinite(v) && v > 0 ? v : Number(el.drawHeight.value);
}

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
  S.drawClosed = true;
  S.drawPointEditor.select(null);
  renderDrawPoints();
  rebuildDrawBox();
  if (!el.drawClean.disabled) toast("Box closed — adjust height or drag corners, then continue");
}

function renderDrawPoints() {
  el.drawPointsList.innerHTML = "";
  const closed = S.drawClosed;
  S.drawPoints.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "pair" + (S.drawPointEditor?.selected === i ? " sel" : "");
    d.style.cursor = "pointer";
    // Flag the start corner while the outline is still open, so it's obvious what closes it.
    const isStart = !closed && i === 0 && S.drawPoints.length >= 3;
    d.innerHTML = `
      <div class="idx" style="background:${hex(pairColor(i))}">${pairLabel(i)}</div>
      <div class="co">${p.map((v) => v.toFixed(2)).join(", ")}${isStart ? " · start" : ""}</div>
      <div class="res"></div>
      <button class="del" title="Remove">×</button>`;
    // Click the row -> select this corner and show its move gizmo.
    d.addEventListener("click", (e) => {
      if (e.target.closest(".del")) return;
      S.drawPointEditor.select(S.drawPointEditor.selected === i ? null : i);
      renderDrawPoints();
    });
    d.querySelector(".del").addEventListener("click", () => {
      S.drawPoints.splice(i, 1);
      if (S.drawPoints.length < 3) S.drawClosed = false; // reopened
      S.drawPointEditor.select(null);
      refreshDrawHandles();
      renderDrawPoints();
      rebuildDrawBox();
    });
    el.drawPointsList.append(d);
  });
  const n = S.drawPoints.length;
  // "Close box" appears once there are >=3 corners and the outline is still open.
  el.drawClose.hidden = closed || n < 3;
  // Continue is enabled only once a valid (closed, non-crossing) box exists.
  if (n < 3) {
    el.drawClean.disabled = true;
    el.drawOut.innerHTML = `<span>${n}/3 corners — click the floor corners around the room.</span>`;
  } else if (!closed) {
    el.drawClean.disabled = true;
    el.drawOut.innerHTML = `<span>${n} corners — click corner A again or press <b>Close box</b>.</span>`;
  }
  // when closed, rebuildDrawBox fills drawOut + toggles drawClean based on validity
}

/**
 * Draw the outline in splat space. While open it's just the perimeter polyline; once closed it's
 * the extruded box. A closed outline that crosses itself is flagged and blocks Continue.
 */
function rebuildDrawBox() {
  const sv = S.views.splat;
  if (S.meshes.drawBox) {
    sv.scene.remove(S.meshes.drawBox);
    S.meshes.drawBox.geometry.dispose();
    S.meshes.drawBox.material.dispose();
    S.meshes.drawBox = null;
  }
  const P = S.drawPoints.map((p) => new THREE.Vector3(...p));
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
    built = buildCustomRoom(P, drawH(), el.drawFlip.checked);
  } catch (e) {
    el.drawOut.innerHTML = `<span class="warn">${e.message}</span>`;
    el.drawClean.disabled = true;
    return;
  }
  S.customBuilt = built;

  const crosses = polygonSelfIntersects(built.room.footprint);
  el.drawClean.disabled = crosses;
  el.drawOut.innerHTML = crosses
    ? `<span class="warn">Edges cross — drag or delete corners so the outline doesn't self-intersect.</span>`
    : `<span class="ok">Box: ${built.room.footprint.length} walls · `
      + `${built.room.area.toFixed(2)} units² · h ${drawH().toFixed(2)}</span>`;

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
    drawH(), el.drawFlip.checked);
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

function loadSplat(url, viewport) {
  return new Promise((resolve, reject) => {
    const mesh = new SplatMesh({
      url,
      onLoad: () => resolve(mesh),
      onProgress: (p) => {
        const pct = typeof p === "number" ? p : p?.progress;
        if (typeof pct === "number") status(`<span class="spin">◐</span> splat ${Math.round(pct * 100)}%`);
      },
    });
    mesh.quaternion.set(0, 0, 0, 1);
    mesh.initialized.catch(reject);
    setTimeout(() => reject(new Error("timed out after 240 s")), 240000);
  });
}

/** Toggle the blue splat-centre overlay in the align splat pane. Builds lazily, caches. */
function applySplatPoints(on) {
  const sv = S.views.splat;
  const mesh = S.meshes.splatAlign;
  if (!sv || !mesh) return;
  if (on && !S.meshes.splatPoints) {
    status(`<span class="spin">◐</span> building point view…`);
    // Yield a frame so the spinner paints before the ~2 s forEachSplat pass blocks the thread.
    requestAnimationFrame(() => {
      const pts = buildSplatPoints(mesh);
      S.meshes.splatPoints = pts;
      if (pts && el.splatPoints.checked) sv.scene.add(pts);
      status(`${mesh.packedSplats.numSplats.toLocaleString()} splats · ${S.room?.name ?? ""} `
        + `· ${(pts?.userData.pointCount ?? 0).toLocaleString()} points`);
    });
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

/** Draggable handles are real geometry, so they do need a world size. Markers do not. */
function roomHandleSize() {
  const b = S.meshes.cleanRoom?.box ?? S.meshes.roomModel?.box;
  if (!b || b.isEmpty()) return 0.05;
  return Math.max(b.getSize(new THREE.Vector3()).length() * 0.012, 0.01);
}

function renderPairs() {
  el.pairs.innerHTML = "";
  S.pairs.forEach((p, i) => {
    const complete = p.splat && p.room;
    const d = document.createElement("div");
    d.className = "pair" + (complete ? "" : " partial") + (i === S.alignSel ? " sel" : "");
    d.title = "Click to move this pair's points; click again to deselect";
    const res = S.solution?.residuals?.[completeIndex(i)];
    const bad = res != null && res > (S.solution.rms || 0) * 2 && res > 0.05;
    d.innerHTML = `
      <div class="idx" style="background:${hex(pairColor(i))}">${pairLabel(i)}</div>
      <div class="co">${p.splat ? "splat ✓" : "splat …"} · ${p.room ? "room ✓" : "room …"}</div>
      <div class="res ${bad ? "bad" : "good"}">${res != null ? res.toFixed(3) + " m" : ""}</div>
      <button class="del" title="Remove">×</button>`;
    // Clicking the row selects it for dragging; the × still deletes (and mustn't also select).
    d.addEventListener("click", () => selectAlignPair(i));
    d.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      S.pairs.splice(i, 1);
      S.solution = null;
      clearAlignSelection();       // indices just shifted; safest to drop the selection
      redrawMarkers();
      renderPairs();
    });
    el.pairs.append(d);
  });

  const complete = S.pairs.filter((p) => p.splat && p.room);
  el.solve.disabled = complete.length < 3;
  el.pairHint.textContent = complete.length < 3
    ? `${complete.length}/3 pairs — click a feature in one pane, then the same feature in the other.`
    : `${complete.length} pairs ready. Click a pair to nudge its points.`;
  if (!S.solution) {
    el.goClean.disabled = true;
    el.solveOut.innerHTML = "";
  }
}

const completeIndex = (i) =>
  S.pairs.slice(0, i + 1).filter((p) => p.splat && p.room).length - 1;

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
  el.solve.disabled = true;
  try {
    S.solution = await api.solve(pairs, el.yawOnly.checked, S.refine, S.roomId);
  } catch (e) {
    el.solveOut.innerHTML = `<span class="warn">${e.message}</span>`;
    el.solve.disabled = false;
    return;
  }
  el.solve.disabled = false;

  const s = S.solution;
  const worst = Math.max(...s.residuals);
  const good = s.rms < 0.05;
  el.solveOut.innerHTML = `
    <div class="big ${good ? "ok" : "warn"}">RMS ${s.rms.toFixed(3)} m</div>
    <table>
      <tr><td>worst pair</td><td>${worst.toFixed(3)} m</td></tr>
      <tr><td>scale</td><td>${s.scale.toFixed(5)}×</td></tr>
      <tr><td>yaw</td><td>${((s.rotation_euler_xyz[2] * 180) / Math.PI).toFixed(1)}°</td></tr>
    </table>
    ${good ? "" : `<div class="warn" style="margin-top:5px">High RMS — check the worst pair above.</div>`}`;
  renderPairs();
  el.goClean.disabled = false;
}

// ---------------------------------------------------------------- stage 3

async function enterClean(restore = null) {
  setStage("clean");
  clearAlignSelection();   // the Align gizmos belong to the other panes; don't leave one attached
  if (!S.views.clean) S.views.clean = new Viewport(el.hostClean, { accent: 0x4dd6a8 });
  const v = S.views.clean;

  // room outline in room space (identity -- world space IS room space here)
  if (S.meshes.cleanRoom) {
    v.scene.remove(S.meshes.cleanRoom.group);
    S.meshes.cleanRoom.dispose();
  }
  // A fresh room starts un-nudged; a re-opened export restores its saved nudge.
  S.refine = restore ? normRefine(restore.refine) : IDENTITY_REFINE();
  const rm = new RoomModel(S.room);
  S.meshes.cleanRoom = rm;
  v.scene.add(rm.group);
  // Real IFC solids only exist for real IFC rooms; a custom box has none, so it is forced onto
  // generated walls and the "IFC walls" toggle goes away (the Twin toggle still drives it).
  el.showIfc.parentElement.style.display = S.customMode ? "none" : "";
  if (S.customMode) S.twinStyle.source = "generated";
  applyTwinStyle();
  if (!S.customMode) attachIfcSolid(rm);

  // Fetch the SDF *before* the splat is in the scene. Adding the mesh first would show it
  // uncropped for however long the SDF takes, then snap -- a flash of the thing you are here
  // to remove.
  status(`<span class="spin">◐</span> loading SDF…`);
  const sdfBuf = S.customMode
    ? await api.customSdf(S.room.footprint)
    : await api.sdfBin(S.roomId);
  const { meta, dist, widx } = parseSdfBin(sdfBuf);

  status(`<span class="spin">◐</span> loading splat into room space…`);
  if (S.meshes.splatClean) {
    v.scene.remove(S.meshes.splatClean);
    S.meshes.splatClean.dispose();
  }
  const mesh = await loadSplat(api.splatSogUrl(S.splatId), v);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix4FromRowMajor(S.solution.matrix4_row_major));
  mesh.matrixWorldNeedsUpdate = true;
  S.meshes.splatClean = mesh;

  // Attach the crop before the first render, so the splat is never shown uncropped.
  S.crop?.dispose();
  S.crop = new CropModifier(meta, dist, widx, S.room.height);
  S.crop.attach(mesh);
  v.scene.add(mesh);

  S.facePanel = new FacePanel(el.faces, S.room, onCleanCrop, restore?.crop);
  onCleanCrop(S.facePanel.params);
  // Inserting/deleting corners and flipping only make sense for a box we authored.
  el.flipRoom.hidden = !S.customMode;

  // ---- room height override (IFC extrusions are often not to scale)
  const h0 = restore?.roomHeight ?? S.room.height;
  S.roomHeight = h0;
  el.roomHeight.value = String(Math.min(Math.max(h0, 0.5), 8));
  el.roomHeightNum.value = h0.toFixed(2);
  // Re-apply an overridden ceiling so the crop, wireframe and (for a ceiling-anchored custom box)
  // the transform all match what was exported. No-op when the height is the room's own.
  if (Math.abs(h0 - S.room.height) > 1e-9) applyRoomHeight(h0);

  setCleanHint();

  // ---- twin preview: how the IFC will read over the splat in the frontend
  if (S.twinPanel) S.twinPanel.host.innerHTML = "";
  S.twinPanel = new TwinPanel(el.twin, S.twinStyle, () => applyTwinStyle());
  S.twinPanel.syncEnabled(S.customMode);
  applyTwinStyle();

  // ---- refine: manual nudge on top of the solve
  const size = rm.box.getSize(new THREE.Vector3()).length();
  if (S.refinePanel) S.refinePanel.host.innerHTML = "";
  S.refinePanel = new RefinePanel(el.refine, (val) => {
    S.refine = val;
    scheduleResolve();
  }, { roomSize: size });
  S.refinePanel.set(S.refine);

  // ---- draggable points. For IFC: a pair's room point (drag corrects a misclick, re-solves).
  //      For a custom box: a footprint corner (drag reshapes the box, re-bakes the SDF).
  S.pointEditor?.dispose();
  S.pointEditor = new PointEditor(v, (i, xyz) => {
    if (S.customMode) {
      S.room.footprint[i] = [xyz[0], xyz[1]]; // corners live in the floor plane (z=0)
      S.room = rebuildCustomRoomShape();
      scheduleCustomSdf();
      toast(`Corner ${pairLabel(i)} moved`);
    } else {
      const complete = S.pairs.filter((p) => p.splat && p.room);
      if (complete[i]) {
        complete[i].room = xyz;
        scheduleResolve();
        toast(`Point ${pairLabel(S.pairs.indexOf(complete[i]))} moved — re-solving`);
      }
    }
  });
  refreshPointEditor();
  el.showPoints.checked = false;
  S.pointEditor.setVisible(false);

  renderCleanPairs();
  updateRefineState();

  v.frame(rm.box, 1.8);
  status(`${mesh.packedSplats.numSplats.toLocaleString()} splats · ${S.room.name}`);
}

/**
 * Rebuild the twin geometry to the current style, then update the pane chrome.
 *
 * Separate from the chrome because the geometry only changes when the *style* does (a slider, a
 * colour, the source), while the background and lights also have to follow the *visibility*
 * toggle -- see applyTwinChrome.
 */
function applyTwinStyle() {
  const st = S.twinStyle;
  S.meshes.cleanRoom?.setTwinStyle(st);
  S.meshes.cleanRoom?.setSolidVisible(el.twinOn.checked);
  el.twinState.textContent = st.source === "generated"
    ? `generated · ${st.thickness.toFixed(2)} m walls`
    : "real IFC solids";
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
  const showing = el.twinOn.checked;
  const st = S.twinStyle;
  v.setBackground(showing ? st.bg : null);          // null -> the tool's own dark clear colour
  // The frontend's rig (ifc-viewer.tsx): ambient 1.1, key 1.6. Its scene is y-up, so the light
  // position is swizzled into this z-up world rather than copied.
  v.setLighting(showing && st.twinLight ? { ambient: 1.1, key: 1.6, keyPos: [30, -25, 50] } : null);
  el.twinState.classList.toggle("on", showing);
}

/**
 * The Twin toggle and the IFC-walls toggle drive one visibility state -- keep them in step.
 * Visibility-only: no geometry rebuild, just show/hide the solids and swap the pane chrome.
 */
function setTwinVisible(on) {
  el.twinOn.checked = on;
  el.showIfc.checked = on;
  S.meshes.cleanRoom?.setSolidVisible(on);
  applyTwinChrome();
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
    rm.setSolidVisible(el.twinOn.checked);
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
    rm.setVisible(el.showRoom.checked);
    // Generated walls follow the override (that height is what gets exported); the real IFC
    // solids don't stretch with it -- they're the building as built, so reattach at true scale.
    rm.setTwinStyle(S.twinStyle);
    if (!S.customMode && S.ifcMesh) rm.setSolid(S.ifcMesh.vertices, S.ifcMesh.indices);
    rm.setSolidVisible(el.twinOn.checked);
    if (S.facePanel) rm.setCropBoundary(S.facePanel.params, h);  // keep the resized box on rebuild
    v.scene.add(rm.group);
  }
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
  S.pointEditor.setVisible(el.showPoints.checked);
}

// Every crop change drives both the shader (what's cut) and the wireframe box (what you see cut),
// so resizing -- per wall or via Scale/Width/Height -- redraws the polygon live.
function onCleanCrop(p) {
  S.crop?.setParams(p);
  S.meshes.cleanRoom?.setCropBoundary(p, S.roomHeight ?? S.room.height);
}

/**
 * Replace a custom box's footprint with one that has a different set of walls (corner added or
 * removed, or the whole box flipped). Each new wall inherits the crop settings of `wallSrc[j]`,
 * the face panel is rebuilt for the new wall count, and the SDF re-bakes.
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
  S.facePanel = new FacePanel(el.faces, S.room, onCleanCrop, seed);
  // The live crop still holds the old SDF (old wall indices) until the re-bake lands, so only
  // the wireframe follows now; scheduleCustomSdf hands the new params to the new crop.
  S.meshes.cleanRoom?.setCropBoundary(S.facePanel.params, S.roomHeight);
  scheduleCustomSdf();
  setCleanHint();
  refreshPointEditor();
  renderCleanPairs();
}

function setCleanHint() {
  el.cleanHint.textContent =
    `${S.room.footprint.length} walls · ${S.room.area.toFixed(1)} m² · h ${S.room.height.toFixed(2)} m. `
    + `Offset trims the boundary (type past the slider for more); feather fades inside it.`;
  el.cleanHintShort.textContent = `${S.room.footprint.length} walls`;
}

/** Add a corner halfway along wall i (between corner i and the next one). */
function addCornerAfter(i) {
  const { footprint, wallSrc } = insertCorner(S.room.footprint, i);
  applyFootprintEdit(footprint, wallSrc);
  el.showPoints.checked = true;
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
  S.refinePanel?.set(S.refine);
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
    rm.setVisible(el.showRoom.checked);
    // A reshaped footprint changes the generated walls too -- rebuild them with it.
    rm.setTwinStyle(S.twinStyle);
    rm.setSolidVisible(el.twinOn.checked);
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
      : await api.solve(S.pairs.filter((p) => p.splat && p.room), el.yawOnly.checked, S.refine, S.roomId);
    const m = S.meshes.splatClean;
    if (m) {
      m.matrix.copy(matrix4FromRowMajor(S.solution.matrix4_row_major));
      m.matrixWorldNeedsUpdate = true;
      // The crop is baked into Spark's accumulator, so a moved splat must re-bake too.
      S.crop?._invalidate();
    }
    renderCleanPairs();
    updateRefineState();
  } catch (e) {
    el.cleanSolveOut.innerHTML = `<span class="warn">${e.message}</span>`;
  } finally {
    resolveBusy = false;
  }
}

function updateRefineState() {
  const nudged = S.refinePanel && !S.refinePanel.isIdentity();
  el.refineState.textContent = nudged ? "nudged" : "solved";
  el.refineState.className = nudged ? "on" : "";
}

function renderCleanPairs() {
  if (!el.cleanPairs) return;
  // Custom box: the editable points are footprint corners. IFC: they are the solved pairs.
  const rows = S.customMode
    ? S.room.footprint.map((c, i) => ({ label: pairLabel(i), color: pairColor(i),
        text: `${c[0].toFixed(2)}, ${c[1].toFixed(2)}`, res: null }))
    : S.pairs.filter((p) => p.splat && p.room).map((p, i) => {
        const gi = S.pairs.indexOf(p);
        const res = S.solution?.residuals?.[i];
        return { label: pairLabel(gi), color: pairColor(gi), text: p.room.map((v) => v.toFixed(2)).join(", "),
          res, bad: res != null && res > (S.solution.rms || 0) * 2 && res > 0.05 };
      });
  el.pointsState.textContent = `${rows.length} ${S.customMode ? "corners" : "pts"}`;
  el.cleanPairs.innerHTML = "";
  rows.forEach((row, i) => {
    const d = document.createElement("div");
    d.className = "cpair" + (S.pointEditor?.selected === i ? " sel" : "");
    d.innerHTML = `
      <div class="idx" style="background:${hex(row.color)}">${row.label}</div>
      <div class="co">${row.text}</div>
      <div class="res ${row.bad ? "bad" : "good"}">${row.res != null ? row.res.toFixed(3) + " m" : ""}</div>`;
    if (S.customMode) {
      const n = rows.length;
      const acts = document.createElement("div");
      acts.className = "cacts";
      acts.innerHTML = `
        <button class="ghost tiny" data-act="add" title="Add a corner halfway to ${pairLabel((i + 1) % n)}">+</button>
        <button class="ghost tiny" data-act="del" title="Remove this corner" ${n <= 3 ? "disabled" : ""}>×</button>`;
      acts.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        e.stopPropagation();                    // don't also select the row
        if (b.dataset.act === "add") addCornerAfter(i);
        else removeCorner(i);
      });
      d.append(acts);
    }
    d.addEventListener("click", () => {
      el.showPoints.checked = true;
      S.pointEditor.setVisible(true);
      S.pointEditor.select(i);
      renderCleanPairs();
    });
    el.cleanPairs.append(d);
  });
  if (S.solution && !S.customMode) {
    const good = S.solution.rms < 0.05;
    el.cleanSolveOut.innerHTML =
      `<div class="big ${good ? "ok" : "warn"}">RMS ${S.solution.rms.toFixed(3)} m</div>`;
  } else {
    el.cleanSolveOut.innerHTML = "";
  }
}

async function doExport() {
  el.export.disabled = true;
  el.exportOut.innerHTML = `<span class="spin">◐</span> transforming and cropping the full PLY…`;
  try {
    const body = {
      splat_id: S.splatId,
      refine: S.refine,
      crop: S.crop.toExportCrop(),
      write_sog: el.wantSog.checked,
      // The thickness you settled on in Twin preview is the thickness cleaned.ifc is authored at,
      // so what the frontend loads is the wall you were looking at here.
      wall_thickness: S.twinStyle.thickness,
      // Persisted so this export can be re-opened later. The sidecar already records the transform,
      // refine, crop and pairs; this fills what a lossless reload also needs.
      reopen: {
        yaw_only: el.yawOnly.checked,
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
      body.yaw_only = el.yawOnly.checked;
    }
    const r = await api.export(body);
    const pct = (r.kept_fraction * 100).toFixed(1);
    const sog = r.sog_result
      ? (r.sog_result.ok
        ? `<div class="ok">SOG ${mb(r.sog_result.bytes)} in ${r.sog_result.seconds}s</div>`
        : `<div class="warn">SOG failed: ${String(r.sog_result.error).slice(0, 160)}</div>`)
      : "";
    const ifc = r.ifc
      ? `<div class="ok">IFC written</div>`
      : `<div class="warn">IFC failed: ${String(r.ifc_error ?? "").slice(0, 120)}</div>`;
    // Where the files landed (directory of the sidecar).
    const dir = r.sidecar.replace(/\/[^/]+$/, "");
    el.exportOut.innerHTML = `
      <div class="ok">Kept ${r.splats_out.toLocaleString()} / ${r.splats_in.toLocaleString()} splats (${pct}%)</div>
      <div>PLY ${mb(r.bytes)} in ${r.seconds}s</div>
      ${sog}
      ${ifc}
      <div style="margin-top:4px;word-break:break-all;color:var(--dimmer)">${dir}</div>`;
    toast(`Exported to ${dir.includes("SMART_vault") ? "the vault" : dir}`);
    loadExports(); // keep the "Reopen" list current with this fresh (or overwritten) export
  } catch (e) {
    el.exportOut.innerHTML = `<span class="warn">${e.message}</span>`;
    toast(`Export failed: ${e.message}`, true);
  }
  el.export.disabled = false;
}

// ---------------------------------------------------------------- wiring

el.goAlign.addEventListener("click", () => enterAlign().catch((e) => toast(e.message, true)));
el.solve.addEventListener("click", () => solve().catch((e) => toast(e.message, true)));
el.goClean.addEventListener("click", () => enterClean().catch((e) => toast(e.message, true)));
el.export.addEventListener("click", doExport);
el.cropOn.addEventListener("change", () => S.crop?.setEnabled(el.cropOn.checked));
el.showRoom.addEventListener("change", () => S.meshes.cleanRoom?.setVisible(el.showRoom.checked));
el.showIfc.addEventListener("change", () => setTwinVisible(el.showIfc.checked));
el.twinOn.addEventListener("change", () => setTwinVisible(el.twinOn.checked));
el.showPoints.addEventListener("change", () => {
  S.pointEditor?.setVisible(el.showPoints.checked);
  renderCleanPairs();
});
el.refineReset.addEventListener("click", () => S.refinePanel?.reset());
el.flipRoom.addEventListener("click", () => flipRoomUpsideDown());
el.splatPoints.addEventListener("change", () => applySplatPoints(el.splatPoints.checked));

// Draw-a-box controls
el.drawClean.addEventListener("click", () => finishDraw().catch((e) => toast(e.message, true)));
el.drawClose.addEventListener("click", () => { if (S.drawPoints.length >= 3) closeDrawPolygon(); });
el.drawFlip.addEventListener("change", () => rebuildDrawBox());
el.drawOcclude.addEventListener("change", () => {
  S.views.splat?.setOcclude(el.drawOcclude.checked);
  refreshDrawHandles(); // rebuild handles so their depth-test matches
});
el.cleanOcclude.addEventListener("change", () => {
  S.views.clean?.setOcclude(el.cleanOcclude.checked);
  refreshPointEditor();
});
function onDrawHeight(v, from) {
  if (!Number.isFinite(v) || v <= 0) return;
  if (from !== "range") el.drawHeight.value = String(Math.min(Math.max(v, 0.2), 8));
  if (from !== "number") el.drawHeightNum.value = v.toFixed(2);
  rebuildDrawBox();
}
el.drawHeight.addEventListener("input", () => onDrawHeight(Number(el.drawHeight.value), "range"));
el.drawHeightNum.addEventListener("input", () => onDrawHeight(Number(el.drawHeightNum.value), "number"));
el.drawHeightNum.addEventListener("keydown", (e) => e.stopPropagation());

// Room height: slider and number box stay in sync; the box is authoritative (unbounded).
function onHeight(v, from) {
  if (!Number.isFinite(v) || v <= 0) return;
  if (from !== "range") el.roomHeight.value = String(Math.min(Math.max(v, 0.5), 8));
  if (from !== "number") el.roomHeightNum.value = v.toFixed(2);
  applyRoomHeight(v);
}
el.roomHeight.addEventListener("input", () => onHeight(Number(el.roomHeight.value), "range"));
el.roomHeightNum.addEventListener("input", () => onHeight(Number(el.roomHeightNum.value), "number"));
el.roomHeightNum.addEventListener("keydown", (e) => e.stopPropagation());
el.yawOnly.addEventListener("change", () => {
  if (S.solution) (S.stage === "clean" ? runResolve() : solve()).catch((e) => toast(e.message, true));
});

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
  cleanEnabled: !el.drawClean.disabled,
  closeShown: !el.drawClose.hidden,
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
window.__e2eDrawSelectRow = (i) => el.drawPointsList.children[i]?.click();
window.__e2eDrawGizmo = () => {
  const p = S.drawPointEditor;
  return p ? { selected: p.selected, attached: !!p.gizmo.object, handles: p.handles.length } : null;
};
window.__e2eBoxHeight = () => drawH();
window.__e2eOccludeState = () => {
  const v = S.stage === "clean" ? S.views.clean : S.views.splat;
  const mat = v?.markers.children[0]?.children?.[0]?.material;
  return {
    stochastic: !!v?.spark?.defaultView?.stochastic,
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
window.__e2eSetRefine = (r) => { S.refine = r; S.refinePanel?.set(r); return runResolve(); };
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
window.__e2eSetHeight = (h) => onHeight(h, "api");
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
  Object.assign(S.twinStyle, patch);
  S.twinPanel?.set(S.twinStyle);
  S.twinPanel?.syncEnabled(S.customMode);
  applyTwinStyle();
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
    hasWorldModifier: !!m.worldModifier,
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

for (const b of el.stages.children) {
  b.addEventListener("click", () => {
    const t = b.dataset.stage;
    if (t === "select") return setStage("select");
    if (t === "align" && S.splatId && S.roomId) return enterAlign().catch((e) => toast(e.message, true));
    if (t === "clean" && S.solution) return enterClean().catch((e) => toast(e.message, true));
    toast(t === "align" ? "Pick a splat and a room first."
      : (S.customMode ? "Draw a box first." : "Solve the alignment first."), true);
  });
}

boot();
