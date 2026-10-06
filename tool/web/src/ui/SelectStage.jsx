/**
 * Stage 1: pick a scan and how to get its room.
 *
 * Frame: Astryx's `settings` template -- page heading in the header, one scrolling column of
 * two-column sections (heading + support on the left, the controls on the right) fenced by a
 * divider, and the single primary action pinned in the footer. Previous exports are not part of
 * that path (you only need them to redo a clean), so they live behind "Reopen an export" in the
 * page header, in a Dialog.
 */

import { useMemo, useState } from "react";
import {
  Layout, LayoutContent, LayoutHeader, LayoutFooter, HStack, VStack, StackItem,
} from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { Button } from "@astryxdesign/core/Button";
import { Selector, SelectorOption } from "@astryxdesign/core/Selector";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Token } from "@astryxdesign/core/Token";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Banner } from "@astryxdesign/core/Banner";
import { ScanLine, DoorOpen, PenTool, ArrowRight, History, Sparkles } from "lucide-react";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { useStore } from "../store.js";
import { actions } from "../engine.js";
import { fmtMB } from "./controls.jsx";

/** Where the room comes from: "ifc" (pick one), "auto" (detect), or "custom" (draw). */
function roomSource(roomId, fallback) {
  if (roomId === "__auto__") return "auto";
  if (roomId === "__custom__") return "custom";
  if (roomId) return "ifc";
  return fallback;
}

// ---------------------------------------------------------------- steps

function ScanStep() {
  const datasets = useStore((s) => s.datasets);
  const splatId = useStore((s) => s.sel.splatId);
  const splats = datasets?.splats ?? [];
  const options = useMemo(() => splats.map((s) => ({
    value: s.id, label: s.project,
    description: `${s.scan} · ${fmtMB(s.sog_bytes)} SOG · ${s.has_ply ? `${fmtMB(s.ply_bytes)} PLY` : "SOG only"}`,
  })), [splats]);
  const chosen = splats.find((s) => s.id === splatId);
  return (
    <VStack gap={3} className="reveal">
      <Selector
        label="Scan"
        placeholder="Choose a scan"
        startIcon={ScanLine}
        options={options}
        value={splatId ?? undefined}
        onChange={(v) => actions.selectSplat(v)}
        hasSearch
        searchPlaceholder="Search scans…"
        isLoading={!datasets}
        isDisabled={!!datasets && splats.length === 0}
        disabledMessage="The splat vault is empty or not mounted"
        renderOption={(o) => <SelectorOption label={o.label} description={o.description} />}
      />
      {chosen ? (
        <MetadataList label={{ position: "start", width: 120 }}>
          <MetadataListItem label="Folder"><Text hasTabularNumbers>{chosen.scan}</Text></MetadataListItem>
          <MetadataListItem label="Preview"><Text hasTabularNumbers>SOG · {fmtMB(chosen.sog_bytes)}</Text></MetadataListItem>
          <MetadataListItem label="Export from">
            <Text hasTabularNumbers>{chosen.has_ply ? `PLY · ${fmtMB(chosen.ply_bytes)}` : "SOG (decoded on export)"}</Text>
          </MetadataListItem>
        </MetadataList>
      ) : null}
    </VStack>
  );
}

function RoomStep({ picked, setPicked }) {
  const datasets = useStore((s) => s.datasets);
  const roomId = useStore((s) => s.sel.roomId);
  const source = roomSource(roomId, picked);
  const rooms = datasets?.rooms ?? [];
  const options = useMemo(() => rooms.map((r) => ({
    value: r.id, label: `${r.id} · ${r.name}`, disabled: !!r.error,
    description: r.error ? "Unreadable IFC" : `${r.area_m2} m² · ${r.points} pts · h ${r.height_m} m`,
  })), [rooms]);
  const choose = (v) => {
    setPicked(v);
    actions.selectRoom(v === "auto" ? "__auto__" : v === "custom" ? "__custom__" : null);
  };
  return (
    <VStack gap={4} className="reveal">
      <RadioList label="Room source" isLabelHidden value={source} onChange={choose}>
        <RadioListItem value="ifc" label="IFC room"
          description="Click matching points in the scan and the model, then solve. Exact footprint and walls." />
        <RadioListItem value="auto" label="Auto room" endContent={<Token size="sm" label="no IFC" />}
          description="Detect walls, floor and ceiling from the splat itself. Goes straight to Clean." />
        <RadioListItem value="custom" label="Draw a box" endContent={<Token size="sm" label="no IFC" />}
          description="Click the room's floor corners on the splat and set a height." />
      </RadioList>
      {source === "ifc" ? (
        <VStack className="reveal">
          <Selector
            label="IFC room"
            placeholder="Choose a room"
            startIcon={DoorOpen}
            options={options}
            value={roomId ?? undefined}
            onChange={(v) => actions.selectRoom(v)}
            hasSearch
            searchPlaceholder="Search rooms…"
            isLoading={!datasets}
            renderOption={(o) => <SelectorOption label={o.label} description={o.description} />}
          />
        </VStack>
      ) : null}
    </VStack>
  );
}

/** One settings-style section: lead + support on the left, controls on the right. */
function Section({ title, hint, children }) {
  return (
    <Grid columns={{ minWidth: 300 }} gap={10}>
      <VStack gap={1}>
        <Heading level={3}>{title}</Heading>
        <Text type="supporting">{hint}</Text>
      </VStack>
      <VStack gap={4}>{children}</VStack>
    </Grid>
  );
}

