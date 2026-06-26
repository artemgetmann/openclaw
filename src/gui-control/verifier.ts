import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluateGuiPolicy, type GuiTaskPolicy } from "./policy.js";
import { describeGuiTargetMismatch, guiTargetMatchesSnapshot } from "./targeting.js";
import type {
  AppTarget,
  ElementRef,
  GuiActionType,
  GuiAuditRecord,
  GuiRuntime,
  GuiSnapshot,
  GuiVerifierStats,
  ActionResult,
  VerificationResult,
  VerifiedActionResult,
} from "./types.js";

export type VerifiedActionInput = {
  runtime: GuiRuntime;
  target: AppTarget;
  element?: ElementRef;
  actionType: Exclude<GuiActionType, "observe">;
  value?: string;
  secondaryAction?: string;
  keys?: string[];
  scroll?: { direction?: "up" | "down" | "left" | "right"; amount?: number };
  reason: string;
  approvedPolicyRisk?: boolean;
  taskPolicy?: GuiTaskPolicy;
  verificationTimeoutMs?: number;
  verificationIntervalMs?: number;
  verify: (
    snapshot: GuiSnapshot,
    context: { pre: GuiSnapshot; action: ActionResult },
  ) => VerificationResult;
};

function newStats(): GuiVerifierStats {
  return {
    actionCount: 0,
    retries: 0,
    staleRefs: 0,
    usedClipboard: false,
    movedFocus: false,
    falseSuccesses: 0,
    falseFailures: 0,
  };
}

function boundedVerificationTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(30_000, Math.trunc(value)));
}

function boundedVerificationIntervalMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 500;
  }
  return Math.max(100, Math.min(2_000, Math.trunc(value)));
}

function elementSemanticSignature(element: ElementRef): string {
  return [
    element.role,
    element.label,
    element.name,
    element.title,
    element.description,
    element.appName,
    element.windowTitle,
  ]
    .map((value) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase())
    .join("\n");
}

function findElement(snapshot: GuiSnapshot, element: ElementRef): ElementRef | undefined {
  const exact = snapshot.elements.find((candidate) => candidate.ref === element.ref);
  if (exact) {
    return exact;
  }

  // OCU element indexes are snapshot-local. If a fresh observe renumbers a
  // stable Send button, allow exactly one semantic match instead of failing
  // before the verified action can run.
  const signature = elementSemanticSignature(element);
  if (!signature.trim()) {
    return undefined;
  }
  const semanticMatches = snapshot.elements.filter(
    (candidate) => elementSemanticSignature(candidate) === signature,
  );
  return semanticMatches.length === 1 ? semanticMatches[0] : undefined;
}

function secondaryActionIsAdvertised(element: ElementRef, action: string): boolean {
  const requested = action.trim().toLowerCase();
  return (
    element.secondaryActions?.some((candidate) => candidate.trim().toLowerCase() === requested) ===
    true
  );
}

function blockedSecondaryActionReason(
  input: VerifiedActionInput,
  element?: ElementRef,
): string | undefined {
  if (input.actionType !== "secondaryAction") {
    return undefined;
  }
  const action = input.secondaryAction?.trim();
  if (!action) {
    return "secondaryAction requires an action name.";
  }
  if (!element) {
    return "secondaryAction requires an element.";
  }
  if (!secondaryActionIsAdvertised(element, action)) {
    return `Element ${element.ref} does not advertise secondary action ${action}.`;
  }
  return undefined;
}

