/**
 * End-to-end: drive the real app in Chrome and watch it actually work.
 *
 * This is the check that matters for the preview path -- the parity tests pin the *formula*,
 * but only a real GPU proves the dyno graph compiles and the crop shader runs. Uses the
 * installed Chrome (channel: "chrome") so no browser download is needed.
 *
 *   node e2e/drive.mjs [roomId] [splatIndex]
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const ROOM = process.argv[2] ?? "libra_lab";
const SPLAT_IDX = Number(process.argv[3] ?? 0);
const BASE = "http://127.0.0.1:5180";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log("  ", ...a);
const errors = [];
let failed = false;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
  return ok;
}

/**
 * Wait until a viewport stops changing.
 *
 * Spark regenerates its splat accumulator asynchronously; for 5.3M splats that takes seconds
 * (longer still under software GL). Fixed sleeps here produced false passes *and* false
 * failures, so poll until two consecutive ink readings agree.
 */
async function waitStable(page, selector, { eps = 0.002, tries = 40, gap = 700 } = {}) {
  let prev = -1;
  for (let i = 0; i < tries; i++) {
    const v = await inkFraction(page, selector);
    if (Math.abs(v - prev) <= eps) return v;
    prev = v;
    await page.waitForTimeout(gap);
  }
  return prev;
}

/**
 * Fraction of pixels that differ between two screenshots.
 *
 * Ink fraction answers "how much is drawn"; it is blind to a rotation that moves content
 * without changing coverage. This answers "did the picture change".
 */
async function diffFraction(page, a, b) {
  return page.evaluate(async ([da, db]) => {
    const load = async (d) => {
      const img = new Image();
      img.src = "data:image/png;base64," + d;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, c.width, c.height).data;
    };
    const [pa, pb] = [await load(da), await load(db)];
    if (pa.length !== pb.length) return 1;
    let n = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (Math.abs(pa[i] - pb[i]) > 12 || Math.abs(pa[i + 1] - pb[i + 1]) > 12
        || Math.abs(pa[i + 2] - pb[i + 2]) > 12) n++;
    }
    return n / (pa.length / 4);
  }, [a.toString("base64"), b.toString("base64")]);
}

/**
 * Fraction of a viewport's pixels that are not the clear colour, measured by drawing the
 * element's screenshot into a 2D canvas. Counts real composited output.
 */
async function inkFraction(page, selector) {
  const buf = await page.locator(selector).screenshot({ timeout: 180000 });
  const b64 = buf.toString("base64");
  return page.evaluate(async (d) => {
    const img = new Image();
    img.src = "data:image/png;base64," + d;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const px = x.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) {
      // clear colour is #0d1013
      if (Math.abs(px[i] - 13) > 10 || Math.abs(px[i + 1] - 16) > 10 || Math.abs(px[i + 2] - 19) > 10) ink++;
    }
    return ink / (px.length / 4);
  }, b64);
}

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--enable-webgl"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") errors.push(t);
  if (/spark|webgl|shader|gl_|GLSL/i.test(t)) log("[console]", t.slice(0, 300));
});
page.on("pageerror", (e) => errors.push(String(e)));

