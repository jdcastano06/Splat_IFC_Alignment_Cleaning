/**
 * End-to-end for the draw-your-own-box path (no IFC).
 *
 * Drives the real app: select a splat + "custom box", draw floor corners, build the box, crop in
 * Clean, and confirm the crop actually removes content and footprint corners are editable. The
 * synthetic corners are the bottom face of the splat's dense core -- a valid coplanar footprint
 * for exercising the whole pipeline without a human judging where the real floor is.
 *
 *   node e2e/drive-custom.mjs [splatIndex]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const SPLAT_IDX = Number(process.argv[2] ?? 4);
const BASE = "http://127.0.0.1:5180";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
let failed = false;
const check = (n, ok, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);
  if (!ok) failed = true;
};

async function ink(page, sel) {
  const buf = await page.locator(sel).screenshot({ timeout: 180000 });
  return page.evaluate(async (d) => {
    const img = new Image(); img.src = "data:image/png;base64," + d; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const px = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4)
      if (Math.abs(px[i] - 13) > 10 || Math.abs(px[i + 1] - 16) > 10 || Math.abs(px[i + 2] - 19) > 10) n++;
    return n / (px.length / 4);
  }, buf.toString("base64"));
}
async function stable(page, sel, { eps = 0.002, tries = 40, gap = 700 } = {}) {
  let prev = -1;
  for (let i = 0; i < tries; i++) {
    const v = await ink(page, sel);
    if (Math.abs(v - prev) <= eps) return v;
    prev = v; await page.waitForTimeout(gap);
  }
  return prev;
}

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#splat-list .item");

  // Select a splat with a PLY + the custom-box option.
  await page.locator("#splat-list .item").nth(SPLAT_IDX).click();
  await page.locator("#room-list .custom-item").click();
  check("custom box selectable", await page.locator("#go-align").isEnabled());

  await page.locator("#go-align").click();
  await page.waitForFunction(
    () => /splats/.test(document.querySelector("#splat-count")?.textContent ?? ""),
    { timeout: 300000 });
  const panels = await page.evaluate(() => ({
    draw: getComputedStyle(document.querySelector("#draw-side")).display,
    align: getComputedStyle(document.querySelector("#align-side")).display,
    custom: document.querySelector("#stage-align.custom") !== null,
  }));
  check("draw panel shown, pairs panel hidden",
    panels.draw !== "none" && panels.align === "none" && panels.custom, JSON.stringify(panels));
  await page.waitForTimeout(1500);

  // Trace 4 floor corners (perimeter order) as an OPEN outline: no box, no Continue yet.
  await page.evaluate(() => {
    const b = window.__e2eSplatBox();
    const z = b.min[2];
    const P = [[b.min[0], b.min[1], z], [b.max[0], b.min[1], z],
               [b.max[0], b.max[1], z], [b.min[0], b.max[1], z]];
    for (const p of P) window.__e2eAddDrawPoint(p);
  });
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => window.__e2eDrawState());
  check("outline stays open until closed (no box, Continue disabled)",
    open.points === 4 && !open.closed && !open.boxBuilt && !open.cleanEnabled && open.closeShown,
    JSON.stringify(open));
  await page.screenshot({ path: `${SHOTS}c1a-open.png` });

  // Close the polygon -> box builds, Continue enables.
  await page.evaluate(() => window.__e2eCloseDraw());
  await page.waitForTimeout(400);
  const draw = await page.evaluate(() => window.__e2eDrawState());
  check("closing builds the box and enables Continue",
    draw.closed && draw.boxBuilt && draw.footprint === 4 && draw.cleanEnabled,
    JSON.stringify(draw));
  await page.screenshot({ path: `${SHOTS}c1-draw.png` });

  // A self-crossing order must be caught (swap two corners to make a bow-tie).
  const crossed = await page.evaluate(() => {
    const b = window.__e2eSplatBox(), z = b.min[2];
    // bow-tie: min,min -> max,max -> max,min -> min,max
    window.__e2eDrawMove(1, [b.max[0], b.max[1], z]);
    window.__e2eDrawMove(2, [b.max[0], b.min[1], z]);
    return window.__e2eDrawState();
  });
  check("self-intersecting outline blocks Continue", !crossed.cleanEnabled, JSON.stringify(crossed));
  // put them back
  await page.evaluate(() => {
    const b = window.__e2eSplatBox(), z = b.min[2];
    window.__e2eDrawMove(1, [b.max[0], b.min[1], z]);
    window.__e2eDrawMove(2, [b.max[0], b.max[1], z]);
  });
  await page.waitForTimeout(200);
  check("fixing the order re-enables Continue",
    await page.evaluate(() => !document.querySelector("#draw-clean").disabled));

  // Corner editing IN THE DRAW STAGE: select a corner from the sidebar, then move it.
  await page.evaluate(() => window.__e2eDrawSelectRow(1));
  await page.waitForTimeout(300);
  const dgz = await page.evaluate(() => window.__e2eDrawGizmo());
  check("selecting a corner row shows its move gizmo",
    dgz && dgz.selected === 1 && dgz.attached && dgz.handles === 4, JSON.stringify(dgz));
  await page.screenshot({ path: `${SHOTS}c1b-draw-selected.png` });

  const before = await page.evaluate(() => window.__e2eRoom() ? null : window.__e2eDrawState());
  const moved = await page.evaluate(() => {
    const b = window.__e2eSplatBox();
    // shove corner B inward toward the box centre
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
    window.__e2eDrawMove(1, [cx, cy, b.min[2]]);
    return window.__e2eDrawState();
  });
  check("moving a corner keeps the box valid", moved.points === 4 && moved.boxBuilt,
    JSON.stringify(moved));
  await page.screenshot({ path: `${SHOTS}c1c-draw-moved.png` });

  // Into Clean.
  await page.locator("#draw-clean").click();
  await page.waitForSelector("#faces .face", { timeout: 300000 });
  const nFaces = await page.locator("#faces .face:not(.resize)").count();
  check("face rows for a 4-wall custom box", nFaces === 8, `${nFaces} rows (4 walls + master + floor + ceiling + floaters; Resize excluded)`);

  const shaderErr = errors.filter((e) => /shader|GLSL|compile|link/i.test(e));
  check("crop shader compiled", shaderErr.length === 0, shaderErr[0]?.slice(0, 160) ?? "");

  await page.locator("#crop-on").uncheck();
  const inkFull = await stable(page, "#host-clean");
  await page.locator("#crop-on").check();
  const inkCropped = await stable(page, "#host-clean");
  await page.screenshot({ path: `${SHOTS}c2-clean.png` });
  check("custom box crops the splat", inkFull > 0.05 && inkFull - inkCropped > 0.02,
    `${(inkFull * 100).toFixed(1)}% -> ${(inkCropped * 100).toFixed(1)}% ink`);

  // No IFC solids for a custom box.
  check("IFC-walls toggle hidden for custom", await page.evaluate(() =>
    document.querySelector("#show-ifc").parentElement.style.display === "none"));

  // Footprint corners are editable (drag re-bakes the SDF).
  await page.locator("#show-points").check();
  await page.locator("#sect-points > summary").click();
  await page.locator("#clean-pairs .cpair").first().click();
  await page.waitForTimeout(600);
  const gz = await page.evaluate(() => window.__e2eGizmo());
  check("footprint corner handles editable", gz.handles === 4 && gz.attached, JSON.stringify(gz));

  const inkBefore = await stable(page, "#host-clean");
  await page.evaluate(() => {
    // Pull corner 0 inward toward the centroid -> smaller box -> less kept.
    const f = window.__e2eRoom().footprint;
    window.__e2eMoveFootprint(0, [f[0][0] * 0.3, f[0][1] * 0.3, 0]);
  });
  const inkAfter = await stable(page, "#host-clean");
  await page.screenshot({ path: `${SHOTS}c3-edited.png` });
  check("moving a corner re-bakes the crop", Math.abs(inkAfter - inkBefore) > 0.003,
    `${(inkBefore * 100).toFixed(1)}% -> ${(inkAfter * 100).toFixed(1)}% ink`);

  check("no page errors", errors.filter((e) => !/favicon/i.test(e)).length === 0,
    errors.slice(0, 2).join(" | ").slice(0, 200));
} catch (e) {
  console.log("FAIL  driver threw —", e.message);
  await page.screenshot({ path: `${SHOTS}c-error.png` }).catch(() => {});
  failed = true;
} finally {
  await browser.close();
}
console.log(failed ? "\nCUSTOM E2E FAILED" : "\nCUSTOM E2E PASSED");
process.exit(failed ? 1 : 0);
