/** Fly navigation: a drag looks in place (camera fixed), and switching to orbit doesn't lurch. */
import { chromium } from "playwright";

const SHOTS = "e2e/shots/";
const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

let fails = 0;
const check = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Drive the standalone twin viewport -- it builds a real Viewport with a framed room, no splat vault needed.
await page.goto("http://127.0.0.1:5180/e2e/twin.html?room=libra_lab", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__ready, { timeout: 20000 });

// Expose the viewport's camera + nav state through the page.
await page.evaluate(() => {
  const host = document.querySelector("#host");
  // The Viewport instance isn't globally exported; reach it via the toggle button's owner.
  // Simpler: rebuild access from the scene graph is fragile, so twin.html exports it below.
});

const cam = () => page.evaluate(() => window.__cam());
const dir = () => page.evaluate(() => window.__dir());
const navMode = () => page.evaluate(() => window.__navMode());

check("starts in orbit mode", (await navMode()) === "orbit");

// Flip to fly (press F over the canvas).
const box = await page.locator("#host canvas").boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.keyboard.press("f");
await page.waitForTimeout(200);
check("F toggles into fly mode", (await navMode()) === "fly");

// A look-drag: camera position must stay put, facing must change.
const posBefore = await cam();
const dirBefore = await dir();
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(cx + i * 12, cy + i * 4, { steps: 1 });
await page.mouse.up();
await page.waitForTimeout(400);
const posAfter = await cam();
const dirAfter = await dir();

const moved = dist(posBefore, posAfter);
const turned = dist(dirBefore, dirAfter);
check("fly drag keeps the camera position fixed (looks in place)", moved < 0.05,
  `camera moved ${moved.toFixed(4)} m`);
check("fly drag changes where the camera looks", turned > 0.1,
  `look direction changed by ${turned.toFixed(3)}`);

await page.screenshot({ path: SHOTS + "fly-look.png" });

// Switching to orbit must not teleport the camera, and must set a pivot in front of it.
const posPreOrbit = await cam();
await page.keyboard.press("f");
await page.waitForTimeout(200);
check("F toggles back to orbit", (await navMode()) === "orbit");
const posPostOrbit = await cam();
check("switching to orbit does not move the camera", dist(posPreOrbit, posPostOrbit) < 0.05,
  `camera moved ${dist(posPreOrbit, posPostOrbit).toFixed(4)} m`);

const pivot = await page.evaluate(() => window.__target());
const camNow = await cam();
const dirNow = await dir();
const toPivot = [pivot[0] - camNow[0], pivot[1] - camNow[1], pivot[2] - camNow[2]];
const ahead = toPivot[0] * dirNow[0] + toPivot[1] * dirNow[1] + toPivot[2] * dirNow[2];
const pivotDist = Math.hypot(...toPivot);
check("orbit pivot lands in front of the camera, not on the lens", ahead > 0 && pivotDist > 0.3,
  `pivot ${pivotDist.toFixed(2)} m ahead (dot ${ahead.toFixed(2)})`);

// And an orbit drag now rotates the camera around that pivot (position changes, as orbit should).
const posOrbitBefore = await cam();
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 14, cy, { steps: 1 });
await page.mouse.up();
await page.waitForTimeout(400);
const posOrbitAfter = await cam();
check("orbit drag orbits the camera (position moves around the pivot)", dist(posOrbitBefore, posOrbitAfter) > 0.05,
  `camera moved ${dist(posOrbitBefore, posOrbitAfter).toFixed(3)} m`);
// Orbiting keeps a constant radius to the pivot -- that's the definition of orbiting.
const rBefore = Math.hypot(posOrbitBefore[0] - pivot[0], posOrbitBefore[1] - pivot[1], posOrbitBefore[2] - pivot[2]);
const rAfter = Math.hypot(posOrbitAfter[0] - pivot[0], posOrbitAfter[1] - pivot[1], posOrbitAfter[2] - pivot[2]);
check("orbit keeps a roughly constant radius to the pivot", Math.abs(rBefore - rAfter) / rBefore < 0.05,
  `radius ${rBefore.toFixed(2)} -> ${rAfter.toFixed(2)} m`);

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
await browser.close();
process.exit(fails ? 1 : 0);