try {
  // ---- stage 1: select
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#splat-list .item", { timeout: 20000 });

  const webgl2 = await page.evaluate(() =>
    !!document.createElement("canvas").getContext("webgl2"));
  check("WebGL2 available", webgl2);

  const nSplats = await page.locator("#splat-list .item").count();
  const nRooms = await page.locator("#room-list .item:not(.custom-item):not(.auto-item)").count();
  const hasCustom = await page.locator("#room-list .custom-item").count();
  const hasAuto = await page.locator("#room-list .auto-item").count();
  const wantRooms = (await (await fetch("http://127.0.0.1:8777/api/datasets")).json()).rooms.length;
  // Splat and room counts are environment-dependent (the vault gains scans, IFC/ gains rooms).
  check("datasets listed", nSplats >= 5 && nRooms === wantRooms && hasCustom === 1 && hasAuto === 1,
    `${nSplats} splats, ${nRooms}/${wantRooms} rooms, custom=${hasCustom}, auto=${hasAuto}`);

  await page.locator("#splat-list .item").nth(SPLAT_IDX).click();
  await page.locator(`#room-list .item:has(.m:text-is("${ROOM}"))`).click();
  await page.screenshot({ path: `${SHOTS}1-select.png` });
  check("continue enabled", !(await page.locator("#go-align").isDisabled()));

  // ---- stage 2: align
  await page.locator("#go-align").click();
  log("loading splat (this streams the SOG)…");
  await page.waitForFunction(
    () => /splats/.test(document.querySelector("#splat-count")?.textContent ?? ""),
    { timeout: 300000 },
  );
  const countTxt = await page.locator("#splat-count").textContent();
  check("splat loaded", /[\d,]+ splats/.test(countTxt), countTxt.trim());
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}2-align.png` });

  // Measure the actual composited pixels. (readPixels on the live canvas is unreliable without
  // preserveDrawingBuffer -- it silently returns garbage, which happily "passes" any check.)
  const splatInk = await inkFraction(page, "#host-splat");
  const roomInk = await inkFraction(page, "#host-room");
  check("splat pane renders content", splatInk > 0.02 && splatInk < 0.95,
    `${(splatInk * 100).toFixed(1)}% ink`);
  check("room pane renders content", roomInk > 0.002 && roomInk < 0.95,
    `${(roomInk * 100).toFixed(1)}% ink`);

  // ---- pairs.
  // A user clicks matching features; a driver can't recognise them. So synthesise a *known*
  // similarity and require the solver to recover it exactly. Crucially the transform must be
  // plausible -- it maps the splat's dense core onto the room -- because an arbitrary one throws
  // the cloud kilometres away, the crop deletes everything, and every downstream visual check
  // then passes on an empty frame.
  const truth = await page.evaluate(() => {
    const box = window.__e2eSplatBox();
    const room = window.__e2eRoom();
    if (!box) throw new Error("no splat box");

    const fp = room.footprint;
    const rx = fp.map((p) => p[0]), ry = fp.map((p) => p[1]);
    const roomSize = Math.max(Math.max(...rx) - Math.min(...rx), Math.max(...ry) - Math.min(...ry));
    const splatSize = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]);

    const s = roomSize / splatSize;                 // core -> room footprint
    const th = 0.6;                                 // an arbitrary but recoverable yaw
    const cx = (box.min[0] + box.max[0]) / 2;
    const cy = (box.min[1] + box.max[1]) / 2;
    const cz = box.min[2];

    const c = Math.cos(th), sn = Math.sin(th);
    // splat -> room: scale, yaw about Z, then centre the core on the room with floor at z=0
    const fwd = (p) => {
      const x = p[0] - cx, y = p[1] - cy, z = p[2] - cz;
      return [s * (c * x - sn * y), s * (sn * x + c * y), s * z];
    };

    // Four well-spread source points inside the core; their images define the same transform.
    const P = [
      [box.min[0], box.min[1], box.min[2]],
      [box.max[0], box.min[1], box.min[2]],
      [box.max[0], box.max[1], box.max[2]],
      [box.min[0], box.max[1], box.max[2]],
    ];
    window.__testPairs = P.map((p) => ({ splat: p, room: fwd(p) }));
    return { scale: s, yaw: th };
  });
  log(`synthetic truth: scale=${truth.scale.toExponential(3)} yaw=${truth.yaw}`);

  const solve = await page.evaluate(async () => {
    const r = await fetch("/api/solve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairs: window.__testPairs, yaw_only: true }),
    });
    return r.json();
  });
  const scaleErr = Math.abs(solve.scale - truth.scale) / truth.scale;
  const yawErr = Math.abs(solve.rotation_euler_xyz[2] - truth.yaw);
  check("solver recovers known scale", scaleErr < 1e-9, `rel err ${scaleErr.toExponential(2)}`);
  check("solver recovers known yaw", yawErr < 1e-9, `err ${yawErr.toExponential(2)} rad`);
  check("solver RMS ~ 0", solve.rms < 1e-9, `rms=${solve.rms.toExponential(2)}`);

  // ---- stage 3: clean, with the crop shader live.
  // Place the pairs through the app's own addPoint() path, then click Solve like a user would.
  await page.evaluate(() => window.__e2eSetPairs(window.__testPairs));

  // Pairs are identified by letter (A↔A) so you can tell which corners are done.
  const badges = await page.locator("#pairs .pair .idx").allTextContents();
  check("pairs are lettered A,B,C,D", badges.join("") === "ABCD", badges.join(""));
  const badgeColors = await page.evaluate(() =>
    [...document.querySelectorAll("#pairs .pair .idx")].map((e) => e.style.background));
  check("each pair has its own colour", new Set(badgeColors).size === badgeColors.length,
    badgeColors.join(" "));
  // Both panes must show a marker per pair (splat + room = same letter, same colour).
  const markers = await page.evaluate(() => [
    window.__e2eMarkerCount("splat"), window.__e2eMarkerCount("room")]);
  check("markers drawn in both panes", markers[0] === 4 && markers[1] === 4,
    `splat=${markers[0]} room=${markers[1]}`);
  await page.screenshot({ path: `${SHOTS}2b-pairs.png` });

  // WASD must fly the splat camera (orbiting alone can't reach a far corner).
  const camMoved = await page.evaluate(async () => {
    const before = window.__e2eCam("splat");
    document.querySelector("#host-splat").dispatchEvent(new PointerEvent("pointerenter"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
    await new Promise((r) => setTimeout(r, 600));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "w" }));
    const after = window.__e2eCam("splat");
    return Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  });
  check("WASD flies the splat camera", camMoved > 1e-3, `moved ${camMoved.toFixed(3)} units`);

  // Blue splat-centre overlay (SuperSplat-style).
  const beforePts = await page.locator("#host-splat").screenshot({ timeout: 180000 });
  await page.locator("#splat-points").check();
  await page.waitForFunction(() => window.__e2ePointCloud()?.inScene, { timeout: 60000 });
  await page.waitForTimeout(800);
  const pc = await page.evaluate(() => window.__e2ePointCloud());
  const afterPts = await page.locator("#host-splat").screenshot({ timeout: 180000 });
  check("point overlay builds and renders", pc && pc.points > 100000 && pc.inScene,
    pc ? `${pc.points.toLocaleString()} points` : "null");
  check("point overlay changes the splat view",
    (await diffFraction(page, beforePts, afterPts)) > 0.01);
  await page.screenshot({ path: `${SHOTS}2c-points.png` });
  await page.locator("#splat-points").uncheck();
  await page.waitForTimeout(300);

  await page.locator("#solve").click();
  await page.waitForFunction(() => /RMS/.test(document.querySelector("#solve-out")?.textContent ?? ""),
    { timeout: 15000 });
  const rmsTxt = (await page.locator("#solve-out").textContent()).trim();
  check("UI solve reports RMS", /RMS/.test(rmsTxt), rmsTxt.split("\n")[0]);
  await page.screenshot({ path: `${SHOTS}3-solved.png` });

  await page.locator("#go-clean").click();
  log("loading splat into room space + SDF…");
  await page.waitForSelector("#faces .face", { timeout: 300000 });

  const nFaces = await page.locator("#faces .face:not(.resize)").count();
  // 4 walls -> master + Wall 0..3 + Floor + Ceiling + Floaters (the Resize section isn't a face).
  check("face rows match wall count", nFaces === 8, `${nFaces} rows for 4 walls`);

  // The real prize: did the dyno crop shader compile and run?
  const shaderErrs = errors.filter((e) => /shader|GLSL|compile|link/i.test(e));
  check("crop shader compiled", shaderErrs.length === 0, shaderErrs[0]?.slice(0, 200) ?? "");

  // The crop must actually *remove* content. Measure both states explicitly by toggling into
  // each one -- reading whatever happens to be on screen at entry is how the first version of
  // this test fooled itself (twice: once passing on noise, once failing on an unsettled frame).
  await page.locator("#crop-on").uncheck();
  const inkFull = await waitStable(page, "#host-clean");
  await page.screenshot({ path: `${SHOTS}5b-crop-off.png` });

  await page.locator("#crop-on").check();
  const inkCropped = await waitStable(page, "#host-clean");
  await page.screenshot({ path: `${SHOTS}4-clean.png` });
  await page.screenshot({ path: `${SHOTS}5a-crop-on.png` });

  check("splat is visible in room space", inkFull > 0.05,
    `${(inkFull * 100).toFixed(1)}% ink uncropped`);
  check("crop removes content", inkFull - inkCropped > 0.02,
    `${(inkFull * 100).toFixed(1)}% -> ${(inkCropped * 100).toFixed(1)}% ink`);

  // Dragging the master wall offset inward must remove more. This is the check that catches a
  // uniform change failing to invalidate Spark's accumulator.
  const inkA = await waitStable(page, "#host-clean");
  await page.evaluate(() => {
    const r = document.querySelectorAll("#faces .face.master input[type=range]")[0]; // offset
    r.value = "0.6";
    r.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const inkB = await waitStable(page, "#host-clean");
  await page.screenshot({ path: `${SHOTS}6-offset-0.6.png` });
  check("wall offset slider tightens the crop live", inkA - inkB > 0.005,
    `${(inkA * 100).toFixed(1)}% -> ${(inkB * 100).toFixed(1)}% ink`);

  // Feather: compare a hard cut against a wide fade. Contrasting the two extremes gives a real
  // signal; comparing a wide fade against the 0.25 m default moves ink by only ~0.4pp.
  const setMaster = (offset, feather) => page.evaluate(([o, f]) => {
    const rs = document.querySelectorAll("#faces .face.master input[type=range]");
    rs[0].value = String(o); rs[0].dispatchEvent(new Event("input", { bubbles: true }));
    rs[1].value = String(f); rs[1].dispatchEvent(new Event("input", { bubbles: true }));
  }, [offset, feather]);

  await setMaster(0, 0);
  await waitStable(page, "#host-clean");
  const hardShot = await page.locator("#host-clean").screenshot({ timeout: 180000 });
  await page.screenshot({ path: `${SHOTS}7a-feather-0.png` });
  await setMaster(0, 1.4);
  await waitStable(page, "#host-clean");
  const softShot = await page.locator("#host-clean").screenshot({ timeout: 180000 });
  await page.screenshot({ path: `${SHOTS}7b-feather-1.4.png` });
  // A wide feather softens edges (many pixels change) even when total coverage barely moves.
  const fdiff = await diffFraction(page, hardShot, softShot);
  check("feather visibly softens the crop edge", fdiff > 0.01, `${(fdiff * 100).toFixed(1)}% of pixels differ`);
  await setMaster(0, 0.25);
  await waitStable(page, "#host-clean");

  // ---- new controls -------------------------------------------------------

  // Offsets must not be capped by the slider: the number box takes any value.
  const bigOffset = await page.evaluate(() => {
    const n = document.querySelectorAll("#faces .face.master input.num")[0];
    n.value = "-12.5";
    n.dispatchEvent(new Event("input", { bubbles: true }));
    return window.__e2eCropParams().wall_offset[0];
  });
  check("offset accepts values past the slider range", Math.abs(bigOffset + 12.5) < 1e-6,
    `wall_offset[0] = ${bigOffset}`);
  await page.evaluate(() => {
    const n = document.querySelectorAll("#faces .face.master input.num")[0];
    n.value = "0"; n.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitStable(page, "#host-clean");

  // Manual refine must move the splat, and reset must put it back exactly.
  const mSolved = await page.evaluate(() => window.__e2eMatrix());
  await waitStable(page, "#host-clean");
  const shotBefore = await page.locator("#host-clean").screenshot({ timeout: 180000 });
  await page.locator("#sect-refine > summary").click();
  await page.evaluate(() => {
    const r = document.querySelectorAll("#refine .refine-row input[type=range]")[0]; // yaw
    r.value = "35";
    r.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(600);
  await waitStable(page, "#host-clean");
  const shotAfter = await page.locator("#host-clean").screenshot({ timeout: 180000 });
  await page.screenshot({ path: `${SHOTS}8-refine-yaw35.png` });
  const mRefined = await page.evaluate(() => window.__e2eMatrix());

  check("refine yaw changes the transform",
    mRefined.some((v, i) => Math.abs(v - mSolved[i]) > 1e-6));
  // A yaw rotates content *within* the room, so coverage barely moves -- diff the pixels.
  const d = await diffFraction(page, shotBefore, shotAfter);
  check("refine yaw changes the render", d > 0.005, `${(d * 100).toFixed(1)}% of pixels differ`);
  check("refine state is reported", (await page.locator("#refine-state").textContent()) === "nudged");

  await page.locator("#refine-reset").click();
  await page.waitForTimeout(900);
  const mReset = await page.evaluate(() => window.__e2eMatrix());
  check("refine reset restores the solved transform exactly",
    mReset.every((v, i) => Math.abs(v - mSolved[i]) < 1e-9)
    && (await page.locator("#refine-state").textContent()) === "solved");

  // Point editing: handles must appear and the drag gizmo must actually attach. (The hook below
  // moves a point directly; this is what proves a real user could grab one.)
  await page.locator("#show-points").check();
  await page.locator("#sect-points > summary").click();
  await page.locator("#clean-pairs .cpair").first().click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}9-points.png` });
  const gz = await page.evaluate(() => window.__e2eGizmo());
  check("point handles exist and are visible", gz.handles === 4 && gz.visible === true,
    JSON.stringify(gz));
  check("drag gizmo attaches to the selected point",
    gz.selected === 0 && gz.attached && gz.inScene, JSON.stringify(gz));

  // Moving a room point must re-solve.
  const rmsBefore = await page.evaluate(() => window.__e2eRms());
  await page.evaluate(() => window.__e2eMovePoint(0, [0.4, 0.4, 0.4]));
  await page.waitForTimeout(1200);
  const rmsAfter = await page.evaluate(() => window.__e2eRms());
  check("moving a point re-solves the alignment", rmsAfter > rmsBefore,
    `rms ${rmsBefore.toExponential(2)} -> ${rmsAfter.toExponential(2)}`);

  // ---- IFC solids: the real walls with thickness -----------------------------
  await page.locator("#show-ifc").check();
  await page.waitForFunction(() => window.__e2eIfcSolid()?.visible, { timeout: 30000 });
  const solid = await page.evaluate(() => window.__e2eIfcSolid());
  check("IFC solid loads with real geometry", solid && solid.tris > 20 && solid.visible,
    solid ? `${solid.tris} tris, zMax ${solid.zMax.toFixed(2)}` : "null");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}10-ifc-solid.png` });

  // ---- adjustable room height ------------------------------------------------
  const zTrue = await page.evaluate(() => window.__e2eRoomCornerZ());
  const solidZ = solid.zMax;
  await page.evaluate(() => window.__e2eSetHeight(2.0));
  await page.waitForTimeout(700);
  const zLow = await page.evaluate(() => window.__e2eRoomCornerZ());
  const solidAfter = await page.evaluate(() => window.__e2eIfcSolid());
  const cropH = await page.evaluate(() => window.__e2eCropParams().height);
  await page.screenshot({ path: `${SHOTS}11-height-2m.png` });

  check("room height lowers the wireframe", Math.abs(zTrue - 3) < 0.01 && Math.abs(zLow - 2) < 0.01,
    `ceiling ${zTrue.toFixed(2)} -> ${zLow.toFixed(2)} m`);
  check("height override reaches the export crop", Math.abs(cropH - 2.0) < 1e-6, `height=${cropH}`);
  check("IFC solid keeps its true height (not stretched by the override)",
    Math.abs(solidAfter.zMax - solidZ) < 0.01, `solid zMax ${solidZ.toFixed(2)} -> ${solidAfter.zMax.toFixed(2)}`);

  const hardErrs = errors.filter((e) => !/favicon|DevTools|Download the React/i.test(e));
  check("no page errors", hardErrs.length === 0, hardErrs.slice(0, 2).join(" | ").slice(0, 300));
} catch (e) {
  console.log("FAIL  driver threw —", e.message);
  await page.screenshot({ path: `${SHOTS}error.png` }).catch(() => {});
  failed = true;
} finally {
  await browser.close();
}

console.log(failed ? "\nE2E FAILED" : "\nE2E PASSED");
process.exit(failed ? 1 : 0);
