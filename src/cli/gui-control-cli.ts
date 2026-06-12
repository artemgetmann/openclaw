import type { Command } from "commander";
import { AgentDesktopRuntime } from "../gui-control/agent-desktop-runtime.js";
import {
  GUI_ELEMENT_INTENTS,
  runGuiControl,
  type GuiControlAction,
} from "../gui-control/control.js";
import type { ElementIntent } from "../gui-control/element-resolution.js";
import { OpenComputerUseRuntime } from "../gui-control/open-computer-use-runtime.js";
import { getGuiTaskPolicyProfile, type GuiTaskPolicyProfile } from "../gui-control/policy.js";
import type { GuiRuntimeName } from "../gui-control/types.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";

type GuiControlCliOptions = {
  runtime?: string;
  runtimeCommand?: string;
  taskPolicy?: string;
  app?: string;
  windowTitle?: string;
  ref?: string;
  intent?: string;
  labelIncludes?: string;
  valueIncludes?: string;
  value?: string;
  keys?: string;
  direction?: string;
  amount?: string | number;
  reason?: string;
  approvePolicyRisk?: boolean;
  verifyText?: string;
  allowObservedClick?: boolean;
  maxElements?: string | number;
  json?: boolean;
};

function parseRuntime(value?: string): GuiRuntimeName {
  if (!value) {
    return "agent-desktop";
  }
  if (value === "agent-desktop" || value === "open-computer-use") {
    return value;
  }
  throw new Error(`Unsupported GUI runtime: ${value}`);
}

function createRuntime(runtimeName: GuiRuntimeName, opts: GuiControlCliOptions) {
  if (runtimeName === "agent-desktop") {
    return new AgentDesktopRuntime();
  }
  if (runtimeName === "open-computer-use") {
    return new OpenComputerUseRuntime({
      command: opts.runtimeCommand ?? process.env.OPENCLAW_OPEN_COMPUTER_USE_BIN,
    });
  }
  throw new Error("Unsupported GUI runtime.");
}

function readTaskPolicy(opts: GuiControlCliOptions) {
  if (!opts.taskPolicy) {
    return undefined;
  }
  if (
    opts.taskPolicy === "read_only_web_context" ||
    opts.taskPolicy === "send_message_to_approved_assistant" ||
    opts.taskPolicy === "local_fixture_write"
  ) {
    return getGuiTaskPolicyProfile(opts.taskPolicy as GuiTaskPolicyProfile);
  }
  throw new Error(`Unsupported GUI task policy profile: ${opts.taskPolicy}`);
}

function readApp(opts: GuiControlCliOptions): string {
  if (typeof opts.app === "string" && opts.app.trim()) {
    return opts.app.trim();
  }
  throw new Error("gui-control requires --app <name>.");
}

function readIntent(opts: GuiControlCliOptions): ElementIntent | undefined {
  if (!opts.intent) {
    return undefined;
  }
  if (GUI_ELEMENT_INTENTS.includes(opts.intent as ElementIntent)) {
    return opts.intent as ElementIntent;
  }
  throw new Error(`Unsupported element intent: ${opts.intent}`);
}

function readMaxElements(opts: GuiControlCliOptions): number | undefined {
  if (opts.maxElements === undefined) {
    return undefined;
  }
  const parsed = Number(opts.maxElements);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --max-elements value: ${opts.maxElements}`);
  }
  return parsed;
}

function readKeys(opts: GuiControlCliOptions): string[] | undefined {
  if (!opts.keys) {
    return undefined;
  }
  return opts.keys
    .split(/\s*,\s*/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function readScrollDirection(
  opts: GuiControlCliOptions,
): "up" | "down" | "left" | "right" | undefined {
  if (!opts.direction) {
    return undefined;
  }
  if (
    opts.direction === "up" ||
    opts.direction === "down" ||
    opts.direction === "left" ||
    opts.direction === "right"
  ) {
    return opts.direction;
  }
  throw new Error(`Unsupported scroll direction: ${opts.direction}`);
}

function readScrollAmount(opts: GuiControlCliOptions): number | undefined {
  if (opts.amount === undefined) {
    return undefined;
  }
  const parsed = Number(opts.amount);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid --amount value: ${opts.amount}`);
  }
  return Math.trunc(parsed);
}

function humanSummary(result: Awaited<ReturnType<typeof runGuiControl>>): string {
  const lines = [
    `ok: ${result.ok ? "yes" : "no"}`,
    `action: ${result.action}`,
    `target: ${result.target.appName}${result.target.windowTitle ? ` / ${result.target.windowTitle}` : ""}`,
  ];
  if (result.snapshot) {
    lines.push(`snapshot: ${result.snapshot.id}`);
    lines.push(`elements: ${result.snapshot.elementCount}`);
    if (result.snapshot.summary) {
      lines.push(`summary: ${result.snapshot.summary}`);
    }
  }
  if (result.summary) {
    lines.push(`result: ${result.summary}`);
  }
  if (result.failureReason) {
    lines.push(`failure: ${result.failureReason}`);
  }
  if (result.element) {
    lines.push(
      `element: ${result.element.ref}${result.element.role ? ` role=${result.element.role}` : ""}${
        result.element.label ? ` label=${result.element.label}` : ""
      }${result.element.description ? ` description=${result.element.description}` : ""}${
        result.element.bounds
          ? ` bounds=${result.element.bounds.x},${result.element.bounds.y},${result.element.bounds.width},${result.element.bounds.height}`
          : ""
      }`,
    );
  }
  if (result.candidates?.length) {
    lines.push("candidates:");
    for (const candidate of result.candidates) {
      lines.push(
        `- ${candidate.ref}${candidate.role ? ` role=${candidate.role}` : ""}${
          candidate.label ? ` label=${candidate.label}` : ""
        }${candidate.descriptionPreview ? ` description=${candidate.descriptionPreview}` : ""}${
          candidate.bounds
            ? ` bounds=${candidate.bounds.x},${candidate.bounds.y},${candidate.bounds.width},${candidate.bounds.height}`
            : ""
        }`,
      );
    }
  }
  if (result.verifiedAction) {
    lines.push(`audit: ${result.verifiedAction.audit.id}`);
    lines.push(`audit-result: ${result.verifiedAction.audit.result}`);
    lines.push(`actions: ${result.verifiedAction.stats.actionCount}`);
    lines.push(`stale-refs: ${result.verifiedAction.stats.staleRefs}`);
    lines.push(`false-successes: ${result.verifiedAction.stats.falseSuccesses}`);
    lines.push(`false-failures: ${result.verifiedAction.stats.falseFailures}`);
    if (result.verifiedAction.stats.postStateResult) {
      lines.push(`post-state: ${result.verifiedAction.stats.postStateResult}`);
    }
  }
  return lines.join("\n");
}

