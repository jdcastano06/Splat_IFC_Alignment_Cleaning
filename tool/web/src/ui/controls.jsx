/** Small building blocks shared by every stage. */

import { HStack, VStack, StackItem, Card } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Slider } from "@astryxdesign/core/Slider";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { Rotate3d, Footprints, Maximize } from "lucide-react";
import { useStore } from "../store.js";
import { actions } from "../engine.js";

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * A slider with an unbounded number box. The slider is a comfortable range; the box is the
 * authority and takes any value (type -12.5 for an offset past the slider's end).
 */
export function SliderField({
  label, value, onChange, min, max, step = 0.01, dp = 2, unit, hardMin, isDisabled, description,
}) {
  const commit = (v) => {
    if (!Number.isFinite(v)) return;
    if (hardMin !== undefined) v = Math.max(v, hardMin);
    onChange(v);
  };
  const outOfRange = value < min || value > max;
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Text type="label" color={isDisabled ? "disabled" : outOfRange ? "accent" : "secondary"}>{label}</Text>
        </StackItem>
        <NumberInput
          label={label}
          isLabelHidden
          size="sm"
          width={96}
          value={Number(value)}
          step={step}
          units={unit ?? null}
          min={hardMin ?? null}
          isDisabled={isDisabled}
          isWheelEnabled={false}
          formatValue={(v) => v.toFixed(dp)}
          onChange={(v) => commit(Number(v))}
        />
      </HStack>
      <Slider
        label={label}
        isLabelHidden
        valueDisplay="none"
        min={min}
        max={max}
        step={step}
        isDisabled={isDisabled}
        value={clamp(Number(value), min, max)}
        onChange={(v) => commit(v)}
      />
      {description ? <Text type="supporting">{description}</Text> : null}
    </VStack>
  );
}

/** Letter + colour, the same identity the point carries in 3D. */
export function Chip({ label, color, ghost = false }) {
  return <span className="chip" data-ghost={ghost} style={{ "--chip": color }}>{label}</span>;
}

export function Dot({ color }) {
  return <span className="dot" style={{ "--dot": color }} />;
}

/** Tabular numbers in the code face, for coordinates and residuals. */
export function Num({ children, color }) {
  return <Text type="code" size="sm" color={color} hasTabularNumbers>{children}</Text>;
}

/**
 * A surface floated over a viewport: the canvas-editor template's recipe, a one-step padded
 * Card raised to `high` (it sits over the whole canvas) holding a Toolbar.
 */
export function Float({ label, children }) {
  return (
    <Card padding={1} elevation="high">
      <Toolbar label={label} size="sm" gap={1} startContent={children} />
    </Card>
  );
}

/** Orbit/Fly + fit-view for one viewport. */
export function NavControls({ which }) {
  const mode = useStore((s) => s.nav[which]);
  return (
    <Float label="Navigation">
      <SegmentedControl label="Navigation mode" size="sm" value={mode} onChange={(m) => actions.setNav(which, m)}>
        <SegmentedControlItem value="orbit" label="Orbit" icon={<Icon icon={Rotate3d} size="sm" />} />
        <SegmentedControlItem value="fly" label="Fly" icon={<Icon icon={Footprints} size="sm" />} />
      </SegmentedControl>
      <IconButton label="Fit view" tooltip="Fit view" variant="ghost" size="sm"
        icon={<Icon icon={Maximize} size="sm" />} onClick={() => actions.fitView(which)} />
    </Float>
  );
}

/** WASD/QE/F reminder, shown small in a viewport corner. */
export function KeyHints({ extra }) {
  return (
    <Float label="Keyboard hints">
      <HStack gap={3} vAlign="center" paddingInline={1}>
        <HStack gap={1} vAlign="center"><Kbd keys="W" /><Kbd keys="A" /><Kbd keys="S" /><Kbd keys="D" /><Text type="supporting">fly</Text></HStack>
        <HStack gap={1} vAlign="center"><Kbd keys="Q" /><Kbd keys="E" /><Text type="supporting">down / up</Text></HStack>
        <HStack gap={1} vAlign="center"><Kbd keys="shift" /><Text type="supporting">faster</Text></HStack>
        <HStack gap={1} vAlign="center"><Kbd keys="F" /><Text type="supporting">orbit / fly</Text></HStack>
        {extra ? <Text type="supporting">{extra}</Text> : null}
      </HStack>
    </Float>
  );
}

/**
 * A viewport: the persistent canvas host the engine draws into (React never touches its
 * children) plus whatever overlays the stage floats on top.
 */
export function Viewport({ which, children }) {
  return (
    <div className="vp">
      <div id={`host-${which}`} className="vp-host" />
      {children}
    </div>
  );
}

export const fmtMB = (b) => `${(b / 1e6).toFixed(0)} MB`;
export const fmtM = (v, dp = 3) => `${v.toFixed(dp)} m`;
