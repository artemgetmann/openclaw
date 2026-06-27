import { Type } from "@sinclair/typebox";
import { AgentDesktopRuntime } from "../../gui-control/agent-desktop-runtime.js";
import { runGuiControl, type GuiControlAction } from "../../gui-control/control.js";
import type { ElementIntent } from "../../gui-control/element-resolution.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const GUI_CONTROL_ACTIONS = [
  "observe",
  "resolve_element",
  "set_value",
  "click",
  "press",
  "scroll",
] as const;
const GUI_ELEMENT_INTENTS = ["text-input", "button", "any"] as const;

const GuiControlToolSchema = Type.Object({
  action: stringEnum(GUI_CONTROL_ACTIONS),
  appName: Type.String({
    description: "macOS app name to observe or control, e.g. Safari or Claude.",
  }),
  windowTitle: Type.Optional(
    Type.String({
      description: "Optional window title substring. If supplied, wrong-window observations fail.",
    }),
  ),
  ref: Type.Optional(
    Type.String({
      description:
        "Element ref from the latest gui_control observe/resolve_element result. Prefer resolving from a fresh snapshot.",
    }),
  ),
  intent: optionalStringEnum(GUI_ELEMENT_INTENTS),
  labelIncludes: Type.Optional(
    Type.String({
      description: "Optional label substring used to resolve a unique target element.",
    }),
  ),
  valueIncludes: Type.Optional(
    Type.String({
      description: "Optional current-value substring used to resolve a unique target element.",
    }),
  ),
  value: Type.Optional(Type.String({ description: "Text for action=set_value." })),
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description: "Key combo list for action=press, e.g. ['cmd+return'].",
    }),
  ),
  scrollDirection: optionalStringEnum(["up", "down", "left", "right"] as const, {
    description: "Direction for action=scroll.",
  }),
  scrollAmount: Type.Optional(Type.Number({ description: "Scroll amount for action=scroll." })),
  reason: Type.Optional(
    Type.String({
      description: "Short model-authored reason for the audit record.",
    }),
  ),
  approvedPolicyRisk: Type.Optional(
    Type.Boolean({
      description:
        "Set true when the user requested or approved this specific mutating GUI action.",
    }),
  ),
  verifyText: Type.Optional(
    Type.String({
      description: "Text that must be visible after a click for task-specific verification.",
    }),
  ),
  allowObservedClick: Type.Optional(
    Type.Boolean({
      description: "Accept target re-observation as click verification when no text proof exists.",
    }),
  ),
  maxElements: Type.Optional(Type.Number({ description: "Max elements to include in output." })),
});

function readIntent(params: Record<string, unknown>): ElementIntent {
  const raw = readStringParam(params, "intent") ?? "any";
  if (raw === "text-input" || raw === "button" || raw === "any") {
    return raw;
  }
  return "any";
}

function normalizeAction(action: string): GuiControlAction {
  if (action === "resolve_element") {
    return "resolve-element";
  }
  if (action === "set_value") {
    return "set-value";
  }
  if (action === "observe" || action === "click" || action === "press" || action === "scroll") {
    return action;
  }
  throw new Error(`Unsupported gui_control action: ${action}`);
}

export function createGuiControlTool(): AnyAgentTool {
  return {
    label: "GUI Control",
    name: "gui_control",
    description:
      "Experimental macOS GUI-control tool for Codex loopback testing. Observe apps, resolve real UI elements from fresh snapshots, and perform guarded actions that fail closed on wrong targets, ambiguous elements, stale refs, or blocked mutation risks.",
    parameters: GuiControlToolSchema,
    ownerOnly: true,
    async execute(_toolCallId, params) {
      const action = readStringParam(params, "action", { required: true });
      const appName = readStringParam(params, "appName", { required: true });
      const windowTitle = readStringParam(params, "windowTitle");
      const maxElementsRaw = params.maxElements;
      const maxElements =
        typeof maxElementsRaw === "number" && Number.isFinite(maxElementsRaw)
          ? Math.trunc(maxElementsRaw)
          : 60;
      const runtime = new AgentDesktopRuntime();

      return jsonResult(
        await runGuiControl({
          runtime,
          action: normalizeAction(action),
          appName,
          windowTitle,
          ref: readStringParam(params, "ref"),
          intent: readIntent(params),
          labelIncludes: readStringParam(params, "labelIncludes"),
          valueIncludes: readStringParam(params, "valueIncludes"),
          value:
            action === "set_value"
              ? readStringParam(params, "value", {
                  required: true,
                  allowEmpty: true,
                  trim: false,
                })
              : readStringParam(params, "value", { trim: false }),
          keys: Array.isArray(params.keys)
            ? (params.keys as unknown[]).filter((key): key is string => typeof key === "string")
            : undefined,
          scrollDirection:
            params.scrollDirection === "up" ||
            params.scrollDirection === "down" ||
            params.scrollDirection === "left" ||
            params.scrollDirection === "right"
              ? params.scrollDirection
              : undefined,
          scrollAmount:
            typeof params.scrollAmount === "number" && Number.isFinite(params.scrollAmount)
              ? Math.trunc(params.scrollAmount)
              : undefined,
          reason: readStringParam(params, "reason"),
          approvedPolicyRisk: params.approvedPolicyRisk === true,
          verifyText: readStringParam(params, "verifyText"),
          allowObservedClick: params.allowObservedClick === true,
          maxElements,
        }),
      );
    },
  };
}
