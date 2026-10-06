/**
 * Stage 2. IFC room: two viewports (splat | room) and a point-pairs inspector. Custom box: the
 * splat viewport alone and a draw-a-box inspector. Inspector budget: 360.
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
import { Banner } from "@astryxdesign/core/Banner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import {
  X, Crosshair, ArrowRight, Sigma, Grip, Trash2, PenTool, Lock, MousePointerClick,
} from "lucide-react";
import { useStore } from "../store.js";
import { actions } from "../engine.js";
import { Viewport, NavControls, KeyHints, Chip, Dot, Num, Float, SliderField, fmtM } from "./controls.jsx";

// Pane identity in Astryx's own hues: orange = splat, teal = room.
const SPLAT = "var(--color-icon-orange)";
const ROOM = "var(--color-icon-teal)";

function PaneLabel({ color, title, meta }) {
  return (
    <Float label={title}>
      <HStack gap={2} vAlign="center" paddingInline={2}>
        <Dot color={color} />
        <Text weight="semibold">{title}</Text>
        {meta ? <Text type="supporting" hasTabularNumbers>{meta}</Text> : null}
      </HStack>
    </Float>
  );
}

function Loading({ text }) {
  return (
    <div className="vp-anchor vp-center">
      <Float label="Loading"><HStack gap={2} vAlign="center" paddingInline={2}><Spinner size="sm" /><Text color="secondary">{text}</Text></HStack></Float>
    </div>
  );
}

function SplatPane({ hint }) {
  const count = useStore((s) => s.align.splatCount);
  const points = useStore((s) => s.align.splatPoints);
  return (
    <Viewport which="splat">
      <div className="vp-anchor vp-tl">
        <PaneLabel color={SPLAT} title="Splat" meta={count ? `${count.toLocaleString()} splats` : null} />
        <Float label="Splat view">
          <ToggleButton size="sm" label="Points" isPressed={points} id="splat-points"
            tooltip="Overlay splat centres as points (like SuperSplat) — walls and corners get crisp"
            icon={<Icon icon={Grip} size="sm" />} onPressedChange={(on) => actions.setSplatPoints(on)}>
            Points
          </ToggleButton>
        </Float>
      </div>
      <div className="vp-anchor vp-tr"><NavControls which="splat" /></div>
      <div className="vp-anchor vp-bl"><KeyHints extra={hint} /></div>
      {count == null ? <Loading text="Loading splat…" /> : null}
    </Viewport>
  );
}

function RoomPane() {
  const label = useStore((s) => s.align.roomLabel);
  return (
    <Viewport which="room">
      <div className="vp-anchor vp-tl"><PaneLabel color={ROOM} title="IFC room" meta={label} /></div>
      <div className="vp-anchor vp-tr"><NavControls which="room" /></div>
      <div className="vp-anchor vp-bl">
        <Float label="Room hint">
          <HStack gap={2} vAlign="center" paddingInline={2}>
            <Icon icon={Crosshair} size="sm" color="secondary" />
            <Text type="supporting">Click the matching point — snaps to corners</Text>
          </HStack>
        </Float>
      </div>
    </Viewport>
  );
}

/** Inspector chrome shared by both modes: lead + support in the header, actions in the footer. */
function Inspector({ icon, title, meta, hint, children, footer }) {
  return (
    <Layout
      height="fill"
      defaultHasDividers
      header={
        <LayoutHeader padding={4}>
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <StackItem size="fill"><Heading level={3}>{title}</Heading></StackItem>
              {meta}
            </HStack>
            <Text color="secondary">{hint}</Text>
          </VStack>
        </LayoutHeader>
      }
      content={<LayoutContent padding={0} isScrollable>{children}</LayoutContent>}
      footer={<LayoutFooter padding={4}>{footer}</LayoutFooter>}
    />
  );
}

// ---------------------------------------------------------------- IFC: point pairs

