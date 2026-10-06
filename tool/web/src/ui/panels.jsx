/** The Clean inspector's editors: crop faces, refine nudge, twin look. */

import { HStack, VStack, StackItem } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { Button } from "@astryxdesign/core/Button";
import { Switch } from "@astryxdesign/core/Switch";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { RotateCcw, MonitorSmartphone, Square, Ghost, Grid3x3 } from "lucide-react";
import { useStore } from "../store.js";
import { actions } from "../engine.js";
import { SLIDER_MIN, SLIDER_MAX } from "../faces.js";
import { SliderField } from "./controls.jsx";

// ---------------------------------------------------------------- crop faces

function FaceBlock({ title, sub, children, id }) {
  return (
    <VStack gap={2} id={id}>
      <HStack gap={2} vAlign="baseline">
        <Text weight="semibold">{title}</Text>
        {sub ? <Text type="supporting">{sub}</Text> : null}
      </HStack>
      {children}
    </VStack>
  );
}

function OffsetFeather({ offset, feather, setOffset, setFeather }) {
  return (
    <>
      <SliderField label="Offset" unit="m" min={SLIDER_MIN} max={SLIDER_MAX} value={offset} onChange={setOffset} />
      <SliderField label="Feather" unit="m" min={0} max={SLIDER_MAX} hardMin={0} value={feather} onChange={setFeather} />
    </>
  );
}

/** Per-face offset + feather. Re-renders on `clean.facesV`, which the engine bumps on every edit. */
export function FacesPanel() {
  useStore((s) => s.clean.facesV);
  const m = actions.faces();
  if (!m) return null;
  const p = m.params;
  const dims = m.dims();
  const fl = m.floaterRange();
  const k = m.overridden.size;

  const walls = Array.from({ length: m.n }, (_, i) => (
    <FaceBlock key={i} title={`Wall ${i}`} sub={`${m.room.walls[i].length.toFixed(2)} m`}>
      <OffsetFeather offset={p.wallOffset[i]} feather={p.wallFeather[i]}
        setOffset={(v) => m.setWall(i, "offset", v)} setFeather={(v) => m.setWall(i, "feather", v)} />
    </FaceBlock>
  ));

  return (
    <VStack gap={4} id="faces">
      {m.rect ? (
        <FaceBlock title="Resize crop" sub="grow + / trim − per side" id="resize">
          {m.resizeGroups().map((g) => (
            <SliderField key={g.key} label={g.label} unit="m" min={SLIDER_MIN} max={SLIDER_MAX}
              value={m.getGrow(g.idxs)} onChange={(v) => m.setGrow(g.idxs, v)} />
          ))}
          <Text type="supporting" hasTabularNumbers>
            ≈ {dims.w.toFixed(2)} × {dims.h.toFixed(2)} m · footprint {dims.baseW.toFixed(2)} × {dims.baseH.toFixed(2)}
          </Text>
        </FaceBlock>
      ) : null}

      <FaceBlock title="All walls" sub={`${m.n} ${m.n === 1 ? "wall" : "walls"}`}>
        <OffsetFeather offset={p.wallOffset[0]} feather={p.wallFeather[0]}
          setOffset={(v) => m.setMaster("offset", v)} setFeather={(v) => m.setMaster("feather", v)} />
        {k ? <Text type="supporting" color="accent">{k} wall{k === 1 ? "" : "s"} overridden — moving All walls resets them.</Text> : null}
      </FaceBlock>

      <Collapsible defaultIsOpen={false} chevronPosition="start"
        trigger={<Text weight="semibold">Floor, ceiling, per-wall and floaters</Text>}>
        <VStack gap={4} paddingBlockStart={3}>
          <FaceBlock title="Floor" sub="z = 0">
            <OffsetFeather offset={p.floorOffset} feather={p.floorFeather}
              setOffset={(v) => m.setParam("floorOffset", v)} setFeather={(v) => m.setParam("floorFeather", v)} />
          </FaceBlock>
          <FaceBlock title="Ceiling" sub={`z = ${m.room.height.toFixed(2)} m`}>
            <OffsetFeather offset={p.ceilOffset} feather={p.ceilFeather}
              setOffset={(v) => m.setParam("ceilOffset", v)} setFeather={(v) => m.setParam("ceilFeather", v)} />
          </FaceBlock>
          <Divider />
          {walls}
          <Divider />
          <FaceBlock title="Floaters" sub="0 = off">
            <SliderField label="Max size" min={0} max={fl.max} step={fl.step} hardMin={0} dp={3}
              value={p.maxScale} onChange={(v) => m.setParam("maxScale", v)} />
            <SliderField label="Min opacity" min={0} max={0.3} step={0.005} hardMin={0} dp={3}
              value={p.minOpacity} onChange={(v) => m.setParam("minOpacity", v)} />
          </FaceBlock>
        </VStack>
      </Collapsible>
    </VStack>
  );
}

