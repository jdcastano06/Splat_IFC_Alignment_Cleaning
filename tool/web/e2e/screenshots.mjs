/**
 * Produce the README screenshots by driving the real app (both servers must be up).
 *
 *   node e2e/screenshots.mjs [outDir]
 *
 * Scripts the app through `window.__e2eActions` -- the same action table the React UI calls --
 * so it survives component changes. Two flows: an IFC room aligned from a previous export's
 * real point pairs, and a live ⚡ Auto room detection.
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:5180";   // localhost, not 127.0.0.1: Next dev blocks cross-origin chunks
const API = "http://127.0.0.1:8777";
const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../docs/screenshots/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const IFC_SPLAT = "Concrete_Lab/Concrete_Lab-20260717";
const IFC_ROOM = "concrete_lab";
const AUTO_SPLAT = "Space_1/Space_1-20260701";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("  ", ...a);

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-webgl", "--use-gl=angle"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("[pageerror]", String(e)));

const act = (name, ...args) => page.evaluate(([n, a]) => window.__e2eActions[n](...a), [name, args]);
const state = () => page.evaluate(() => {
  const s = window.__e2eStore.get();
  return { stage: s.stage, busy: s.status.busy, text: s.status.text, ready: s.clean.ready,
           splatCount: s.align.splatCount, solution: !!s.align.solution, pairs: s.align.pairs.length };
});
async function waitFor(pred, { timeout = 300000, every = 500 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = await state();
    if (pred(s)) return s;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting; last state ${JSON.stringify(s)}`);
    await sleep(every);
  }
}

/**
 * Screenshots are public: replace scan / room names from the vault with Space A, B, C… in the
 * UI store only (the engine keeps the real ids, so loading and solving are unaffected).
 */
const anon = () => page.evaluate(() => {
  const st = window.__e2eStore, s = st.get();
  const L = (i) => String.fromCharCode(65 + i);
  if (!s.datasets) return;
  const splatIdx = s.datasets.splats.findIndex((x) => x.id === s.sel.splatId);
  const roomIdx = s.datasets.rooms.findIndex((x) => x.id === s.sel.roomId);
  const splats = s.datasets.splats.map((x, i) => ({ ...x, project: `Space ${L(i)}`, scan: `Space ${L(i)}` }));
  const rooms = s.datasets.rooms.map((x, i) => ({ ...x, id: `room_${L(i).toLowerCase()}`, name: `Room ${L(i)}` }));
  const roomName = roomIdx >= 0 ? rooms[roomIdx].name : `auto · Space ${L(splatIdx)}`;
  st.set({ datasets: { ...s.datasets, splats, rooms } });
  if (roomIdx >= 0) st.slice("sel", { roomId: rooms[roomIdx].id });
  st.slice("align", { roomLabel: s.align.roomLabel?.replace(/^.*?( · \d+ walls)$/, roomName + "$1") ?? null });
  st.slice("clean", { room: { ...s.clean.room, name: roomName } });
  st.slice("status", { text: s.status.text.replace(/ · .*$/, ` · ${roomName}`) });
});

const shot = async (name, settle = 6000) => {
  await sleep(settle);
  await anon();
  await page.screenshot({ path: `${OUT}${name}.png`, clip: { x: 0, y: 0, width: 1600, height: 940 } }); // trims the footer (local export path)
  log("wrote", name);
};

try {
  // ---------------------------------------------------------------- IFC flow
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__e2eStore?.get().datasets, null, { timeout: 60000 });

  await act("selectSplat", IFC_SPLAT);
  await act("selectRoom", IFC_ROOM);
  await shot("1-select", 800);

  await act("next");
  await waitFor((s) => s.stage === "align" && s.splatCount);
  await act("setSplatPoints", true);
  await sleep(2000);

  // The real pairs a person clicked for this room, from its export sidecar.
  const exports = (await (await fetch(`${API}/api/exports`)).json()).exports;
  const prev = exports.find((e) => e.splat_id === IFC_SPLAT && !e.custom_mode && e.reload?.pairs?.length);
  if (!prev) throw new Error(`no previous IFC export with pairs for ${IFC_SPLAT}`);
  await page.evaluate((pairs) => window.__e2eSetPairs(pairs), prev.reload.pairs);
  await page.evaluate(() => window.__e2eActions.fitView("splat"));
  await shot("2-align-pairs", 4000);

  await act("solve");
  await waitFor((s) => s.solution, { timeout: 60000 });
  await shot("3-align-solved", 1500);

  await act("toClean");
  await waitFor((s) => s.stage === "clean" && s.ready && !s.busy);
  await act("setCleanToggle", "cropOn", false);
  await shot("4-clean-before", 8000);
  await act("setCleanToggle", "cropOn", true);
  await shot("5-clean-cropped", 8000);
  await act("setCleanToggle", "twinOn", true);
  await act("matchFrontend");
  await shot("6-clean-twin", 6000);

  // ---------------------------------------------------------------- auto room
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__e2eStore?.get().datasets, null, { timeout: 60000 });
  await act("selectSplat", AUTO_SPLAT);
  await act("selectRoom", "__auto__");
  await act("next");
  await waitFor((s) => s.stage === "clean" && s.ready && !s.busy, { timeout: 600000 });
  await act("setCleanToggle", "showPoints", true);
  await shot("7-auto-room", 8000);
  await act("setCleanToggle", "showPoints", false);
  await act("setCleanToggle", "twinOn", true);
  await act("matchFrontend");
  await shot("8-auto-room-twin", 6000);
} finally {
  await browser.close();
}
