/**
 * Stage 3: the merged view in room space. A floating toolbar toggles what's drawn; the inspector
 * (budget 380) holds the crop, the refine nudge, the points and the twin look as a divided
 * accordion; export is pinned to its foot.
 */

import {
  Layout, LayoutContent, LayoutPanel, LayoutFooter, LayoutHeader, HStack, VStack, StackItem, Section,
} from "@astryxdesign/core/Layout";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Switch } from "@astryxdesign/core/Switch";
import { Badge } from "@astryxdesign/core/Badge";
import { Token } from "@astryxdesign/core/Token";
import { Banner } from "@astryxdesign/core/Banner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Divider } from "@astryxdesign/core/Divider";
import { Spinner } from "@astryxdesign/core/Spinner";
import {
  Scissors, BoxSelect, Building2, Move3d, Layers, FlipVertical2, Download, Plus, X,
} from "lucide-react";
import { useStore } from "../store.js";
import { actions } from "../engine.js";
import { Viewport, NavControls, KeyHints, Chip, Num, Float, SliderField, fmtMB, fmtM } from "./controls.jsx";
import { FacesPanel, RefinePanel, TwinPanel } from "./panels.jsx";

function ViewToggle({ id, k, label, icon, tooltip }) {
  const on = useStore((s) => s.clean[k]);
  return (
    <ToggleButton id={id} size="sm" label={label} isPressed={on} tooltip={tooltip}
      icon={<Icon icon={icon} size="sm" />} onPressedChange={(v) => actions.setCleanToggle(k, v)}>
      {label}
    </ToggleButton>
  );
}

function CleanToolbar() {
  const custom = useStore((s) => s.clean.custom);
  return (
    <Float label="View">
      <ViewToggle id="crop-on" k="cropOn" label="Crop" icon={Scissors} tooltip="Preview the crop on the splat" />
      <ViewToggle id="show-room" k="showRoom" label="Outline" icon={BoxSelect} tooltip="Room outline — the adjustable crop box" />
      <ViewToggle id="twin-on" k="twinOn" label={custom ? "Twin" : "IFC / Twin"} icon={Building2}
        tooltip="Show the building model over the splat — style it in Twin preview" />
      <ViewToggle id="show-points" k="showPoints" label="Points" icon={Move3d} tooltip="Edit points: drag lettered points with the gizmo" />
      <ViewToggle id="clean-occlude" k="occlude" label="Occlude" icon={Layers}
        tooltip="Hide points and handles behind the splat (splat gets grainier)" />
      {custom ? (
        <>
          <Divider orientation="vertical" />
          <IconButton id="flip-room" size="sm" variant="ghost" label="Flip upside down"
            tooltip="Scan came out upside down? Flips the splat and its box together"
            icon={<Icon icon={FlipVertical2} size="sm" />} onClick={actions.flip} />
        </>
      ) : null}
    </Float>
  );
}

function CleanViewport() {
  const ready = useStore((s) => s.clean.ready);
  return (
    <Viewport which="clean">
      <div className="vp-anchor vp-tc"><CleanToolbar /></div>
      <div className="vp-anchor vp-tr"><NavControls which="clean" /></div>
      <div className="vp-anchor vp-bl"><KeyHints /></div>
      {!ready ? (
        <div className="vp-anchor vp-center">
          <Float label="Loading"><HStack gap={2} vAlign="center" paddingInline={2}><Spinner size="sm" />
            <Text color="secondary">Preparing the clean view…</Text></HStack></Float>
        </div>
      ) : null}
    </Viewport>
  );
}

// ---------------------------------------------------------------- inspector sections

/** Accordion trigger: icon, title, and a status at the end. */
function SectionTrigger({ title, meta }) {
  return (
    <HStack gap={3} vAlign="center" width="100%" paddingInline={4}>
      <StackItem size="fill"><Text weight="semibold">{title}</Text></StackItem>
      {meta}
    </HStack>
  );
}

/** Section body: the one gutter every section shares with the trigger. */
function Body({ children }) {
  return <Section padding={4} paddingBlockStart={1}><VStack gap={4}>{children}</VStack></Section>;
}