// ---------------------------------------------------------------- refine nudge

const DEG = Math.PI / 180;

/** Nudge the whole splat on top of the solve. Rotation is about the room centre. */
export function RefinePanel() {
  const r = useStore((s) => s.clean.refine);
  const roomSize = useStore((s) => s.clean.roomSize);
  const nudged = useStore((s) => s.clean.nudged);
  // Translation range follows the room: ±half its size is plenty to nudge, never to lose it.
  const tRange = Math.max(roomSize * 0.5, 1);
  const set = (fn) => {
    const next = { scale: r.scale, rotation_euler_xyz: [...r.rotation_euler_xyz], translation: [...r.translation] };
    fn(next);
    actions.setRefine(next);
  };
  const rot = (i, label) => (
    <SliderField label={label} unit="°" min={-180} max={180} step={0.1} dp={1}
      value={r.rotation_euler_xyz[i] / DEG} onChange={(d) => set((n) => { n.rotation_euler_xyz[i] = d * DEG; })} />
  );
  const tr = (i, label) => (
    <SliderField label={label} unit="m" min={-tRange} max={tRange} step={0.01}
      value={r.translation[i]} onChange={(x) => set((n) => { n.translation[i] = x; })} />
  );
  return (
    <VStack gap={3} id="refine">
      {rot(2, "Yaw")}
      {rot(0, "Pitch")}
      {rot(1, "Roll")}
      <Divider />
      {tr(0, "X")}
      {tr(1, "Y")}
      {tr(2, "Z")}
      <Divider />
      <SliderField label="Scale" unit="×" min={0.5} max={2} step={0.001} dp={3} hardMin={1e-6}
        value={r.scale} onChange={(x) => set((n) => { n.scale = x; })} />
      <Button id="refine-reset" label="Reset nudge" size="sm" variant="secondary" isDisabled={!nudged}
        icon={<Icon icon={RotateCcw} />} onClick={actions.resetRefine} />
    </VStack>
  );
}

// ---------------------------------------------------------------- twin look

function Swatch({ label, value, onChange, isDisabled }) {
  return (
    <label className="swatch">
      <input type="color" value={value} disabled={isDisabled} onChange={(e) => onChange(e.target.value)} />
      <Text type="supporting" color={isDisabled ? "disabled" : undefined}>{label}</Text>
    </label>
  );
}

function Labeled({ label, children, isDisabled }) {
  return (
    <VStack gap={1}>
      <Text type="label" color={isDisabled ? "disabled" : "secondary"}>{label}</Text>
      {children}
    </VStack>
  );
}

/**
 * How the IFC will read over the splat in the frontend. Every control writes the style and the
 * walls follow live; the wall thickness is written into the exported cleaned.ifc.
 */