/** One line per pair: what it still needs, or where it landed. */
function pairStatus(p) {
  if (p.splat && p.room) return "Placed in both panes";
  return p.splat ? "Now click the same feature in the room" : "Now click the same feature in the splat";
}

function PairsList() {
  const pairs = useStore((s) => s.align.pairs);
  const selected = useStore((s) => s.align.selected);
  if (!pairs.length) {
    return (
      <EmptyState isCompact icon={<Icon icon={MousePointerClick} />} title="No pairs yet"
        description="Click a feature in the splat, then the same feature in the room (either order)." />
    );
  }
  return (
    <List id="pairs" hasDividers density="compact">
      {pairs.map((p, i) => (
        <ListItem
          key={i}
          className={`pair${p.splat && p.room ? "" : " partial"}${i === selected ? " sel" : ""}`}
          isSelected={i === selected}
          onClick={() => actions.selectPair(i)}
          startContent={<Chip label={p.label} color={p.color} ghost={!(p.splat && p.room)} />}
          label={<Text color={p.splat && p.room ? "primary" : "secondary"}>{pairStatus(p)}</Text>}
          endContent={
            <HStack gap={2} vAlign="center">
              {p.res != null ? <Num color={p.bad ? "accent" : "secondary"}>{fmtM(p.res)}</Num> : null}
              <IconButton label="Remove pair" size="sm" variant="ghost" icon={<Icon icon={X} size="sm" />}
                onClick={(e) => { e.stopPropagation(); actions.deletePair(i); }} />
            </HStack>
          }
        />
      ))}
    </List>
  );
}

function SolveResult() {
  const sol = useStore((s) => s.align.solution);
  const err = useStore((s) => s.align.solveError);
  if (err) return <Section padding={4}><Banner status="error" title="Solve failed" description={err} /></Section>;
  if (!sol) return null;
  return (
    <Section padding={4} dividers={["top"]}>
      <VStack gap={3} id="solve-out">
        <HStack gap={2} vAlign="baseline">
          <Text type="display-3" hasTabularNumbers>{sol.rms.toFixed(3)}</Text>
          <Text color="secondary">m RMS</Text>
          <StackItem size="fill" />
          <Badge variant={sol.good ? "success" : "warning"} label={sol.good ? "Good fit" : "Check pairs"} />
        </HStack>
        <MetadataList>
          <MetadataListItem label="Worst pair"><Num>{fmtM(sol.worst)}</Num></MetadataListItem>
          <MetadataListItem label="Scale"><Num>{sol.scale.toFixed(5)}×</Num></MetadataListItem>
          <MetadataListItem label="Yaw"><Num>{sol.yawDeg.toFixed(1)}°</Num></MetadataListItem>
        </MetadataList>
      </VStack>
    </Section>
  );
}

function PairsInspector() {
  const complete = useStore((s) => s.align.complete);
  const yawOnly = useStore((s) => s.align.yawOnly);
  const solving = useStore((s) => s.align.solving);
  const solved = useStore((s) => !!s.align.solution);
  return (
    <Inspector
      icon={Crosshair}
      title="Point pairs"
      meta={<Badge variant={complete >= 3 ? "success" : "neutral"} label={`${complete} / 3`} />}
      hint={complete < 3
        ? "Click a feature in one pane, then the same feature in the other. Three pairs minimum."
        : "Ready to solve. Click a pair to nudge its points with the gizmo."}
      footer={
        <VStack gap={2}>
          <Button id="solve" label="Solve alignment" width="100%" variant={solved ? "secondary" : "primary"}
            icon={<Icon icon={Sigma} />} isDisabled={complete < 3} isLoading={solving} onClick={actions.solve} />
          <Button id="go-clean" label="Continue to Clean" width="100%" variant={solved ? "primary" : "secondary"}
            endContent={<Icon icon={ArrowRight} />} isDisabled={!solved} onClick={actions.toClean} />
        </VStack>
      }
    >
      <PairsList />
      <Section padding={4} dividers={["top"]}>
        <Switch label="Z-up / yaw only" value={yawOnly} onChange={(on) => actions.setYawOnly(on)}
          description="Scans and IFC are gravity-aligned; the fit can't tilt the room to chase a misclick." />
      </Section>
      <SolveResult />
    </Inspector>
  );
}