function RoomHeader() {
  const room = useStore((s) => s.clean.room);
  return (
    <VStack gap={2}>
      <Heading level={3} maxLines={1}>{room.name || "Room"}</Heading>
      <HStack gap={1} wrap="wrap">
        <Token size="sm" label={`${room.walls} walls`} />
        <Token size="sm" label={`${room.area.toFixed(1)} m²`} />
        <Token size="sm" label={`h ${room.height.toFixed(2)} m`} />
      </HStack>
    </VStack>
  );
}

function CropSection() {
  const h = useStore((s) => s.clean.roomHeight);
  return (
    <Body>
      <SliderField label="Room height" unit="m" min={0.5} max={8} step={0.01} hardMin={0.1}
        description="IFC heights are often not to scale; set the true ceiling here." value={h} onChange={actions.setRoomHeight} />
      <Divider />
      <Text type="supporting">Offset trims the boundary (type past the slider for more); feather fades inside it.</Text>
      <FacesPanel />
    </Body>
  );
}

function PointsSection() {
  const pts = useStore((s) => s.clean.points);
  const custom = useStore((s) => s.clean.custom);
  const n = pts.rows.length;
  return (
    <VStack gap={0}>
      <Section padding={4} paddingBlockStart={1} paddingBlockEnd={2}>
        <Text color="secondary">
          {custom
            ? "Click a corner to select it, then drag the gizmo. + adds a corner halfway to the next; × removes one."
            : "Click a lettered point, then drag it onto the splat feature it belongs to. Releasing re-solves."}
        </Text>
      </Section>
      <List id="clean-pairs" hasDividers density="compact">
        {pts.rows.map((r, i) => (
          <ListItem
            key={i}
            className={`cpair${i === pts.selected ? " sel" : ""}`}
            isSelected={i === pts.selected}
            onClick={() => actions.selectCleanPoint(i)}
            startContent={<Chip label={r.label} color={r.color} />}
            label={<Num color="secondary">{r.text}</Num>}
            endContent={
              <HStack gap={1} vAlign="center">
                {r.res != null ? <Num color={r.bad ? "accent" : "secondary"}>{fmtM(r.res)}</Num> : null}
                {custom ? (
                  <>
                    <IconButton label={`Add a corner after ${r.label}`} size="sm" variant="ghost" data-act="add"
                      icon={<Icon icon={Plus} size="sm" />}
                      onClick={(e) => { e.stopPropagation(); actions.addCornerAfter(i); }} />
                    <IconButton label="Remove this corner" size="sm" variant="ghost" data-act="del" isDisabled={n <= 3}
                      icon={<Icon icon={X} size="sm" />}
                      onClick={(e) => { e.stopPropagation(); actions.removeCorner(i); }} />
                  </>
                ) : null}
              </HStack>
            }
          />
        ))}
      </List>
      {pts.rms != null || pts.error ? (
        <Section padding={4} paddingBlockStart={3}>
          {pts.error ? <Banner status="error" title="Re-solve failed" description={pts.error} /> : (
            <HStack gap={2} vAlign="baseline">
              <Text type="display-3" hasTabularNumbers>{pts.rms.toFixed(3)}</Text>
              <Text color="secondary">m RMS</Text>
              <StackItem size="fill" />
              <Badge variant={pts.rms < 0.05 ? "success" : "warning"} label={pts.rms < 0.05 ? "Good fit" : "Check points"} />
            </HStack>
          )}
        </Section>
      ) : null}
    </VStack>
  );
}