function numericElementRef(element: ElementRef): number | undefined {
  const match = /^@?(\d+)$/.exec(element.ref);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function browserAppName(value: string | undefined): boolean {
  return /^(safari|google chrome|chrome|arc|firefox)$/i.test((value ?? "").trim());
}

function elementText(element: ElementRef): string {
  return [
    element.role,
    element.label,
    element.name,
    element.title,
    element.description,
    element.value,
  ]
    .map((value) => (value ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

function hasSemanticPressAction(element: ElementRef): boolean {
  return Boolean(element.secondaryActions?.some((action) => /^(?:AX)?Press$/i.test(action.trim())));
}

function isInteractiveSibling(element: ElementRef): boolean {
  const text = elementText(element).toLowerCase();
  return /\b(button|pop up button|link|switch|combo box|text field|tab)\b/.test(text);
}

function ambiguousBrowserActivationReason(
  input: VerifiedActionInput,
  snapshot: GuiSnapshot,
  element: ElementRef | undefined,
): string | undefined {
  if (input.actionType !== "click" || !element || !browserAppName(input.target.appName)) {
    return undefined;
  }

  const selectedText = elementText(element);
  const selectedRef = numericElementRef(element);
  if (
    selectedRef === undefined ||
    element.bounds ||
    hasSemanticPressAction(element) ||
    selectedText.length < 160 ||
    !/\blink\b/i.test(selectedText)
  ) {
    return undefined;
  }

  // Safari/OCU can expose a whole web result row as one long AX link while
  // sibling controls inside the same visual card remain separate AX elements.
  // Without bounds, secondary actions, or hit-test proof, a generic click can
  // land on a sibling such as "emissions" or "details" even though policy
  // approved the row link. Block that class before mutation; post-state
  // verification is too late because the wrong reversible control has already
  // been activated.
  const nearbyInteractiveSiblings = snapshot.elements.filter((candidate) => {
    const candidateRef = numericElementRef(candidate);
    return (
      candidateRef !== undefined &&
      candidateRef > selectedRef &&
      candidateRef <= selectedRef + 12 &&
      candidate.ref !== element.ref &&
      isInteractiveSibling(candidate)
    );
  });

  if (!nearbyInteractiveSiblings.length) {
    return undefined;
  }

  const refs = nearbyInteractiveSiblings
    .slice(0, 3)
    .map((candidate) => candidate.ref)
    .join(", ");
  return `Refusing blind click on broad browser link ${element.ref}: no bounds or semantic Press action are exposed, and nearby interactive sibling controls (${refs}) make exact activation ambiguous.`;
}

function createAudit(params: {
  target: AppTarget;
  element?: ElementRef;
  actionType: GuiActionType;
  reason: string;
  risk: GuiAuditRecord["risk"];
  pre?: GuiSnapshot;
  result: GuiAuditRecord["result"];
  postStateVerification?: string;
  failureReason?: string;
}): GuiAuditRecord {
  return {
    id: `gui-audit-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    appName: params.target.appName,
    windowTitle: params.target.windowTitle ?? params.pre?.windowTitle,
    elementRef: params.element?.ref,
    actionType: params.actionType,
    reason: params.reason,
    risk: params.risk,
    preStateSummary: params.pre?.summary,
    postStateVerification: params.postStateVerification,
    result: params.result,
    failureReason: params.failureReason,
  };
}

function failedResult(params: {
  input: VerifiedActionInput;
  risk: GuiAuditRecord["risk"];
  stats: GuiVerifierStats;
  pre?: GuiSnapshot;
  failureReason: string;
}): VerifiedActionResult {
  params.stats.postStateResult = params.risk === "blocked" ? "blocked" : "failed";
  return {
    ok: false,
    audit: createAudit({
      target: params.input.target,
      element: params.input.element,
      actionType: params.input.actionType,
      reason: params.input.reason,
      risk: params.risk,
      pre: params.pre,
      result: "failed",
      failureReason: params.failureReason,
    }),
    stats: params.stats,
    failureReason: params.failureReason,
  };
}

async function executeRuntimeAction(input: VerifiedActionInput, element?: ElementRef) {
  if (input.actionType === "setValue") {
    if (input.value === undefined) {
      throw new Error("setValue action requires a value.");
    }
    if (!element) {
      throw new Error("setValue action requires an element.");
    }
    return input.runtime.setValue(element, input.value);
  }
  if (input.actionType === "click") {
    if (!element) {
      throw new Error("click action requires an element.");
    }
    return input.runtime.click(element);
  }
  if (input.actionType === "secondaryAction") {
    if (!input.runtime.performSecondaryAction) {
      throw new Error("Runtime does not support secondary actions.");
    }
    if (!element) {
      throw new Error("secondaryAction requires an element.");
    }
    if (!input.secondaryAction) {
      throw new Error("secondaryAction requires an action name.");
    }
    return input.runtime.performSecondaryAction(element, input.secondaryAction);
  }
  if (input.actionType === "press") {
    if (!input.runtime.press) {
      throw new Error("Runtime does not support press.");
    }
    return input.runtime.press(input.target, input.keys ?? []);
  }
  if (input.actionType === "scroll") {
    if (!input.runtime.scroll) {
      throw new Error("Runtime does not support scroll.");
    }
    if (!element) {
      throw new Error("scroll action requires an element.");
    }
    return input.runtime.scroll(element, input.scroll);
  }
  throw new Error("Unsupported GUI action.");
}

export async function performVerifiedAction(
  input: VerifiedActionInput,
): Promise<VerifiedActionResult> {
  const stats = newStats();
  const pre = await input.runtime.observe(input.target);

  if (!guiTargetMatchesSnapshot(input.target, pre)) {
    return failedResult({
      input,
      risk: "blocked",
      stats,
      pre,
      failureReason: describeGuiTargetMismatch(input.target, pre),
    });
  }

  const elementlessAction = input.actionType === "press";
  let element = elementlessAction || !input.element ? undefined : findElement(pre, input.element);
  if (!elementlessAction && !element) {
    return failedResult({
      input,
      risk: "blocked",
      stats,
      pre,
      failureReason: `Missing element ref ${input.element?.ref ?? "unknown"}.`,
    });
  }

  // Secondary actions are AX/runtime-advertised affordances on the current
  // element, so stale caller metadata cannot authorize a mutation on re-observe.
  const secondaryActionBlock = blockedSecondaryActionReason(input, element);
  if (secondaryActionBlock) {
    return failedResult({
      input,
      risk: "blocked",
      stats,
      pre,
      failureReason: secondaryActionBlock,
    });
  }

  const policy = evaluateGuiPolicy({
    actionType: input.actionType,
    target: input.target,
    snapshot: pre,
    element,
    secondaryAction: input.secondaryAction,
    reason: input.reason,
    approvedPolicyRisk: input.approvedPolicyRisk,
    taskPolicy: input.taskPolicy,
    verificationMode: "post_state",
  });
  if (!policy.allowed) {
    return {
      ok: false,
      audit: createAudit({
        target: input.target,
        element,
        actionType: input.actionType,
        reason: input.reason,
        risk: policy.risk,
        pre,
        result: "blocked",
        failureReason: policy.reason ?? "Blocked by GUI policy.",
      }),
      stats,
      failureReason: policy.reason ?? "Blocked by GUI policy.",
    };
  }

  const ambiguousActivation = ambiguousBrowserActivationReason(input, pre, element);
  if (ambiguousActivation) {
    return failedResult({
      input,
      risk: policy.risk,
      stats,
      pre,
      failureReason: ambiguousActivation,
    });
  }

  let action = await executeRuntimeAction(input, element);
  stats.actionCount += action.actionCount ?? 1;
  stats.usedClipboard ||= Boolean(action.usedClipboard);
  stats.movedFocus ||= Boolean(action.movedFocus);
  stats.activationPath = action.activationPath;
  stats.activationPaths = action.activationPath ? [action.activationPath] : undefined;

  // Executor status is advisory. A stale ref gets one fresh observation and one
  // retry; repeated stale state means the runtime no longer knows its target.
  if (action.staleRef) {
    stats.staleRefs += 1;
    stats.retries += 1;
    const refreshed = await input.runtime.observe(input.target);
    element =
      elementlessAction || !input.element ? undefined : findElement(refreshed, input.element);
    if ((!elementlessAction && !element) || !guiTargetMatchesSnapshot(input.target, refreshed)) {
      return failedResult({
        input,
        risk: policy.risk,
        stats,
        pre,
        failureReason: "Stale ref recovery failed during re-observe.",
      });
    }
    const refreshedSecondaryActionBlock = blockedSecondaryActionReason(input, element);
    if (refreshedSecondaryActionBlock) {
      return failedResult({
        input,
        risk: policy.risk,
        stats,
        pre,
        failureReason: refreshedSecondaryActionBlock,
      });
    }
    const refreshedAmbiguousActivation = ambiguousBrowserActivationReason(
      input,
      refreshed,
      element,
    );
    if (refreshedAmbiguousActivation) {
      return failedResult({
        input,
        risk: policy.risk,
        stats,
        pre,
        failureReason: refreshedAmbiguousActivation,
      });
    }
    action = await executeRuntimeAction(input, element);
    stats.actionCount += action.actionCount ?? 1;
    stats.usedClipboard ||= Boolean(action.usedClipboard);
    stats.movedFocus ||= Boolean(action.movedFocus);
    stats.activationPath = action.activationPath;
    stats.activationPaths = action.activationPath ? [action.activationPath] : undefined;
    if (action.staleRef) {
      stats.staleRefs += 1;
      return failedResult({
        input,
        risk: policy.risk,
        stats,
        pre,
        failureReason: "Repeated stale ref; failing closed.",
      });
    }
  }

  // Post-state verification is the actual success signal. This catches the
  // false-success class seen in GUI bakeoffs where a tool reports success but
  // the visible app did not reach the intended state.
  let post = await input.runtime.observe(input.target);
  if (!guiTargetMatchesSnapshot(input.target, post)) {
    return failedResult({
      input,
      risk: policy.risk,
      stats,
      pre,
      failureReason: describeGuiTargetMismatch(input.target, post),
    });
  }
  let verification = input.verify(post, { pre, action });
  const timeoutMs = boundedVerificationTimeoutMs(input.verificationTimeoutMs);
  const intervalMs = boundedVerificationIntervalMs(input.verificationIntervalMs);
  const deadline = Date.now() + timeoutMs;
  while (!verification.ok && Date.now() < deadline) {
    stats.retries += 1;
    await sleep(intervalMs);
    post = await input.runtime.observe(input.target);
    if (!guiTargetMatchesSnapshot(input.target, post)) {
      return failedResult({
        input,
        risk: policy.risk,
        stats,
        pre,
        failureReason: describeGuiTargetMismatch(input.target, post),
      });
    }
    verification = input.verify(post, { pre, action });
  }
  if (!verification.ok) {
    if (action.ok) {
      stats.falseSuccesses += 1;
    }
    stats.postStateResult = "failed";
    return {
      ok: false,
      snapshot: post,
      audit: createAudit({
        target: input.target,
        element,
        actionType: input.actionType,
        reason: input.reason,
        risk: policy.risk,
        pre,
        postStateVerification: verification.summary,
        result: "failed",
        failureReason: verification.summary,
      }),
      stats,
      failureReason: verification.summary,
    };
  }
  if (!action.ok) {
    stats.falseFailures += 1;
  }
  stats.postStateResult = "verified";

  return {
    ok: true,
    snapshot: post,
    audit: createAudit({
      target: input.target,
      element,
      actionType: input.actionType,
      reason: input.reason,
      risk: policy.risk,
      pre,
      postStateVerification: verification.summary,
      result: "verified",
    }),
    stats,
  };
}
