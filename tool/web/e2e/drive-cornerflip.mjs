/**
 * Clean-stage editing of an auto/drawn box: add a corner between two, remove one, and flip an
 * upside-down scan together with its box.
 *
 *   node e2e/drive-cornerflip.mjs [scan-text]      (default "Space 1-20260701")
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const SCAN = process.argv[2] ?? "Space 1-20260701";
const BASE = "http://127.0.0.1:5180";
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });
let failed = false;
const check = (n, ok, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);
  if (!ok) failed = true;
};
const near = (a, b, e = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < e);
// flipped(p) = (x, -y, H - z) applied after M: rows 1, 2 negate, z translation -> H - t.z
const flipM = (m, H) => m.map((v, i) => (i >= 4 && i < 12 ? (i === 11 ? H - v : -v) : v));

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const custom = () => page.evaluate(() => window.__e2eCustom());

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#splat-list .item", { timeout: 600000 });
  await page.locator("#splat-list .item", { hasText: SCAN }).first().click();
  await page.locator("#room-list .auto-item").click();
  await page.locator("#go-align").click();
  await page.waitForSelector("#faces .face", { timeout: 600000 });
  await page.waitForTimeout(2500);
  check("flip button shown for an auto box", await page.locator("#flip-room").isVisible());
  await page.locator("#sect-points > summary").click();

  // ---- add a corner between A and B
  const c0 = await custom();
  const n0 = c0.footprint.length;
  await page.evaluate(() => window.__e2eSetFace("wallOffset", 0, 0.37));   // wall A->B gets a bespoke offset
  await page.locator("#clean-pairs .cpair").nth(0).locator('button[data-act="add"]').click();
  await page.waitForTimeout(800);
  const c1 = await custom();
  const [a, b] = [c0.footprint[0], c0.footprint[1]];
  check("corner added", c1.footprint.length === n0 + 1, `${n0} -> ${c1.footprint.length}`);
  check("new corner sits halfway between A and B",
    near(c1.footprint[1], [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
  check("face panel follows the wall count", c1.panelWalls === n0 + 1);
  check("both halves keep the split wall's offset", c1.wallOffset[0] === Math.fround(0.37) && c1.wallOffset[1] === Math.fround(0.37),
    c1.wallOffset.slice(0, 3).map((v) => v.toFixed(2)).join(", "));
  check("corner list shows the new corner", (await page.locator("#clean-pairs .cpair").count()) === n0 + 1);
  const gz = await page.evaluate(() => window.__e2eGizmo());
  check("new corner selected with a move gizmo", gz.selected === 1 && gz.attached, JSON.stringify(gz));
  const crop1 = await page.evaluate(() => window.__e2eCropParams());
  check("crop re-baked with the new wall count", crop1.wall_offset.length === n0 + 1);
  await page.screenshot({ path: `${SHOTS}cornerflip-added.png` });

  // ---- remove it again
  await page.locator("#clean-pairs .cpair").nth(1).locator('button[data-act="del"]').click();
  await page.waitForTimeout(800);
  const c2 = await custom();
  check("corner removed -> original footprint back", c2.footprint.length === n0
    && c2.footprint.every((p, i) => near(p, c0.footprint[i])));
  check("crop back to the original wall count", (await page.evaluate(() => window.__e2eCropParams())).wall_offset.length === n0);

  // ---- flip upside down, with a nudge applied, through the real server compose
  await page.evaluate(() => window.__e2eSetRefine({ scale: 1.03, rotation_euler_xyz: [0.04, -0.06, 0.2], translation: [0.05, -0.1, 0.07] }));
  await page.evaluate(() => window.__e2eSetFace("floorOffset", null, 0.11));
  await page.waitForTimeout(800);
  const before = await custom();
  const mBefore = await page.evaluate(() => window.__e2eMatrix());
  await page.screenshot({ path: `${SHOTS}cornerflip-before.png` });
  await page.locator("#flip-room").click();
  await page.waitForTimeout(2500);
  const after = await custom();
  const mAfter = await page.evaluate(() => window.__e2eMatrix());
  await page.screenshot({ path: `${SHOTS}cornerflip-after.png` });
  const H = before.height;
  check("splat transform (with nudge, server-composed) is the old one turned over",
    near(mAfter, flipM(mBefore, H), 1e-6),
    `max err ${Math.max(...mAfter.map((v, i) => Math.abs(v - flipM(mBefore, H)[i]))).toExponential(1)}`);
  check("box footprint mirrored with it", after.footprint.length === before.footprint.length
    && near(after.footprint[0], [before.footprint[0][0], -before.footprint[0][1]]));
  check("floor and ceiling settings swap", after.ceilOffset === Math.fround(0.11) || Math.abs(after.ceilOffset - 0.11) < 1e-6,
    `floor ${after.floorOffset}, ceil ${after.ceilOffset}`);
  check("flipped box is anchored on its new floor", after.fromCeiling === false);

  // Room height after a flip must clip the ceiling, not move the model
  await page.evaluate((h) => window.__e2eSetHeight(h), H * 1.4);
  await page.waitForTimeout(1500);
  const mTall = await page.evaluate(() => window.__e2eMatrix());
  const zTop = await page.evaluate(() => window.__e2eRoomCornerZ());
  check("Room height after a flip leaves the model in place", near(mTall, mAfter, 1e-6));
  const want = H * 1.4 - after.ceilOffset;          // the crop's ceiling: new height minus its offset
  check("... and moves the ceiling instead", Math.abs(zTop - want) < 1e-3, `box top ${zTop?.toFixed(3)} (want ${want.toFixed(3)})`);
  await page.screenshot({ path: `${SHOTS}cornerflip-after-height.png` });
  await page.evaluate((h) => window.__e2eSetHeight(h), H);
  await page.waitForTimeout(1500);

  // ---- flip back: everything restored
  await page.locator("#flip-room").click();
  await page.waitForTimeout(2500);
  const back = await custom();
  const mBack = await page.evaluate(() => window.__e2eMatrix());
  check("flipping twice restores the transform", near(mBack, mBefore, 1e-6));
  check("... the footprint", back.footprint.every((p, i) => near(p, before.footprint[i])));
  check("... and the nudge", near(back.refine.rotation_euler_xyz, before.refine.rotation_euler_xyz)
    && near(back.refine.translation, before.refine.translation));
  check("no page errors", errors.filter((e) => !/favicon/i.test(e)).length === 0, errors.slice(0, 2).join(" | ").slice(0, 200));
} catch (e) {
  console.log("FAIL  driver threw —", e.message);
  await page.screenshot({ path: `${SHOTS}cornerflip-error.png` }).catch(() => {});
  failed = true;
} finally {
  await browser.close();
}
console.log(failed ? "\nCORNER/FLIP E2E FAILED" : "\nCORNER/FLIP E2E PASSED");
process.exit(failed ? 1 : 0);
