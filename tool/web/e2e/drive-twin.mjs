/** Drive the twin preview: geometry maths, live restyling, and what it actually renders. */
import { chromium } from "playwright";

const ROOM = process.argv[2] ?? "libra_lab";
const SHOTS = "e2e/shots/";
const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 500)));
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 300)); });

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(`http://127.0.0.1:5180/e2e/twin.html?room=${ROOM}`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__ready, { timeout: 20000 });

const room = await page.evaluate(() => window.__room);
console.log(`room: ${room.name}, ${room.footprint.length} walls, h=${room.height}, area ${room.area.toFixed(1)} m2`);

// ---- geometry maths ---------------------------------------------------------
await page.evaluate(() => window.__apply({ source: "generated", thickness: 0.2, anchor: "center",
  offset: 0, floorSlab: true, ceilSlab: false }));
const g1 = await page.evaluate(() => window.__geom());
check("walls span floor to ceiling", Math.abs(g1.walls.min[2]) < 1e-4 && Math.abs(g1.walls.max[2] - room.height) < 1e-4,
  `z ${g1.walls.min[2]}..${g1.walls.max[2]} (h=${room.height})`);
check("walls are closed solids (8 tris per edge)", g1.walls.tris === room.footprint.length * 8,
  `${g1.walls.tris} tris / ${room.footprint.length} edges`);
check("floor slab sits under z=0", Math.abs(g1.floor.max[2]) < 1e-4 && g1.floor.min[2] < -0.19,
  `z ${g1.floor.min[2]}..${g1.floor.max[2]}`);

// Thickness/anchor/offset are claims about where the wall FACES sit relative to the footprint
// line. Mitred corners overshoot the bounding box (this room is rotated), so measure the faces.
const faces = async (patch) => {
  await page.evaluate((p) => window.__apply(p), patch);
  return page.evaluate(() => window.__faceDistances());
};
const spread = (fs, key) => Math.max(...fs.map((f) => f[key])) - Math.min(...fs.map((f) => f[key]));
const thick = (fs) => fs.map((f) => Math.abs(f.outer - f.inner));

const f02 = await faces({ thickness: 0.2, anchor: "center", offset: 0 });
check("every wall is exactly the requested thickness", thick(f02).every((t) => Math.abs(t - 0.2) < 1e-4),
  `walls ${thick(f02).map((t) => t.toFixed(3)).join(", ")} m`);
check("centred walls straddle the footprint line", spread(f02, "inner") < 1e-4 && Math.abs(Math.abs(f02[0].inner) - 0.1) < 1e-4,
  `inner ${f02[0].inner.toFixed(3)}, outer ${f02[0].outer.toFixed(3)} m from the line`);

const f06 = await faces({ thickness: 0.6 });
check("thicker walls are thicker on every wall", thick(f06).every((t) => Math.abs(t - 0.6) < 1e-4),
  `0.2 -> ${thick(f06)[0].toFixed(3)} m`);

const fIn = await faces({ thickness: 0.2, anchor: "inside" });
const fOut = await faces({ anchor: "outside" });
// "inside" keeps one face on the line and puts the wall in the room; "outside" mirrors it.
check("inside anchors a face on the footprint line", Math.min(...fIn.map((f) => Math.abs(f.inner))) < 1e-4
  || Math.min(...fIn.map((f) => Math.abs(f.outer))) < 1e-4, `faces at ${fIn[0].inner.toFixed(3)} / ${fIn[0].outer.toFixed(3)}`);
const shift = fOut.map((f, i) => Math.abs((f.inner + f.outer) / 2 - (fIn[i].inner + fIn[i].outer) / 2));
check("outside sits one thickness beyond inside", shift.every((s) => Math.abs(s - 0.2) < 1e-4),
  `centre moved ${shift[0].toFixed(3)} m`);

const fOff = await faces({ anchor: "center", offset: 0.5 });
const moved = fOff.map((f, i) => Math.abs((f.inner + f.outer) / 2 - (f02[i].inner + f02[i].outer) / 2));
check("offset shifts every wall by exactly that much", moved.every((m) => Math.abs(m - 0.5) < 1e-4),
  `walls moved ${moved.map((m) => m.toFixed(3)).join(", ")} m`);
await page.evaluate(() => window.__apply({ offset: 0 }));

await page.evaluate(() => window.__apply({ offset: 0, ceilSlab: true }));
const gCeil = await page.evaluate(() => window.__geom());
check("ceiling slab sits on top of the walls", Math.abs(gCeil.ceil.min[2] - room.height) < 1e-4,
  `ceiling z ${gCeil.ceil.min[2]}..${gCeil.ceil.max[2]}`);