function Inspector() {
  const nudged = useStore((s) => s.clean.nudged);
  const custom = useStore((s) => s.clean.custom);
  const nPts = useStore((s) => s.clean.points.rows.length);
  const twin = useStore((s) => s.clean.twin);
  const twinOn = useStore((s) => s.clean.twinOn);
  return (
    <CollapsibleGroup type="multiple" defaultValue={["crop"]} hasDividers density="spacious">
      <Collapsible value="crop" trigger={<SectionTrigger title="Cleaning" />}>
        <CropSection />
      </Collapsible>
      <Collapsible value="refine" trigger={
        <SectionTrigger title="Refine alignment"
          meta={nudged ? <Badge variant="warning" label="nudged" /> : null} />}>
        <Body><RefinePanel /></Body>
      </Collapsible>
      <Collapsible value="points" trigger={
        <SectionTrigger title={custom ? "Corners" : "Point pairs"} meta={<Badge label={nPts} />} />}>
        <PointsSection />
      </Collapsible>
      <Collapsible value="twin" trigger={
        <SectionTrigger title="Twin preview"
          meta={twinOn ? <Token size="sm" label={twin.source === "generated" ? `${twin.thickness.toFixed(2)} m walls` : "real IFC"} /> : null} />}>
        <Body><TwinPanel /></Body>
      </Collapsible>
    </CollapsibleGroup>
  );
}

function ExportResult() {
  const r = useStore((s) => s.clean.exportResult);
  const err = useStore((s) => s.clean.exportError);
  if (err) return <Banner status="error" title="Export failed" description={err} />;
  if (!r) return null;
  return (
    <Banner id="export-out" status="success" collapsible={false} container="card"
      title={`Kept ${r.kept.toLocaleString()} / ${r.total.toLocaleString()} splats (${r.pct.toFixed(1)}%)`}>
      <VStack gap={2}>
        <MetadataList>
          <MetadataListItem label="PLY"><Num>{fmtMB(r.plyBytes)} · {r.seconds}s</Num></MetadataListItem>
          {r.sog ? (
            <MetadataListItem label="SOG">
              {r.sog.ok ? <Num>{fmtMB(r.sog.bytes)} · {r.sog.seconds}s</Num>
                : <Text color="secondary">failed: {r.sog.error}</Text>}
            </MetadataListItem>
          ) : null}
          <MetadataListItem label="IFC">
            {r.ifc.ok ? <Text color="secondary">written</Text> : <Text color="secondary">failed: {r.ifc.error}</Text>}
          </MetadataListItem>
        </MetadataList>
        <Text type="supporting" wordBreak="break-all">{r.dir}</Text>
      </VStack>
    </Banner>
  );
}

function ExportFooter() {
  const exporting = useStore((s) => s.clean.exporting);
  const ready = useStore((s) => s.clean.ready);
  const wantSog = useStore((s) => s.clean.wantSog);
  const note = useStore((s) => s.clean.saveNote);
  return (
    <VStack gap={3}>
      <ExportResult />
      <HStack gap={2} vAlign="center">
        <StackItem size="fill"><Switch size="sm" label="Also write SOG" value={wantSog} onChange={actions.setWantSog} /></StackItem>
        {note && !note.onVault ? (
          <HStack gap={1} vAlign="center"><StatusDot variant="warning" label="Saving locally" /><Text type="supporting">saving locally</Text></HStack>
        ) : null}
      </HStack>
      <Button id="export" label="Export cleaned splat" variant="primary" size="lg" width="100%"
        icon={<Icon icon={Download} />} isLoading={exporting} isDisabled={!ready} onClick={actions.export} />
      {note ? <Text type="supporting" maxLines={1}>PLY + SOG + IFC → {note.dir}</Text> : null}
    </VStack>
  );
}

export function CleanStage() {
  return (
    <Layout
      height="fill"
      content={<LayoutContent padding={0}><CleanViewport /></LayoutContent>}
      end={
        <LayoutPanel hasDivider padding={0} width={380} label="Inspector">
          <Section variant="section" padding={0} height="100%">
          <Layout
            height="fill"
            defaultHasDividers
            header={<LayoutHeader padding={4}><RoomHeader /></LayoutHeader>}
            content={<LayoutContent padding={0} isScrollable><Inspector /></LayoutContent>}
            footer={<LayoutFooter padding={4}><ExportFooter /></LayoutFooter>}
          />
          </Section>
        </LayoutPanel>
      }
    />
  );
}
