/**
 * Diagnostic probe: is the crop worldModifier running at all, and what does it see?
 *   node e2e/probe.mjs
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5180";
const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (m) => {
  if (m.type() === "error" || /shader|GLSL|error/i.test(m.text())) {
    console.log("[console]", m.text().slice(0, 400));
  }
});
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));

async function ink(sel) {
  const buf = await page.locator(sel).screenshot();
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
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - 13) > 10 || Math.abs(px[i + 1] - 16) > 10 || Math.abs(px[i + 2] - 19) > 10) n++;
    }
    return n / (px.length / 4);
  }, b64);
}

const MODE = process.argv[2] ?? "";
await page.addInitScript((m) => { window.__cropDebug = m || null; }, MODE);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("#splat-list .item");
await page.locator("#splat-list .item").nth(4).click();
await page.locator('#room-list .item:has(.m:text-is("libra_lab"))').click();
await page.locator("#go-align").click();
await page.waitForFunction(() => /splats/.test(document.querySelector("#splat-count")?.textContent ?? ""),
  { timeout: 300000 });

await page.evaluate(() => {
  const box = window.__e2eSplatBox();
  const room = window.__e2eRoom();
  const rx = room.footprint.map((p) => p[0]), ry = room.footprint.map((p) => p[1]);
  const roomSize = Math.max(Math.max(...rx) - Math.min(...rx), Math.max(...ry) - Math.min(...ry));
  const splatSize = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]);
  const s = roomSize / splatSize, th = 0.6;
  const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2, cz = box.min[2];
  const c = Math.cos(th), sn = Math.sin(th);
  const fwd = (p) => {
    const x = p[0] - cx, y = p[1] - cy, z = p[2] - cz;
    return [s * (c * x - sn * y), s * (sn * x + c * y), s * z];
  };
  const P = [
    [box.min[0], box.min[1], box.min[2]], [box.max[0], box.min[1], box.min[2]],
    [box.max[0], box.max[1], box.max[2]], [box.min[0], box.max[1], box.max[2]],
  ];
  window.__testPairs = P.map((p) => ({ splat: p, room: fwd(p) }));
  window.__e2eSetPairs(window.__testPairs);
});
await page.locator("#solve").click();
await page.waitForFunction(() => /RMS/.test(document.querySelector("#solve-out")?.textContent ?? ""));
await page.locator("#go-clean").click();
await page.waitForSelector("#faces .face", { timeout: 300000 });
await page.waitForTimeout(8000); // let Spark finish building/sorting 5.3M splats

const state = await page.evaluate(() => {
  const r = window.__e2eDebug?.();
  return r ?? { error: "no __e2eDebug hook" };
});
console.log("mode:", MODE || "(normal)");
console.log("state:", JSON.stringify(state, null, 1));
console.log("ink:", (await ink("#host-clean") * 100).toFixed(2) + "%");
await page.screenshot({ path: new URL(`./shots/probe-${MODE || "normal"}.png`, import.meta.url).pathname });
await browser.close();