// ---- does it render? --------------------------------------------------------
/**
 * Mean deviation from the background, not a pixel count. Ghost walls cover the same pixels as
 * solid ones -- what changes is how far each pixel departs from the background, which is exactly
 * what "more see-through" means.
 */
const ink = async () => {
  const buf = await page.locator("#host").screenshot();
  return page.evaluate(async (d) => {
    const img = new Image();
    img.src = "data:image/png;base64," + d;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const px = x.getImageData(0, 0, c.width, c.height).data;
    const bg = [0x24, 0x24, 0x24];
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
    }
    return sum / (px.length / 4) / 3 / 255;
  }, buf.toString("base64"));
};

await page.evaluate(() => window.__apply({ ceilSlab: false, shading: "solid", edges: false, opacity: 1, bg: "#242424" }));
await page.waitForTimeout(500);
const inkSolid = await ink();
await page.screenshot({ path: SHOTS + "t1-twin-solid.png" });
check("solid twin renders against the frontend background", inkSolid > 0.005,
  `mean deviation from bg ${(inkSolid * 100).toFixed(2)}%`);

const warmth = async () => {
  const buf = await page.locator("#host").screenshot();
  return page.evaluate(async (d) => {
    const img = new Image(); img.src = "data:image/png;base64," + d; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const px = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] - px[i + 2] > 25) n++;   // red clearly over blue
    return n / (px.length / 4);
  }, buf.toString("base64"));
};
const coolWarm = await warmth();               // the default grey walls: essentially no warm pixels
await page.evaluate(() => window.__apply({ wallColor: "#c96f4a" }));
await page.waitForTimeout(400);
await page.screenshot({ path: SHOTS + "t2-twin-recoloured.png" });
const warm = await warmth();
check("wall colour reaches the render", warm > coolWarm * 20 && warm > 0.005,
  `${(warm * 100).toFixed(2)}% warm pixels, up from ${(coolWarm * 100).toFixed(2)}%`);

await page.evaluate(() => window.__apply({ wallColor: "#9aa6b4", shading: "ghost", edges: false }));
await page.waitForTimeout(400);
const inkGhost = await ink();
await page.screenshot({ path: SHOTS + "t3-twin-ghost.png" });
check("ghost shading is see-through where solid is opaque", inkGhost < inkSolid * 0.6,
  `${(inkGhost * 100).toFixed(2)}% vs ${(inkSolid * 100).toFixed(2)}%`);

await page.evaluate(() => window.__apply({ shading: "wire" }));
await page.waitForTimeout(400);
const inkWire = await ink();
await page.screenshot({ path: SHOTS + "t4-twin-wire.png" });
// Not "lighter than ghost": 57 walls of crisp lines legitimately out-deviate near-invisible
// ghost faces, so wall count decides that ordering. What always holds is that wire drops the
// faces entirely -- structurally, not just visually.
const wireParts = await page.evaluate(() => window.__parts());
check("wire shading draws edges and no faces", wireParts.meshes === 0 && wireParts.lines > 0,
  `${wireParts.meshes} meshes, ${wireParts.lines} line sets`);
check("wireframe is lighter than solid", inkWire < inkSolid,
  `${(inkWire * 100).toFixed(2)}% vs ${(inkSolid * 100).toFixed(2)}%`);

await page.evaluate(() => window.__apply({ shading: "solid", bg: "#0d1013" }));
await page.waitForTimeout(400);
await page.screenshot({ path: SHOTS + "t5-twin-darkbg.png" });
const bgPixel = await page.evaluate(() => {
  const c = document.querySelector("#host canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  return gl ? "webgl" : "none";
});
check("background control drives the renderer", bgPixel === "webgl");

// Panel disables the generated-only rows when the source is the real IFC.
await page.evaluate(() => window.__apply({ source: "ifc" }));
const disabled = await page.evaluate(() =>
  [...document.querySelectorAll(".twin-row")].filter((r) => r.classList.contains("disabled")).length);
check("real-IFC source greys out the thickness controls", disabled === 3, `${disabled} rows disabled`);
const inertInputs = await page.evaluate(() =>
  [...document.querySelectorAll(".twin input, .twin .seg button")].filter((i) => i.disabled).length);
check("generated-only inputs are actually inert on the real-IFC source", inertInputs >= 8,
  `${inertInputs} disabled inputs`);

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
await browser.close();
process.exit(fails ? 1 : 0);