export function TwinPanel() {
  const st = useStore((s) => s.clean.twin);
  const custom = useStore((s) => s.clean.custom);
  const set = (patch) => actions.setTwinStyle(patch);
  const gen = st.source === "generated";
  const note = custom
    ? "A drawn box has no source IFC — walls are generated from the footprint you drew."
    : gen
      ? "Walls built from the footprint at the thickness below. This is the geometry cleaned.ifc describes, so it's what the frontend will show."
      : "The real tessellated IFC at its true wall thickness. Switch to Generated to change thickness or offset.";
  return (
    <VStack gap={4} id="twin">
      <Labeled label="Source">
        <SegmentedControl label="Twin source" layout="fill" size="sm" value={st.source}
          isDisabled={custom} disabledMessage="A drawn box has no source IFC"
          onChange={(v) => set({ source: v })}>
          <SegmentedControlItem value="ifc" label="Real IFC" />
          <SegmentedControlItem value="generated" label="Generated" />
        </SegmentedControl>
        <Text type="supporting">{note}</Text>
      </Labeled>
      <Labeled label="Shading">
        <SegmentedControl label="Shading" layout="fill" size="sm" value={st.shading}
          onChange={(v) => set({ shading: v })}>
          <SegmentedControlItem value="solid" label="Solid" icon={<Icon icon={Square} size="sm" />} />
          <SegmentedControlItem value="ghost" label="Ghost" icon={<Icon icon={Ghost} size="sm" />} />
          <SegmentedControlItem value="wire" label="Wire" icon={<Icon icon={Grid3x3} size="sm" />} />
        </SegmentedControl>
      </Labeled>
      <SliderField label="Wall thickness" unit="m" min={0.02} max={0.6} hardMin={0.005}
        isDisabled={!gen} value={st.thickness} onChange={(v) => set({ thickness: v })} />
      <Labeled label="Sits on the footprint line" isDisabled={!gen}>
        <SegmentedControl label="Wall anchor" layout="fill" size="sm" value={st.anchor} isDisabled={!gen}
          onChange={(v) => set({ anchor: v })}>
          <SegmentedControlItem value="inside" label="Inside" />
          <SegmentedControlItem value="center" label="Centre" />
          <SegmentedControlItem value="outside" label="Outside" />
        </SegmentedControl>
      </Labeled>
      <SliderField label="Wall offset" description="+ outward" unit="m" min={-1} max={1}
        isDisabled={!gen} value={st.offset} onChange={(v) => set({ offset: v })} />
      <SliderField label="Opacity" min={0} max={1} hardMin={0} value={st.opacity} onChange={(v) => set({ opacity: v })} />
      <HStack gap={3} hAlign="between">
        <Swatch label="Walls" value={st.wallColor} onChange={(v) => set({ wallColor: v })} />
        <Swatch label="Slabs" value={st.slabColor} isDisabled={!gen} onChange={(v) => set({ slabColor: v })} />
        <Swatch label="Edges" value={st.edgeColor} onChange={(v) => set({ edgeColor: v })} />
        <Swatch label="Background" value={st.bg} onChange={(v) => set({ bg: v })} />
      </HStack>
      <VStack gap={2}>
        <Switch size="sm" label="Edge lines" value={!!st.edges} onChange={(on) => set({ edges: on })} />
        <Switch size="sm" label="Floor slab" value={!!st.floorSlab} isDisabled={!gen} onChange={(on) => set({ floorSlab: on })} />
        <Switch size="sm" label="Ceiling slab" value={!!st.ceilSlab} isDisabled={!gen} onChange={(on) => set({ ceilSlab: on })} />
        <Switch size="sm" label="Twin lighting" value={!!st.twinLight} onChange={(on) => set({ twinLight: on })}
          labelTooltip="Match the frontend's ambient/key light rig" />
      </VStack>
      <HStack gap={2}>
        <StackItem size="fill">
          <Button label="Match frontend" size="sm" width="100%" icon={<Icon icon={MonitorSmartphone} />}
            tooltip="Solid shading on the digital-twin background, edges off — how the frontend renders it"
            onClick={actions.matchFrontend} />
        </StackItem>
        <StackItem size="fill">
          <Button label="Reset look" size="sm" variant="ghost" width="100%" icon={<Icon icon={RotateCcw} />}
            onClick={actions.resetTwinStyle} />
        </StackItem>
      </HStack>
    </VStack>
  );
}