function SelectFooter() {
  const datasets = useStore((s) => s.datasets);
  const sel = useStore((s) => s.sel);
  const entering = useStore((s) => s.entering);
  const splat = datasets?.splats.find((x) => x.id === sel.splatId);
  const room = datasets?.rooms.find((x) => x.id === sel.roomId);
  const mode = roomSource(sel.roomId, null);
  const ready = !!(sel.splatId && sel.roomId);
  const what = mode === "auto" ? { label: "Detect room", icon: Sparkles, name: "Auto room" }
    : mode === "custom" ? { label: "Draw the box", icon: PenTool, name: "Custom box" }
    : { label: "Align", icon: DoorOpen, name: room ? `${room.id} · ${room.name}` : null };
  return (
    <HStack gap={4} vAlign="center">
      <StackItem size="fill">
        {ready ? (
          <HStack gap={2} vAlign="center" wrap="wrap" className="reveal">
            <Token label={splat?.project ?? "—"} icon={<Icon icon={ScanLine} />} />
            <Icon icon={ArrowRight} size="sm" color="secondary" />
            <Token label={what.name} icon={<Icon icon={what.icon} />} />
          </HStack>
        ) : (
          <Text color="secondary">{!splat ? "Choose a scan to begin." : "Now choose where the room comes from."}</Text>
        )}
      </StackItem>
      {datasets && !datasets.splat_root_exists ? (
        <HStack gap={2} vAlign="center"><StatusDot variant="warning" label="Vault not mounted" />
          <Text color="secondary">Vault not mounted</Text></HStack>
      ) : null}
      <Button id="go-align" label={what.label} variant="primary" isDisabled={!ready} isLoading={entering}
        endContent={<Icon icon={ArrowRight} />} onClick={actions.next} />
    </HStack>
  );
}

// ---------------------------------------------------------------- reopen dialog

function ReopenDialog({ isOpen, onOpenChange }) {
  const exports = useStore((s) => s.exports);
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={560}>
      <Layout
        height="fill"
        header={<DialogHeader title="Reopen an export" onOpenChange={onOpenChange}
          subtitle="Back into Clean with the alignment, crop and nudge restored. Re-exporting overwrites in place." />}
        content={
          <LayoutContent padding={0} isScrollable>
            {exports.length === 0 ? (
              <EmptyState icon={<Icon icon={History} />} title="Nothing exported yet"
                description="Cleaned scans show up here so you can reopen them." />
            ) : (
              <List hasDividers>
                {exports.map((e) => {
                  const ok = e.reload?.reloadable && e.splat_available;
                  const when = e.created ? new Date(e.created).toLocaleString(undefined,
                    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
                  const pct = e.kept_fraction != null ? `${(e.kept_fraction * 100).toFixed(0)}% kept` : null;
                  return (
                    <ListItem
                      key={`${e.splat_id}/${e.label}/${e.created}`}
                      label={e.room_name}
                      description={`${e.splat_id}${when ? ` · ${when}` : ""}`}
                      onClick={() => { onOpenChange(false); actions.reopen(e); }}
                      startContent={<Icon icon={e.custom_mode ? PenTool : DoorOpen} color={ok ? "secondary" : "disabled"} />}
                      endContent={pct ? <Token size="sm" label={pct} color={ok ? "default" : "gray"} /> : null}
                    />
                  );
                })}
              </List>
            )}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------- page

export function SelectStage() {
  const datasets = useStore((s) => s.datasets);
  const exports = useStore((s) => s.exports);
  const [picked, setPicked] = useState("ifc");
  const [reopen, setReopen] = useState(false);

  return (
    <>
      <Layout
        height="fill"
        contentWidth={960}
        defaultHasDividers
        header={
          <LayoutHeader padding={6}>
            <HStack gap={4} vAlign="center">
              <StackItem size="fill">
                <VStack gap={1}>
                  <Heading level={1}>New clean</Heading>
                  <Text color="secondary">Align a scan to its room, crop it to the walls, export.</Text>
                </VStack>
              </StackItem>
              <Button label="Reopen an export" variant="ghost" icon={<Icon icon={History} />}
                isDisabled={exports.length === 0} tooltip={exports.length === 0 ? "Nothing exported yet" : undefined}
                onClick={() => setReopen(true)} />
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={6} isScrollable>
            <VStack gap={8}>
              {datasets && !datasets.splat_root_exists ? (
                <Banner status="warning" title="Splat vault not mounted" collapsible={false}
                  description="Reconnecting in the background; scans will appear once it is back." />
              ) : null}
              <Section title="Scan" hint="The Gaussian-splat scan to clean. Previewed from its SOG; the export is cut from the full-precision PLY.">
                <ScanStep />
              </Section>
              <Divider />
              <Section title="Room" hint="Align to an IFC room's real footprint, or build the box without one.">
                <RoomStep picked={picked} setPicked={setPicked} />
              </Section>
            </VStack>
          </LayoutContent>
        }
        footer={<LayoutFooter padding={4}><SelectFooter /></LayoutFooter>}
      />
      <ReopenDialog isOpen={reopen} onOpenChange={setReopen} />
    </>
  );
}
