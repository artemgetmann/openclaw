import { resolveElementRef, type ElementIntent } from "./element-resolution.js";
import type { GuiTaskPolicy } from "./policy.js";
import { describeGuiTargetMismatch, guiTargetMatchesSnapshot } from "./targeting.js";
import type {
  AppTarget,
  ElementRef,
  GuiRuntime,
  GuiSnapshot,
  VerifiedActionResult,
} from "./types.js";
import { performVerifiedAction } from "./verifier.js";

export const GUI_CONTROL_ACTIONS = [
  "observe",
  "resolve-element",
  "set-value",
  "click",
  "secondary-action",
  "press",
  "scroll",
] as const;
export const GUI_ELEMENT_INTENTS = ["text-input", "button", "any"] as const;

export type GuiControlAction = (typeof GUI_CONTROL_ACTIONS)[number];

export type GuiControlInput = {
  runtime: GuiRuntime;
  action: GuiControlAction;
  appName: string;
  windowTitle?: string;
  ref?: string;
  intent?: ElementIntent;
  labelIncludes?: string;
  valueIncludes?: string;
  value?: string;
  keys?: string[];
  secondaryAction?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  reason?: string;
  approvedPolicyRisk?: boolean;
  taskPolicy?: GuiTaskPolicy;
  verifyText?: string;
  allowObservedClick?: boolean;
  maxElements?: number;
};

export type GuiElementSummary = {
  ref: string;
  role?: string;
  label?: string;
  descriptionPreview?: string;
  valuePreview?: string;
  bounds?: ElementRef["bounds"];
};

export type GuiSnapshotSummary = {
  id: string;
  appName: string;
  windowTitle?: string;
  summary?: string;
  visibleText?: string[];
  elements: GuiElementSummary[];
  elementCount: number;
};

export type GuiControlResult = {
  ok: boolean;
  action: GuiControlAction;
  target: AppTarget;
  snapshot?: GuiSnapshotSummary;
  summary?: string;
  element?: ElementRef;
  candidates?: GuiElementSummary[];
  verifiedAction?: VerifiedActionResult;
  blocked?: boolean;
  failureReason?: string;
};

function boundedElementLimit(maxElements?: number): number {
  if (typeof maxElements !== "number" || !Number.isFinite(maxElements)) {
    return 60;
  }
  return Math.max(1, Math.min(500, Math.trunc(maxElements)));
}

export function summarizeElements(
  elements: Array<{
    ref: string;
    role?: string;
    label?: string;
    description?: string;
    value?: string;
    bounds?: ElementRef["bounds"];
  }>,
  maxElements?: number,
): GuiElementSummary[] {
  const limit = boundedElementLimit(maxElements);
  return elements.slice(0, limit).map((element) => ({
    ref: element.ref,
    role: element.role,
    label: element.label,
    descriptionPreview: element.description?.slice(0, 160),
    valuePreview: element.value?.slice(0, 160),
    bounds: element.bounds,
  }));
}

function summarizeSnapshot(snapshot: GuiSnapshot, maxElements?: number): GuiSnapshotSummary {
  return {
    id: snapshot.id,
    appName: snapshot.appName,
    windowTitle: snapshot.windowTitle,
    summary: snapshot.summary,
    visibleText: snapshot.visibleText?.slice(0, boundedElementLimit(maxElements)),
    elements: summarizeElements(snapshot.elements, maxElements),
    elementCount: snapshot.elements.length,
  };
}