// ---------------------------------------------------------------- custom: draw a box

function DrawInspector() {
  const d = useStore((s) => s.draw);
  const n = d.points.length;
  return (
    <Inspector
      icon={PenTool}
      title="Draw a box"
      meta={<Badge variant={d.closed ? "success" : "neutral"} label={d.closed ? "Closed" : `${n} corners`} />}
      hint="Click the floor corners around the room's perimeter, then click corner A again (or Close box). Select a corner to drag it with the gizmo."
      footer={
        <Button id="draw-clean" label="Continue to Clean" width="100%" variant="primary"
          endContent={<Icon icon={ArrowRight} />} isDisabled={!d.canContinue} onClick={actions.finishDraw} />
      }
    >
      {n === 0 ? (
        <EmptyState isCompact icon={<Icon icon={MousePointerClick} />} title="No corners yet"
          description="Turn on Points and click the room's floor corners in order." />
      ) : (
        <List id="draw-points" hasDividers density="compact">
          {d.points.map((p, i) => (
            <ListItem
              key={i}
              className={`pair${i === d.selected ? " sel" : ""}`}
              isSelected={i === d.selected}
              onClick={() => actions.selectDrawPoint(i)}
              startContent={<Chip label={p.label} color={p.color} />}
              label={<Num color="secondary">{p.text}</Num>}
              endContent={
                <HStack gap={2} vAlign="center">
                  {p.isStart ? <Badge label="start" /> : null}
                  <IconButton label="Remove corner" size="sm" variant="ghost" icon={<Icon icon={Trash2} size="sm" />}
                    onClick={(e) => { e.stopPropagation(); actions.deleteDrawPoint(i); }} />
                </HStack>
              }
            />
          ))}
        </List>
      )}
      {!d.closed && n >= 3 ? (
        <Section padding={4} paddingBlockStart={2}>
          <Button id="draw-close" label="Close box" icon={<Icon icon={Lock} />} onClick={actions.closeDraw} />
        </Section>
      ) : null}
      <Section padding={4} dividers={["top"]}>
        <VStack gap={4}>
          <SliderField label="Height" unit="m" min={0.2} max={8} step={0.05} hardMin={0.05}
            value={d.height} onChange={actions.setDrawHeight} />
          <Switch label="Pick from ceiling" value={d.flip} onChange={actions.setDrawFlip}
            description="The corners you click are the ceiling; the box extrudes down. The model stays upright in Clean." />
          <Switch label="Occlude behind splat" value={d.occlude} onChange={actions.setDrawOcclude}
            description="Corners hide behind the splat for depth. The splat gets a bit grainier." />
          {d.msg ? (
            <Banner status={d.msg.tone === "warn" ? "warning" : d.msg.tone === "ok" ? "success" : "info"} title={d.msg.text} />
          ) : null}
        </VStack>
      </Section>
    </Inspector>
  );
}

export function AlignStage() {
  const mode = useStore((s) => s.align.mode);
  const draw = mode === "draw";
  return (
    <Layout
      height="fill"
      content={
        <LayoutContent padding={0}>
          <div className="vp-split">
            <SplatPane hint={draw ? "click floor corners" : "click a feature"} />
            <div style={{ display: draw ? "none" : "contents" }}><RoomPane /></div>
          </div>
        </LayoutContent>
      }
      end={
        <LayoutPanel hasDivider padding={0} width={360} label="Inspector">
          <Section variant="section" padding={0} height="100%">
            {draw ? <DrawInspector /> : <PairsInspector />}
          </Section>
        </LayoutPanel>
      }
    />
  );
}
