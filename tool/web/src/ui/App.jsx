/** App frame: AppShell with a TopNav (brand · workflow stepper · status) over the three stages. */

import { useEffect } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Stepper, Step } from "@astryxdesign/core/Stepper";
import { useToast } from "@astryxdesign/core/Toast";
import { Box } from "lucide-react";
import { useStore } from "../store.js";
import { actions } from "../engine.js";
import { SelectStage } from "./SelectStage.jsx";
import { AlignStage } from "./AlignStage.jsx";
import { CleanStage } from "./CleanStage.jsx";

const STAGES = ["select", "align", "clean"];

function WorkflowStepper() {
  const stage = useStore((s) => s.stage);
  const sel = useStore((s) => s.sel);
  const alignMode = useStore((s) => s.align.mode);
  const custom = sel.customMode && sel.roomId !== "__auto__";
  return (
    <HStack width={440} paddingBlock={1}>
      <Stepper
        label="Workflow"
        density="compact"
        indicatorPosition="on-track"
        activeStep={STAGES.indexOf(stage)}
        onStepClick={(i) => actions.goStage(STAGES[i])}
        horizontalOptions={{ minimumStepWidth: 96, collapsedVariant: "withLabel" }}
      >
        <Step step={0} label="Select" />
        <Step step={1} label={custom || alignMode === "draw" ? "Draw" : "Align"} isDisabled={sel.roomId === "__auto__"} />
        <Step step={2} label="Clean" />
      </Stepper>
    </HStack>
  );
}

function StatusLine() {
  const { text, busy, tone } = useStore((s) => s.status);
  return (
    <HStack gap={2} vAlign="center">
      {busy
        ? <Spinner size="sm" />
        : <StatusDot variant={tone === "warn" ? "warning" : tone === "ok" ? "success" : "neutral"} label={text} />}
      <Text color="secondary" maxLines={1}>{text}</Text>
    </HStack>
  );
}

/** Engine toasts → Astryx toasts. */
function ToastBridge() {
  const t = useStore((s) => s.toast);
  const showToast = useToast();
  useEffect(() => {
    if (!t) return;
    showToast({ body: t.msg, type: t.err ? "error" : "info", isAutoHide: true, autoHideDuration: t.err ? 7000 : 3500 });
  }, [t, showToast]);
  return null;
}

export function App() {
  const stage = useStore((s) => s.stage);
  return (
    <AppShell
      variant="surface"
      contentPadding={0}
      mobileNav={false}
      topNav={
        <TopNav
          label="Workflow"
          heading={<TopNavHeading logo={<Icon icon={Box} />} logoLabel="Splat IFC" heading="Splat ↔ IFC" />}
          centerContent={<WorkflowStepper />}
          endContent={<StatusLine />}
        />
      }
    >
      <ToastBridge />
      <div className="stage" hidden={stage !== "select"}><SelectStage /></div>
      <div className="stage" hidden={stage !== "align"}><AlignStage /></div>
      <div className="stage" hidden={stage !== "clean"}><CleanStage /></div>
    </AppShell>
  );
}