function visibleTextContains(snapshot: GuiSnapshot, expected: string): boolean {
  if (!expected) {
    return true;
  }
  if (snapshot.summary?.includes(expected)) {
    return true;
  }
  if (snapshot.visibleText?.some((text) => text.includes(expected))) {
    return true;
  }
  return snapshot.elements.some(
    (element) =>
      element.value?.includes(expected) ||
      element.label?.includes(expected) ||
      element.description?.includes(expected) ||
      element.name?.includes(expected) ||
      element.title?.includes(expected),
  );
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function elementValueMatches(
  snapshot: GuiSnapshot,
  original: ElementRef,
  expected: string,
): boolean {
  const candidate =
    snapshot.elements.find((element) => element.ref === original.ref) ??
    snapshot.elements.find(
      (element) =>
        normalizedText(element.label) === normalizedText(original.label) &&
        normalizedText(element.description) === normalizedText(original.description),
    );
  const value = normalizedText(candidate?.value);
  const expectedValue = normalizedText(expected);
  if (!expectedValue) {
    return !value || /^write (a message|your prompt)/.test(value);
  }
  return value.includes(expectedValue) || visibleTextContains(snapshot, expected);
}

function snapshotChanged(pre: GuiSnapshot, post: GuiSnapshot): boolean {
  return (
    pre.summary !== post.summary ||
    JSON.stringify(pre.visibleText ?? []) !== JSON.stringify(post.visibleText ?? []) ||
    JSON.stringify(
      pre.elements.map((element) => ({
        ref: element.ref,
        label: element.label,
        description: element.description,
        value: element.value,
      })),
    ) !==
      JSON.stringify(
        post.elements.map((element) => ({
          ref: element.ref,
          label: element.label,
          description: element.description,
          value: element.value,
        })),
      )
  );
}

function secondaryActionIsAdvertised(element: ElementRef, action: string): boolean {
  const requested = action.trim().toLowerCase();
  return (
    requested.length > 0 &&
    element.secondaryActions?.some((candidate) => candidate.trim().toLowerCase() === requested) ===
      true
  );
}

async function resolveFromFreshSnapshot(
  input: GuiControlInput,
  target: AppTarget,
): Promise<
  | {
      ok: true;
      snapshot: GuiSnapshot;
      element: ElementRef;
      candidates: ElementRef[];
      summary: string;
    }
  | { ok: false; snapshot: GuiSnapshot; candidates: ElementRef[]; summary: string }
> {
  // Element refs are only trustworthy against a fresh observation. We resolve
  // here, then let the verifier re-observe before mutating so stale refs do not
  // become silent wrong-target actions.
  const snapshot = await input.runtime.observe(target);
  const resolution = resolveElementRef(snapshot, {
    ref: input.ref,
    intent: input.intent ?? "any",
    labelIncludes: input.labelIncludes,
    valueIncludes: input.valueIncludes,
  });
  return resolution.ok
    ? {
        ok: true,
        snapshot,
        element: resolution.element,
        candidates: resolution.candidates,
        summary: resolution.summary,
      }
    : {
        ok: false,
        snapshot,
        candidates: resolution.candidates,
        summary: resolution.summary,
      };
}

export async function runGuiControl(input: GuiControlInput): Promise<GuiControlResult> {
  const target: AppTarget = {
    appName: input.appName,
    windowTitle: input.windowTitle,
  };

  if (input.action === "observe") {
    const snapshot = await input.runtime.observe(target);
    if (!guiTargetMatchesSnapshot(target, snapshot)) {
      const summary = describeGuiTargetMismatch(target, snapshot);
      return {
        ok: false,
        action: input.action,
        target,
        snapshot: summarizeSnapshot(snapshot, input.maxElements),
        summary,
        blocked: true,
        failureReason: summary,
      };
    }
    return {
      ok: true,
      action: input.action,
      target,
      snapshot: summarizeSnapshot(snapshot, input.maxElements),
    };
  }

  if (input.action === "press") {
    if (!input.keys?.length) {
      throw new Error("gui-control press requires --keys.");
    }
    if (!input.verifyText && !input.allowObservedClick) {
      const summary =
        "Press requires --verify-text for task proof, or --allow-observed-click for an explicitly accepted changed-state proof.";
      return {
        ok: false,
        action: input.action,
        target,
        summary,
        blocked: true,
        failureReason: summary,
      };
    }
    const result = await performVerifiedAction({
      runtime: input.runtime,
      target,
      actionType: "press",
      keys: input.keys,
      reason: input.reason ?? "Press a scoped key combo in a GUI app.",
      approvedPolicyRisk: input.approvedPolicyRisk === true,
      taskPolicy: input.taskPolicy,
      verify: (post, context) =>
        input.verifyText
          ? {
              ok: visibleTextContains(post, input.verifyText),
              summary: `Post-state should contain ${JSON.stringify(input.verifyText)}.`,
            }
          : {
              ok: snapshotChanged(context.pre, post),
              summary:
                "Scoped press executed and target was re-observed with changed visible state.",
            },
    });
    return {
      ok: result.ok,
      action: input.action,
      target,
      summary: result.audit.postStateVerification,
      verifiedAction: result,
      blocked: result.audit.result === "blocked",
      failureReason: result.failureReason,
    };
  }

  const resolution = await resolveFromFreshSnapshot(input, target);
  if (!guiTargetMatchesSnapshot(target, resolution.snapshot)) {
    const summary = describeGuiTargetMismatch(target, resolution.snapshot);
    return {
      ok: false,
      action: input.action,
      target,
      snapshot: summarizeSnapshot(resolution.snapshot, input.maxElements),
      summary,
      blocked: true,
      failureReason: summary,
    };
  }
  if (input.action === "resolve-element") {
    return {
      ok: resolution.ok,
      action: input.action,
      target,
      snapshot: summarizeSnapshot(resolution.snapshot, input.maxElements),
      summary: resolution.summary,
      element: resolution.ok ? resolution.element : undefined,
      candidates: summarizeElements(resolution.candidates, input.maxElements),
      blocked: !resolution.ok,
      failureReason: resolution.ok ? undefined : resolution.summary,
    };
  }
  if (!resolution.ok) {
    return {
      ok: false,
      action: input.action,
      target,
      snapshot: summarizeSnapshot(resolution.snapshot, input.maxElements),
      summary: resolution.summary,
      candidates: summarizeElements(resolution.candidates, input.maxElements),
      blocked: true,
      failureReason: resolution.summary,
    };
  }

  if (input.action === "set-value") {
    if (input.value === undefined) {
      throw new Error("gui-control set-value requires --value.");
    }
    const result = await performVerifiedAction({
      runtime: input.runtime,
      target,
      element: resolution.element,
      actionType: "setValue",
      value: input.value,
      reason: input.reason ?? "Set a GUI element value.",
      approvedPolicyRisk: input.approvedPolicyRisk === true,
      taskPolicy: input.taskPolicy,
      verificationTimeoutMs: 10_000,
      verificationIntervalMs: 750,
      verify: (post) => ({
        ok: elementValueMatches(post, resolution.element, input.value ?? ""),
        summary: "Post-state should contain the requested value.",
      }),
    });
    return {
      ok: result.ok,
      action: input.action,
      target,
      summary: result.audit.postStateVerification,
      verifiedAction: result,
      blocked: result.audit.result === "blocked",
      failureReason: result.failureReason,
    };
  }

  if (input.action === "click") {
    if (!input.verifyText && !input.allowObservedClick) {
      const summary =
        "Click requires --verify-text for task proof, or --allow-observed-click for an explicitly accepted changed-state proof.";
      return {
        ok: false,
        action: input.action,
        target,
        snapshot: summarizeSnapshot(resolution.snapshot, input.maxElements),
        summary,
        element: resolution.element,
        blocked: true,
        failureReason: summary,
      };
    }
    const result = await performVerifiedAction({
      runtime: input.runtime,
      target,
      element: resolution.element,
      actionType: "click",
      reason: input.reason ?? "Click a GUI element.",
      approvedPolicyRisk: input.approvedPolicyRisk === true,
      taskPolicy: input.taskPolicy,
      verify: (post, context) =>
        input.verifyText
          ? {
              ok: visibleTextContains(post, input.verifyText),
              summary: `Post-state should contain ${JSON.stringify(input.verifyText)}.`,
            }
          : {
              ok: snapshotChanged(context.pre, post),
              summary: "Click executed and target was re-observed with changed visible state.",
            },
    });
    return {
      ok: result.ok,
      action: input.action,
      target,
      summary: result.audit.postStateVerification,
      verifiedAction: result,
      blocked: result.audit.result === "blocked",
      failureReason: result.failureReason,
    };
  }

  if (input.action === "secondary-action") {
    if (!input.secondaryAction?.trim()) {
      throw new Error("gui-control secondary-action requires --secondary-action.");
    }
    if (!input.verifyText && !input.allowObservedClick) {
      const summary =
        "Secondary action requires --verify-text for task proof, or --allow-observed-click for an explicitly accepted changed-state proof.";
      return {
        ok: false,
        action: input.action,
        target,
        snapshot: summarizeSnapshot(resolution.snapshot, input.maxElements),
        summary,
        element: resolution.element,
        blocked: true,
        failureReason: summary,
      };
    }
    const secondaryAction = input.secondaryAction.trim();
    // Secondary actions are runtime-advertised affordances, not free-form
    // commands. If the fresh element does not expose the action, failing here
    // keeps OCU/browser adapters from mutating an ambiguous target anyway.
    if (!secondaryActionIsAdvertised(resolution.element, secondaryAction)) {
      const summary = `Refusing secondary action ${JSON.stringify(
        secondaryAction,
      )} because fresh element ${resolution.element.ref} does not advertise it.`;
      return {
        ok: false,
        action: input.action,
        target,
        snapshot: summarizeSnapshot(resolution.snapshot, input.maxElements),
        summary,
        element: resolution.element,
        blocked: true,
        failureReason: summary,
      };
    }
    const result = await performVerifiedAction({
      runtime: input.runtime,
      target,
      element: resolution.element,
      actionType: "secondaryAction",
      secondaryAction,
      reason: input.reason ?? `Perform GUI secondary action ${secondaryAction}.`,
      approvedPolicyRisk: input.approvedPolicyRisk === true,
      taskPolicy: input.taskPolicy,
      verify: (post, context) =>
        input.verifyText
          ? {
              ok: visibleTextContains(post, input.verifyText),
              summary: `Post-state should contain ${JSON.stringify(input.verifyText)}.`,
            }
          : {
              ok: snapshotChanged(context.pre, post),
              summary:
                "Secondary action executed and target was re-observed with changed visible state.",
            },
    });
    return {
      ok: result.ok,
      action: input.action,
      target,
      summary: result.audit.postStateVerification,
      verifiedAction: result,
      blocked: result.audit.result === "blocked",
      failureReason: result.failureReason,
    };
  }

  if (input.action === "scroll") {
    const result = await performVerifiedAction({
      runtime: input.runtime,
      target,
      element: resolution.element,
      actionType: "scroll",
      scroll: { direction: input.scrollDirection, amount: input.scrollAmount },
      reason: input.reason ?? "Scroll a GUI element.",
      approvedPolicyRisk: input.approvedPolicyRisk === true,
      taskPolicy: input.taskPolicy,
      verify: (post, context) =>
        input.verifyText
          ? {
              ok: visibleTextContains(post, input.verifyText),
              summary: `Post-state should contain ${JSON.stringify(input.verifyText)}.`,
            }
          : {
              ok: snapshotChanged(context.pre, post),
              summary: "Scroll executed and target was re-observed with changed visible state.",
            },
    });
    return {
      ok: result.ok,
      action: input.action,
      target,
      summary: result.audit.postStateVerification,
      verifiedAction: result,
      blocked: result.audit.result === "blocked",
      failureReason: result.failureReason,
    };
  }

  throw new Error("Unsupported gui-control action.");
}
