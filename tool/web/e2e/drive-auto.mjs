/**
 * End-to-end for the automatic path (no IFC, no clicks): pick a scan + "⚡ Auto room", and the app
 * must land in Clean with a detected box that crops the splat, and render its generated twin.
 *
 *   node e2e/drive-auto.mjs [scan-text]      (default "Space 1-20260701"; matched against the scan list)
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const SCAN = process.argv[2] ?? "Space 1-20260701";
const BASE = "http://127.0.0.1:5180";
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
const tag = SCAN.replace(/[^A-Za-z0-9]+/g, "_");
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
    const bg = [px[0], px[1], px[2]];               // corner pixel = background
    let n = 0;
    for (let i = 0; i < px.length; i += 4)
      if (Math.abs(px[i] - bg[0]) > 10 || Math.abs(px[i + 1] - bg[1]) > 10 || Math.abs(px[i + 2] - bg[2]) > 10) n++;
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
  const scan = page.locator("#splat-list .item", { hasText: SCAN }).first();
  check(`scan "${SCAN}" listed`, (await scan.count()) === 1);
  await scan.click();
  await page.locator("#room-list .auto-item").click();
  check("auto option selectable", await page.locator("#go-align").isEnabled());
  check("button says Detect", /Detect/.test(await page.locator("#go-align").textContent()));

  const t0 = Date.now();
  await page.locator("#go-align").click();
  await page.waitForSelector("#faces .face", { timeout: 600000 });
  const nFaces = await page.locator("#faces .face").count();
  check("lands in Clean with face rows", nFaces >= 6, `${nFaces} rows, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await page.waitForTimeout(2000);

  const fl = await page.evaluate(() => window.__e2eCropParams?.());
  check("floater filter pre-set for auto rooms", fl && fl.max_scale > 0, JSON.stringify(
    fl && { max_scale: fl.max_scale, min_opacity: fl.min_opacity }));
  check("Floaters row in Cleaning", (await page.locator("#faces .face", { hasText: "Floaters" }).count()) === 1);

  await page.locator("#crop-on").uncheck();
  const inkFull = await stable(page, "#host-clean");
  await page.locator("#crop-on").check();
  const inkCropped = await stable(page, "#host-clean");
  await page.screenshot({ path: `${SHOTS}auto-${tag}-clean.png` });
  check("auto box crops the splat", inkFull > 0.05 && inkCropped > 0.02 && inkFull - inkCropped > 0.005,
    `${(inkFull * 100).toFixed(1)}% -> ${(inkCropped * 100).toFixed(1)}% ink`);

  // Generated twin over the splat, frontend look.
  await page.locator("#twin-on").check();
  await page.locator("#sect-twin > summary").click().catch(() => {});
  await page.getByRole("button", { name: "Match frontend" }).click().catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}auto-${tag}-twin.png` });
  const inkTwin = await stable(page, "#host-clean");
  check("generated twin renders over the splat", inkTwin > inkCropped * 1.1,
    `${(inkCropped * 100).toFixed(1)}% -> ${(inkTwin * 100).toFixed(1)}% ink`);
  const thick = await page.evaluate(() => document.querySelector("#twin")?.textContent ?? "");
  check("twin wall thickness follows the room", !/0[.,]20\b/.test(
    await page.locator("#sect-twin summary").textContent()), (await page.locator("#sect-twin summary").textContent()).trim());

  check("no page errors", errors.filter((e) => !/favicon/i.test(e)).length === 0,
    errors.slice(0, 2).join(" | ").slice(0, 200));
} catch (e) {
  console.log("FAIL  driver threw —", e.message);
  await page.screenshot({ path: `${SHOTS}auto-${tag}-error.png` }).catch(() => {});
  failed = true;
} finally {
  await browser.close();
}
console.log(failed ? "\nAUTO E2E FAILED" : "\nAUTO E2E PASSED");
process.exit(failed ? 1 : 0);
