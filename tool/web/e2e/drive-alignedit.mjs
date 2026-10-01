/**
 * Align stage: a placed pair point can be selected and dragged in BOTH panes (the "move after
 * clicking" the custom Draw stage already had, now for real IFC pairs). Needs both servers and a
 * mounted splat, like drive.mjs.
 *   node e2e/drive-alignedit.mjs [splatIndex] [room]
 */
import { chromium } from "playwright";

const SPLAT_IDX = Number(process.argv[2] ?? 6);   // Libra_Lab in the current vault listing
const ROOM = process.argv[3] ?? "libra_lab";
const SHOTS = "e2e/shots/";
const BASE = "http://127.0.0.1:5180";

const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

let fails = 0;
const check = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#splat-list .item", { timeout: 20000 });
  await page.locator("#splat-list .item").nth(SPLAT_IDX).click();
  await page.locator(`#room-list .item:has(.m:text-is("${ROOM}"))`).click();
  await page.locator("#go-align").click();
  console.log("loading splat (streams the SOG)…");
  await page.waitForFunction(
    () => /[\d,]+ splats/.test(document.querySelector("#splat-count")?.textContent ?? ""),
    { timeout: 300000 });

  // Place four pairs through the app's own addPoint() path.
  await page.evaluate(() => {
    const box = window.__e2eSplatBox(), room = window.__e2eRoom();
    const fp = room.footprint;
    const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2, cz = box.min[2];
    // A splat point per footprint corner (positions don't matter for the edit test).
    const pairs = fp.slice(0, 4).map(([x, y], i) => ({
      splat: [cx + (x) * 0.01 + i * 0.01, cy + (y) * 0.01, cz],
      room: [x, y, 0],
    }));
    window.__e2eSetPairs(pairs);
  });
  await page.waitForTimeout(300);
  const nPairs = await page.locator("#pairs .pair").count();
  check("four pairs placed", nPairs === 4, `${nPairs} pairs`);

  // Nothing selected yet -> gizmos detached.
  let gz = await page.evaluate(() => [window.__e2eAlignGizmo("splat"), window.__e2eAlignGizmo("room")]);
  check("no gizmo attached before selecting", !gz[0].attached && !gz[1].attached);

  // Click pair B's row -> both panes' gizmos attach to pair index 1.
  await page.locator("#pairs .pair").nth(1).click();
  await page.waitForTimeout(150);
  gz = await page.evaluate(() => [window.__e2eAlignGizmo("splat"), window.__e2eAlignGizmo("room")]);
  check("selecting a pair attaches a gizmo in the SPLAT pane", gz[0].attached && gz[0].pairIndex === 1,
    JSON.stringify(gz[0]));
  check("selecting a pair attaches a gizmo in the ROOM pane", gz[1].attached && gz[1].pairIndex === 1,
    JSON.stringify(gz[1]));
  check("the selected row is marked", await page.locator("#pairs .pair.sel").count() === 1);
  await page.screenshot({ path: `${SHOTS}ae1-selected.png` });

  // Solve first so we can prove a move invalidates the fit.
  await page.locator("#solve").click();
  await page.waitForTimeout(400);
  const solvedBefore = await page.evaluate(() => window.__e2eMatrix() != null);

  // Drag the splat point of the selected pair.
  const before = await page.evaluate(() => {
    const box = window.__e2eSplatBox();
    return [box.min[0], box.min[1], box.min[2]];
  });
  const target = [before[0] + 0.3, before[1] - 0.2, before[2] + 0.1];
  const moved = await page.evaluate((t) => window.__e2eAlignMove("splat", t), target);
  check("dragging the splat point rewrites the pair", moved.pair && dist(moved.pair, target) < 1e-6,
    `pair.splat -> [${moved.pair.map((n) => n.toFixed(2))}]`);
  check("moving a point invalidates the solved alignment", moved.solutionCleared && solvedBefore,
    `solvedBefore=${solvedBefore} cleared=${moved.solutionCleared}`);

  // Drag the room point too (the other pane).
  const roomTarget = [1.23, -0.45, 0];
  const movedR = await page.evaluate((t) => window.__e2eAlignMove("room", t), roomTarget);
  check("dragging the room point rewrites the pair", movedR.pair && dist(movedR.pair, roomTarget) < 1e-6,
    `pair.room -> [${movedR.pair.map((n) => n.toFixed(2))}]`);

  // Deselect by clicking the row again.
  await page.locator("#pairs .pair").nth(1).click();
  await page.waitForTimeout(120);
  gz = await page.evaluate(() => [window.__e2eAlignGizmo("splat"), window.__e2eAlignGizmo("room")]);
  check("clicking the row again deselects (gizmos detach)", !gz[0].attached && !gz[1].attached);

  // Deleting a pair drops the selection cleanly (no stray gizmo on a shifted index).
  await page.locator("#pairs .pair").nth(0).click();       // select A
  await page.locator("#pairs .pair").nth(0).locator(".del").click(); // delete A
  await page.waitForTimeout(150);
  gz = await page.evaluate(() => [window.__e2eAlignGizmo("splat"), window.__e2eAlignGizmo("room")]);
  check("deleting the selected pair detaches its gizmos", !gz[0].attached && !gz[1].attached);
  check("delete removed one pair", await page.locator("#pairs .pair").count() === 3);

  const hard = errors.filter((e) => !/favicon|DevTools|Download the React|404/i.test(e));
  check("no page errors", hard.length === 0, hard.slice(0, 2).join(" | ").slice(0, 200));
} catch (e) {
  console.log("FAIL  driver threw —", e.message);
  await page.screenshot({ path: `${SHOTS}ae-error.png` }).catch(() => {});
  fails++;
}

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
await browser.close();
process.exit(fails ? 1 : 0);
