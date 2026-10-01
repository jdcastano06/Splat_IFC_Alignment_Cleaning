# Splat ↔ IFC Aligner & Cleaner

Align a Gaussian-splat scan to its IFC room by clicking corresponding points, then crop and
feather the splat to the room boundary and export a cleaned PLY + SOG.

## Run

Two processes. From `tool/`:

```bash
# 1. backend  (reads IFC/, the splat vault, and writes out/)
cd server && python3 -m uvicorn app:app --port 8777

# 2. frontend
cd web && npm install && npm run dev
```

Open the URL Vite prints (default http://localhost:5180). The frontend proxies `/api` to the
backend, so both must be up.

Splats are read from `/Volumes/SMART_vault/06_Research_projects/Splats` — override with
`SPLAT_ROOT=/path uvicorn ...` if it lives elsewhere.

## Workflow

1. **Select** — pick a scan and its room. (Pairing is manual: names don't line up, and only 5 of
   9 rooms have a scan.) No IFC for this space? Pick **✏️ Draw a custom box** instead — see below.
2. **Align** — split view, splat left / IFC right. Click a feature in one pane, then the matching
   feature in the other, to make a lettered pair (A↔A, same colour both sides). **≥3 pairs**, then
   **Solve**. `Z-up / yaw only` is on by default and is usually more stable.
   - **WASD** fly · **Q/E** down/up · **Shift** faster · mouse to orbit. Fly speed scales to the
     scene, so it works in a 2 m closet and a 90 m scan alike.
   - **Points** toggle overlays the splat centres as a blue point cloud (like SuperSplat), which
     makes walls and corners far easier to click than the soft gaussian blur.
   - **Move a point after placing it.** Click a pair in the list to select it; a move-gizmo appears
     on that pair's point in **both** panes (splat and IFC), so you can drag either onto the right
     feature instead of deleting and re-clicking — the same editing the custom Draw stage gives its
     corners. Dragging invalidates the current solve; click **Solve** again. Click the row a second
     time to deselect.
3. **Clean** — merged view in room space. Toggles across the top: **Preview crop**, **Room
   outline** (the adjustable wireframe box), **IFC walls** / **Twin** (the building model over the
   splat — same state, two places to reach it), and **Edit points**. Then four collapsible sections:
   - **Twin preview** — how the IFC will read *in the frontend*, over this splat, before you
     export. The digital-twin viewer renders opaque shaded solids on a dark grey background, so
     this pane can too: **Match frontend** sets that look in one click (solid shading, the
     frontend's `#242424` background and its ambient/key light rig). Then tune it:
     - **Source** — *Real IFC* is the tessellated building at its true wall thickness (what you
       have). *Generated* builds the walls from the room footprint at a thickness **you** choose —
       and that is the geometry `cleaned.ifc` describes, so it is the one that predicts the
       frontend. Thickness/offset controls only apply to *Generated*; a drawn box is always
       generated (there is no source IFC to tessellate).
     - **Shading** — *Solid* (frontend-like, hides the splat behind it), *Ghost* (see the scan
       through the walls while judging alignment), *Wire* (edge lines only, no faces).
     - **Wall thickness**, **Sits** (inside / centred / outside the footprint line) and **Wall
       offset** move the wall faces; corners are mitred, so a 57-gon stays watertight.
     - Colours for walls, slabs, edges and the background; **Floor/Ceiling slab**; **Opacity**.

     The look persists across sessions, and **the wall thickness you settle on is written into the
     exported `cleaned.ifc`** — so the file the frontend loads is the wall you were looking at.
   - **Refine alignment** — nudge the whole splat (yaw/pitch/roll, XYZ, scale) on top of the
     solve; rotation is about the room centre. **Reset nudge** restores the solve exactly.
   - **Point pairs** — tick *Edit points*, click a lettered point, drag it onto the splat feature
     it belongs to; releasing re-solves.
   - **Cleaning** — **Room height** (IFC extrusions are often not to scale, so set the true
     ceiling here; it moves the crop's ceiling and the wireframe, while the IFC-walls reference
     stays at true scale), then per-face offset + feather. A 4-wall room shows master + Wall 0–3 +
     Floor + Ceiling; a 57-wall room shows a master with an expander. Sliders have a comfortable
     range; the **number box next to each is unbounded** — type any offset (e.g. `-12.5`).
### Draw a custom box (no IFC)

When a room has no IFC model, select **✏️ Draw a custom box**. Stage 2 becomes a **Draw** stage:
turn on **Points**, then click the room's **floor corners** in order. Three or more corners define
the footprint; the walls extrude up to the **Height** you set. A best-fit plane through your clicks
becomes the floor (so the box is level even though the scan isn't gravity-aligned), and the box is
built in the same `{footprint, height, transform}` form an IFC room produces — so **everything
downstream is identical**: per-wall offset/feather, room-height, refine, export.

Corners are draggable in the **Draw** stage too: click a corner in the sidebar list to select it and
a move-gizmo appears — drag it into place. **Height** is unbounded (the slider is a quick range; type
any value in the number box). In Clean you can likewise drag the **footprint corners** (Edit points)
to reshape the box — the crop re-bakes live — and use **Refine** to nudge the fit. The client
authors the box and sends it verbatim to the server for export, so the exported crop is exactly the
preview.

Markers/corners draw on top of the splat by default (so they're easy to find). Gaussian splats don't
write a depth buffer, so to make a corner *hide when it goes behind the splat* there's an **Occlude**
toggle (Draw panel and Clean toggles): it switches the splat to depth-writing rendering — points get
properly occluded, at the cost of a slightly grainier splat. Off by default.

4. **Export** — writes to the **vault**, `…/Splats/_Cleaned/<room>/<scan>/` (custom boxes under
   `_Cleaned/custom/`), so the big files don't pile up on the laptop. Override with `OUT_ROOT=…`;
   if the vault isn't mounted it falls back to a local `out/` and the panel says so. Each export
   writes:
   - `cleaned.ply` (full-precision, transformed + cropped)
   - `cleaned.sog` (compressed, for the web)
   - `cleaned.ifc` (**a room IFC of the box actually used**, in the cleaned splat's frame — metres,
     floor at z=0 — so it overlays the splat one-to-one. This reflects a custom box, an overridden
     height, and the **wall thickness set in Twin preview**, none of which a source IFC captures;
     it's written on every export.)
   - `cleaned.alignment.json` (sidecar: transform, refine, crop, pairs, kept count)

   `IFC/<room>/config.json` is **never modified** — the alignment lives only in the sidecar.

### Reopen a previous export

Stage 1 lists everything already under `OUT_ROOT` as **Reopen a cleaned export**. Click one to jump
straight back to **Clean** with that export's transform, manual refine, per-face offset/feather and
room height restored exactly as they were — tweak and re-export to overwrite the same files in place.
The reload reads only the `cleaned.alignment.json` sidecar (plus a small `reopen` block it now
writes): IFC rooms restore from their point pairs, custom boxes from the stored footprint + box
transform. Exports made before this feature show greyed-out (custom boxes can't be rebuilt without
that block) — re-export one normally to make it reopenable; an entry whose source scan isn't mounted
is greyed out too.

## Automatic cleaning (no IFC, no clicks)

Most scans have no IFC, so the tool can find the room itself and emit both outputs -- the cleaned
splat **and** an IFC of the room:

- **In the app:** pick a scan, then **⚡ Auto room** → **Detect room → Clean**. The detected box
  opens in Clean exactly like a drawn custom box (walls, floor, ceiling, floater filter and twin
  look pre-set), so you only nudge and **Export**.
- **Hands-off batch** (from `server/`):

  ```bash
  python3 auto_clean.py --new                    # every scan with no export yet
  python3 auto_clean.py "Space_1/Space_1-20260701" ...    # specific scans (ids as listed in the app)
  python3 auto_clean.py --all --detect-only ../../out/review   # previews only, nothing exported
  ```

  Each scan gets `auto.ply`, `auto.sog`, `auto.ifc`, `auto.alignment.json` and `auto.preview.png`
  (plan + elevation of the cut) under `_Cleaned/custom/<scan>/`. The label is `auto`, so a
  hand-made `cleaned.*` is never overwritten, and every result is listed under **Reopen a cleaned
  export** for touch-ups.

How the room is found (`server/auto_room.py`):

1. **Manhattan frame.** A flat gaussian's thinnest axis is its surface normal; the three dominant
   orthogonal normal directions give up (the one nearest +z) and the wall direction. This levels
   scans that come out tilted (some SOG pipelines are up to ~20° off) and squares the walls to the
   grid.
2. **Floor & ceiling.** A safe estimate (outer dense height bins) and a tight one (outermost
   horizontal-disc slabs, i.e. real floor/ceiling surfaces). Tight wins on a side only when what it
   trims is negligible -- so floater haze above the ceiling and the mirrored room under a glossy
   floor are cut, but a mezzanine or a desk never masquerades as the floor.
3. **Footprint.** Top-down maps of all structure and of the ceiling layer; dense cells are closed,
   hole-filled (furniture is part of the room), merged and outlined, then simplified (Visvalingam)
   and snapped to the wall axes -- typically 4–12 corners.
4. **Floater filter.** Splats larger than 1 % of the room (≈0.1–0.4 % of splats -- the bright
   needles and blobs) are dropped. It's the **Floaters** row in Clean (max size / min opacity,
   0 = off) and, like the crop, is the same formula in the preview shader and the export.

Scale stays in scan units (as with a drawn box): scans from 360 video have no metric scale.
Tuning tools: `tests/tune_auto_room.py` renders plan + elevation contact sheets for every scan;
`tests/bench_auto_room.py` compares against hand-drawn boxes.

## How it works

- **Preview from SOG, export from PLY.** They're byte-for-byte the same splats in the same order,
  so the fast 69 MB SOG drives the viewer while the 300 MB PLY gives a full-precision export.
  A scan with **only** a `gs.sog` (no `gs.ply`) exports too: the server decodes the SOG to a PLY
  once (cached in `.cache/sog_ply/`, invalidated when the SOG changes) and runs the same export.
  Such scans usually carry view-dependent SH (`f_rest_*`), which the export rotates with the
  splat band by band, so specular colour stays correct after alignment.
- **Baked SDF.** Each room footprint is baked once into a `(signed distance, nearest-wall-index)`
  grid. Every slider is then just a shader uniform — no re-bake — which is what makes 5.3 M splats
  feather in real time and handles non-convex 57-gons that analytic box SDFs can't.
- **One crop formula, two languages.** `server/crop.py` (export) and `web/src/crop-shared.js`
  (preview GLSL) are pinned equal by `tests/test_parity.py`, so what you feather is what you get.
- **Alignment** is Umeyama similarity, solved server-side so preview and export share the numbers.
  The manual refine composes as a second similarity about the room centre.

## Tests

```bash
python3 -m pytest tests/                      # unit + parity tests, incl. SOG-only export (fast)
cd web && node e2e/drive.mjs libra_lab 4      # IFC path: real browser + GPU (needs both servers up)
cd web && node e2e/drive-custom.mjs 4         # draw-your-own-box path, end to end
cd web && node e2e/drive-twin.mjs libra_lab   # twin preview: wall geometry + how it renders
cd web && node e2e/drive-twin.mjs machine_shop  # ...and again on the 57-wall room
cd web && node e2e/drive-alignedit.mjs        # Align: select a pair, drag its points in both panes
cd web && node e2e/drive-fly.mjs              # fly camera looks in place; orbit re-pivots cleanly
cd web && node e2e/drive-auto.mjs "Space 7-20260701"   # ⚡ Auto room: detect -> Clean -> crop + twin
python3 tests/smoke_export.py libra_lab       # full export against the 300 MB PLY (minutes)
```

`tests/test_parity.py` and `e2e/drive.mjs` are the ones that matter: the first proves the export
math equals the preview math; the second drives the real app and confirms the crop shader
actually removes splats. `drive-twin.mjs` needs only the backend and a room (no splat vault), and
measures the wall faces rather than a bounding box — mitred corners overshoot the box, so on a
rotated room the box says 0.274 m where the wall is 0.200 m thick.
```