async function runAction(action: GuiControlAction, opts: GuiControlCliOptions) {
  await runCommandWithRuntime(defaultRuntime, async () => {
    const runtime = createRuntime(parseRuntime(opts.runtime), opts);
    const result = await runGuiControl({
      runtime,
      action,
      appName: readApp(opts),
      windowTitle: opts.windowTitle,
      ref: opts.ref,
      intent: readIntent(opts),
      labelIncludes: opts.labelIncludes,
      valueIncludes: opts.valueIncludes,
      value: opts.value,
      keys: readKeys(opts),
      scrollDirection: readScrollDirection(opts),
      scrollAmount: readScrollAmount(opts),
      reason: opts.reason,
      approvedPolicyRisk: opts.approvePolicyRisk === true,
      taskPolicy: readTaskPolicy(opts),
      verifyText: opts.verifyText,
      allowObservedClick: opts.allowObservedClick === true,
      maxElements: readMaxElements(opts),
    });
    defaultRuntime.log(opts.json ? JSON.stringify(result, null, 2) : humanSummary(result));
    defaultRuntime.exit(result.ok ? 0 : 1);
  });
}

function addSharedOptions(command: Command) {
  return command
    .option(
      "--runtime <runtime>",
      "Runtime adapter: agent-desktop, open-computer-use",
      "agent-desktop",
    )
    .option(
      "--runtime-command <path>",
      "Runtime command path, useful for a pinned OpenComputerUse build",
    )
    .requiredOption("--app <name>", "macOS app name, e.g. Safari or Claude")
    .option("--window-title <title>", "Optional window title substring")
    .option("--max-elements <count>", "Maximum elements to include in output", "60")
    .option("--json", "Print structured JSON", false);
}

function addElementOptions(command: Command) {
  return command
    .option("--ref <ref>", "Element ref from a fresh snapshot")
    .option("--intent <intent>", "Element intent: text-input, button, any")
    .option("--label-includes <text>", "Resolve a unique element by label substring")
    .option("--value-includes <text>", "Resolve a unique element by current value substring");
}

function addMutationOptions(command: Command) {
  return command
    .option("--reason <reason>", "Audit reason for the action")
    .option(
      "--task-policy <profile>",
      "Task policy profile: read_only_web_context, send_message_to_approved_assistant, local_fixture_write",
    )
    .option("--approve-policy-risk", "Approve this specific mutating GUI action", false);
}

export function registerGuiControlCli(program: Command) {
  const gui = program
    .command("gui-control")
    .description("Experimental CLI-first macOS GUI control for Codex/Jarvis development");

  addSharedOptions(
    gui.command("observe").description("Observe an app/window and list elements"),
  ).action((opts) => runAction("observe", opts));

  addElementOptions(
    addSharedOptions(gui.command("resolve-element").description("Resolve one real UI element")),
  ).action((opts) => runAction("resolve-element", opts));

  addMutationOptions(
    addElementOptions(
      addSharedOptions(gui.command("set-value").description("Set an element value")),
    ),
  )
    .requiredOption("--value <text>", "Value to set")
    .action((opts) => runAction("set-value", opts));

  addMutationOptions(
    addElementOptions(addSharedOptions(gui.command("click").description("Click an element"))),
  )
    .option("--verify-text <text>", "Text that must be visible after the click")
    .option(
      "--allow-observed-click",
      "Accept target re-observation as the click verification when no text proof exists",
      false,
    )
    .action((opts) => runAction("click", opts));

  addMutationOptions(
    addSharedOptions(gui.command("press").description("Press an app-scoped key combo")),
  )
    .requiredOption("--keys <combo>", "Key combo, e.g. cmd+return or escape")
    .option("--verify-text <text>", "Text that must be visible after the press")
    .option(
      "--allow-observed-click",
      "Accept changed target state as verification when no text proof exists",
      false,
    )
    .action((opts) => runAction("press", opts));

  addMutationOptions(
    addElementOptions(addSharedOptions(gui.command("scroll").description("Scroll an element"))),
  )
    .option("--direction <direction>", "Scroll direction: up, down, left, right", "down")
    .option("--amount <count>", "Scroll amount", "3")
    .option("--verify-text <text>", "Text that must be visible after the scroll")
    .option(
      "--allow-observed-click",
      "Accept changed target state as verification when no text proof exists",
      false,
    )
    .action((opts) => runAction("scroll", opts));
}
