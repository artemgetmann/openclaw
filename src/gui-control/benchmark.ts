import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentDesktopRuntime } from "./agent-desktop-runtime.js";
import { resolveElementRef } from "./element-resolution.js";
import { OpenComputerUseRuntime } from "./open-computer-use-runtime.js";
import { getGuiTaskPolicyProfile } from "./policy.js";
import { describeGuiTargetMismatch, guiTargetMatchesSnapshot } from "./targeting.js";
import type {
  AppState,
  AppTarget,
  GuiAuditRecord,
  GuiRuntime,
  GuiRuntimeName,
  GuiSnapshot,
  GuiVerifierStats,
  ElementRef,
  VirtualPointerEvidence,
  WindowState,
} from "./types.js";
import { performVerifiedAction } from "./verifier.js";

export type GuiBenchmarkTask = "x-to-claude" | "safari-notes-claude" | "workspace-restore";

export type GuiBenchmarkOptions = {
  runtime: GuiRuntimeName;
  task: GuiBenchmarkTask;
  dryRun?: boolean;
  writeReport?: boolean;
  reportDir?: string;
  approveClaudeSend?: boolean;
  approveNotesWrite?: boolean;
  openXHome?: boolean;
  openClaudeNew?: boolean;
  claudeInputRef?: string;
  replyExtractionTimeoutMs?: number;
  replyExtractionIntervalMs?: number;
  allowClipboardFallback?: boolean;
  progress?: (message: string) => void;
  runtimeImpl?: GuiRuntime;
};

export type GuiBenchmarkResult = {
  ok: boolean;
  runtime: GuiRuntimeName;
  task: GuiBenchmarkTask;
  dryRun: boolean;
  elapsedSeconds: number;
  actionCount: number;
  retries: number;
  staleRefs: number;
  usedClipboard: boolean;
  movedFocus: boolean;
  falseSuccesses: number;
  falseFailures: number;
  directRuntimeEscape: boolean;
  replyTextExtracted: boolean;
  replyExtractionMethod: "none" | "ax-visible-text" | "clipboard-copy";
  xWindow: {
    openAttempted: boolean;
    openSucceeded: boolean | null;
    selectedWindowId?: string;
    selectedWindowTitle?: string;
    failureReason?: string;
  };
  workspace: {
    frontmostBefore?: string;
    frontmostAfter?: string;
    frontmostAfterTask?: string;
    focusedWindowBefore?: {
      id?: string;
      appName: string;
      title?: string;
    };
    focusedWindowAfterTask?: {
      id?: string;
      appName: string;
      title?: string;
    };
    focusedWindowAfter?: {
      id?: string;
      appName: string;
      title?: string;
    };
    frontmostChanged: boolean | null;
    frontmostRestored: boolean | null;
    restoreAttempted: boolean;
    restoreSucceeded: boolean | null;
    restoreActionCount: number;
    restoreFailureReason?: string;
    workspaceMeasurement:
      | "clean"
      | "changed-by-runtime"
      | "user-interference-suspected"
      | "unknown";
    notes: string;
  };
  qualityGate: {
    codexComputerUseParity: "pass" | "functional-pass-with-debt" | "fail" | "not-measured";
    onParWithCodexComputerUse: boolean | null;
    baselineElapsedSeconds: number;
    baselineActionCount: number;
    blockers: string[];
  };
  stageManager: {
    sameStageOrBackgroundSafe: boolean | null;
    notes: string;
  };
  virtualPointer: {
    present: boolean | null;
    notes: string;
    evidencePath?: string;
  };
  audit: GuiAuditRecord[];
  markdownSummary: string;
  replyText?: string;
  restoreDiagnostics?: GuiWorkspaceRestoreDiagnostic[];
  reportPath?: string;
  failureReason?: string;
};

export type GuiWorkspaceRestoreDiagnostic = {
  name: string;
  sourceApp: string;
  destinationApp: string;
  sourceWindow?: {
    id?: string;
    title?: string;
  };
  destinationWindow?: {
    id?: string;
    title?: string;
  };
  setupAttempted: boolean;
  setupSucceeded: boolean | null;
  taskFocusAttempted: boolean;
  taskFocusSucceeded: boolean | null;
  restoreAttempted: boolean;
  restoreSucceeded: boolean | null;
  frontmostBefore?: string;
  frontmostAfterTask?: string;
  frontmostAfterRestore?: string;
  restoredFrontmost: boolean | null;
  actionCount: number;
  failureReason?: string;
};

type ReplyExtractionResult = {
  replyText?: string;
  method: GuiBenchmarkResult["replyExtractionMethod"];
  actionCount: number;
  usedClipboard: boolean;
};

type GuiBenchmarkResultBase = Omit<
  GuiBenchmarkResult,
  "markdownSummary" | "reportPath" | "workspace" | "qualityGate"
>;
type GuiBenchmarkResultWithWorkspace = GuiBenchmarkResultBase & {
  workspace: GuiBenchmarkResult["workspace"];
};
type GuiBenchmarkResultScored = Omit<GuiBenchmarkResult, "markdownSummary" | "reportPath">;

const CODEX_COMPUTER_USE_BASELINE = {
  elapsedSeconds: 95,
  actionCount: 10,
} as const;

function uniqueBenchmarkToken(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
}

function createDryRunRuntime(name: GuiRuntimeName): GuiRuntime {
  let claudeValue = "";
  let claudeReply = "";
  let notesValue = "";
  return {
    name,
    async listApps() {
      return [{ appName: "Safari" }, { appName: "Notes" }, { appName: "Claude" }];
    },
    async observe(target: AppTarget) {
      if (target.appName === "Safari") {
        return {
          id: "dry-safari",
          appName: "Safari",
          windowTitle: "X / Home",
          summary: "Dry-run X Home snapshot: visible feed content only; no X mutation planned.",
          elements: [{ ref: "@x-feed", role: "group", label: "Home feed" }],
        };
      }
      if (target.appName === "Notes") {
        return {
          id: "dry-notes",
          appName: "Notes",
          windowTitle: "Notes",
          summary: notesValue
            ? `Dry-run Apple Notes body contains ${notesValue}`
            : "Dry-run Apple Notes body ready.",
          visibleText: notesValue ? [notesValue] : ["Notes"],
          elements: [
            {
              ref: "@notes-body",
              role: "textArea",
              label: "Note body",
              value: notesValue || "Start typing",
              appName: "Notes",
              windowTitle: "Notes",
            },
          ],
        };
      }
      return {
        id: "dry-claude",
        appName: "Claude",
        windowTitle: "Claude",
        summary: claudeValue
          ? `Dry-run Claude composer contains ${claudeValue}`
          : claudeReply
            ? `Dry-run Claude reply: ${claudeReply}`
            : "Dry-run Claude composer ready.",
        visibleText: claudeReply ? [claudeReply] : undefined,
        elements: [
          {
            ref: "@claude-input",
            role: "textArea",
            label: "Message Claude composer",
            value: claudeValue || "Write a message…",
            appName: "Claude",
            windowTitle: "Claude",
          },
          { ref: "@claude-send", role: "button", label: "Send", appName: "Claude" },
        ],
      };
    },
    async setValue(target, value) {
      if (target.appName === "Notes") {
        notesValue = value;
      } else {
        claudeValue = value;
      }
      return { ok: true, actionCount: 1 };
    },
    async click(target) {
      if (target.appName === "Claude" || target.ref === "@claude-send") {
        const replyToken = claudeValue.match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1] ?? "";
        claudeReply = [
          "Claude dry-run reply acknowledged the visible benchmark context.",
          replyToken,
        ]
          .filter(Boolean)
          .join(" ");
        claudeValue = "";
      }
      return { ok: true, actionCount: 1 };
    },
    async openUrl() {
      return { ok: true, actionCount: 1, movedFocus: true };
    },
    async press() {
      const replyToken = claudeValue.match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1] ?? "";
      claudeReply = ["Claude dry-run reply acknowledged the visible X/Home summary.", replyToken]
        .filter(Boolean)
        .join(" ");
      claudeValue = "";
      return { ok: true, actionCount: 1, movedFocus: true };
    },
  };
}

function createBenchmarkRuntime(
  options: Pick<GuiBenchmarkOptions, "runtime" | "dryRun" | "reportDir">,
): GuiRuntime {
  const dryRun = Boolean(options.dryRun);
  if (dryRun) {
    return createDryRunRuntime(options.runtime);
  }
  if (options.runtime === "agent-desktop") {
    return new AgentDesktopRuntime();
  }
  if (options.runtime === "open-computer-use") {
    const reportDir = options.reportDir ?? path.join(process.cwd(), "artifacts", "gui-benchmark");
    return new OpenComputerUseRuntime({
      command: process.env.OPENCLAW_OPEN_COMPUTER_USE_BIN,
      visualCursorObservationFile: path.join(
        reportDir,
        "open-computer-use-visual-cursor-observation.json",
      ),
    });
  }
  throw new Error("Unsupported GUI runtime.");
}

function mergeStats(stats: GuiVerifierStats[]): GuiVerifierStats {
  return stats.reduce(
    (acc, stat) => ({
      actionCount: acc.actionCount + stat.actionCount,
      retries: acc.retries + stat.retries,
      staleRefs: acc.staleRefs + stat.staleRefs,
      usedClipboard: acc.usedClipboard || stat.usedClipboard,
      movedFocus: acc.movedFocus || stat.movedFocus,
      falseSuccesses: acc.falseSuccesses + stat.falseSuccesses,
      falseFailures: acc.falseFailures + stat.falseFailures,
    }),
    {
      actionCount: 0,
      retries: 0,
      staleRefs: 0,
      usedClipboard: false,
      movedFocus: false,
      falseSuccesses: 0,
      falseFailures: 0,
    },
  );
}

function emptyGuiVerifierStats(): GuiVerifierStats {
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

function statsFromActionResult(result: {
  actionCount?: number;
  staleRef?: boolean;
  usedClipboard?: boolean;
  movedFocus?: boolean;
}): GuiVerifierStats {
  return {
    ...emptyGuiVerifierStats(),
    actionCount: result.actionCount ?? 0,
    staleRefs: result.staleRef ? 1 : 0,
    usedClipboard: Boolean(result.usedClipboard),
    movedFocus: Boolean(result.movedFocus),
  };
}

function addStats(target: GuiVerifierStats, extra: GuiVerifierStats) {
  target.actionCount += extra.actionCount;
  target.retries += extra.retries;
  target.staleRefs += extra.staleRefs;
  target.usedClipboard ||= extra.usedClipboard;
  target.movedFocus ||= extra.movedFocus;
  target.falseSuccesses += extra.falseSuccesses;
  target.falseFailures += extra.falseFailures;
}

function visibleSnapshotText(snapshot: { summary?: string; visibleText?: string[] }): string[] {
  return [snapshot.summary, ...(snapshot.visibleText ?? [])].filter((value): value is string =>
    Boolean(value?.trim()),
  );
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function textIncludesVisible(haystack: string | undefined, needle: string): boolean {
  return normalizeVisibleText(haystack ?? "").includes(normalizeVisibleText(needle));
}

function safariXWindowCandidates(windows: WindowState[]): WindowState[] {
  return windows.filter(
    (window) =>
      normalizeVisibleText(window.appName) === "safari" &&
      (/(^|\s|\()home\s*\/\s*x($|\s|\))/i.test(window.title ?? "") ||
        /^https:\/\/x\.com\/home(?:\b|[/?#])/i.test(window.title ?? "")),
  );
}

function resolveClaudeComposer(snapshot: GuiSnapshot, ref?: string) {
  const placeholderResolution = resolveElementRef(snapshot, {
    ref,
    intent: "text-input",
    valueIncludes: ref ? undefined : "Write a message",
  });
  if (placeholderResolution.ok || ref) {
    return placeholderResolution;
  }
  return resolveElementRef(snapshot, {
    intent: "text-input",
    labelIncludes: "Write your prompt to Claude",
  });
}

function resolveClaudeNewChatButton(snapshot: GuiSnapshot) {
  return resolveElementRef(snapshot, {
    intent: "button",
    labelIncludes: "New chat",
  });
}

function resolveNotesBody(snapshot: GuiSnapshot) {
  const scoredCandidates = snapshot.elements
    .map((element) => {
      const role = normalizeVisibleText(element.role ?? "");
      const text = normalizeVisibleText(elementSemanticText(element));
      const editableTextArea =
        role.includes("text entry area") ||
        role.includes("textarea") ||
        role.includes("text area") ||
        role.includes("text view") ||
        role.includes("edit") ||
        role.includes("input");
      if (!editableTextArea || role.includes("button") || role.includes("search")) {
        return { element, score: 0 };
      }

      // Apple Notes exposes many static strings containing "note"; only an
      // editable text view should be treated as the note body.
      let score = 10;
      if (role.includes("text entry area") || role.includes("textarea")) {
        score += 30;
      }
      if (text.includes("note body text view")) {
        score += 70;
      } else if (text.includes("note body")) {
        score += 60;
      } else if (text.includes("body")) {
        score += 40;
      } else if (text.includes("note")) {
        score += 15;
      }
      return { element, score };
    })
    .filter((candidate) => candidate.score > 0)
    .toSorted((left, right) => right.score - left.score);

  const [best, secondBest] = scoredCandidates;
  if (best && (!secondBest || best.score > secondBest.score)) {
    return {
      ok: true,
      element: best.element,
      candidates: scoredCandidates.map((candidate) => candidate.element),
      summary: `Resolved Apple Notes body element ${best.element.ref} role=${best.element.role ?? ""}.`,
    };
  }

  const bodyResolution = resolveElementRef(snapshot, {
    intent: "text-input",
    labelIncludes: "body",
  });
  if (bodyResolution.ok) {
    return bodyResolution;
  }
  return {
    ok: false,
    candidates: scoredCandidates.map((candidate) => candidate.element),
    summary: best
      ? `Found ${scoredCandidates.length} possible Apple Notes body elements; refusing to guess.`
      : "No editable Apple Notes body element matched the latest Notes snapshot.",
  };
}

function resolveNotesNewNoteButton(snapshot: GuiSnapshot) {
  return resolveElementRef(snapshot, {
    intent: "button",
    labelIncludes: "New Note",
  });
}

type ClaudeSubmitResolution =
  | {
      ok: true;
      actionType: "click" | "secondaryAction";
      element: ElementRef;
      secondaryAction?: string;
      summary: string;
    }
  | {
      ok: false;
      candidates: ElementRef[];
      summary: string;
    };

function elementSemanticText(element: ElementRef): string {
  return [
    element.role,
    element.label,
    element.name,
    element.title,
    element.description,
    element.value,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function matchingPressAction(element: ElementRef): string | undefined {
  return element.secondaryActions?.find((action) => /^(?:AX)?Press$/i.test(action.trim()));
}

function isClaudeSendControl(element: ElementRef): boolean {
  const text = normalizeVisibleText(elementSemanticText(element));
  const role = normalizeVisibleText(element.role ?? "");
  const hasSendLabel =
    /(^|[^a-z0-9])send([^a-z0-9]|$)/i.test(text) ||
    text.includes("send message") ||
    text.includes("send prompt");
  const looksDangerousOrWrong =
    text.includes("send later") ||
    text.includes("resend") ||
    text.includes("unsend") ||
    text.includes("copy");

  return (
    hasSendLabel &&
    !looksDangerousOrWrong &&
    (role.includes("button") || Boolean(matchingPressAction(element)))
  );
}

function resolveClaudeSubmitControl(snapshot: GuiSnapshot): ClaudeSubmitResolution {
  // OCU no-focus submit must target a real Send affordance. A keyboard fallback
  // can work visibly while still stealing the user's Stage Manager/frontmost app.
  const candidates = snapshot.elements.filter(isClaudeSendControl);
  if (candidates.length !== 1) {
    return {
      ok: false,
      candidates,
      summary:
        candidates.length === 0
          ? "No semantic Claude Send control was present after writing the benchmark message."
          : `Found ${candidates.length} possible Claude Send controls; refusing to guess.`,
    };
  }

  const element = candidates[0];
  if (!element) {
    return {
      ok: false,
      candidates,
      summary: "No semantic Claude Send control was present after writing the benchmark message.",
    };
  }

  if (normalizeVisibleText(element.role ?? "").includes("button")) {
    return {
      ok: true,
      actionType: "click",
      element,
      summary: `Resolved semantic Claude Send click target ${element.ref}.`,
    };
  }

  const secondaryAction = matchingPressAction(element);
  return secondaryAction
    ? {
        ok: true,
        actionType: "secondaryAction",
        element,
        secondaryAction,
        summary: `Resolved semantic Claude Send secondary action ${secondaryAction} on ${element.ref}.`,
      }
    : {
        ok: false,
        candidates,
        summary: "Claude Send control did not expose a click or Press action.",
      };
}

function emptyStats(): GuiVerifierStats {
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

async function resolveBenchmarkSafariTarget(
  runtime: GuiRuntime,
  options: { allowObservedOpenComputerUseTarget?: boolean } = {},
): Promise<
  { ok: true; target: AppTarget } | { ok: false; failureReason: string; candidates: WindowState[] }
> {
  if (!runtime.listWindows) {
    return { ok: true, target: { appName: "Safari", windowTitle: "X" } };
  }

  const candidates = safariXWindowCandidates(await runtime.listWindows());
  if (candidates.length === 1) {
    const window = candidates[0];
    return {
      ok: true,
      target: {
        appName: "Safari",
        windowTitle: window.title ?? "Home / X",
        windowId: window.id,
      },
    };
  }
  if (candidates.length === 0 && options.allowObservedOpenComputerUseTarget) {
    // OCU currently exposes `list_apps` but not real window inventory. After
    // opening X Home, let the following `get_app_state` title check prove the
    // Safari target instead of failing on missing list-window metadata.
    return {
      ok: true,
      target: { appName: "Safari", windowTitle: "Home / X" },
    };
  }

  const renderedCandidates = candidates
    .map((window) => `${window.id ?? "unknown"}:${window.title ?? "untitled"}`)
    .join(", ");
  return {
    ok: false,
    failureReason:
      candidates.length === 0
        ? "No exact Safari Home / X window was found for the benchmark."
        : `Ambiguous Safari Home / X windows: ${renderedCandidates}`,
    candidates,
  };
}

async function prepareBenchmarkSafariTarget(input: {
  runtime: GuiRuntime;
  openXHome: boolean;
  dryRun: boolean;
}): Promise<
  | {
      ok: true;
      target: AppTarget;
      xWindow: GuiBenchmarkResult["xWindow"];
      stats: GuiVerifierStats;
    }
  | {
      ok: false;
      failureReason: string;
      xWindow: GuiBenchmarkResult["xWindow"];
      stats: GuiVerifierStats;
    }
> {
  const stats = emptyStats();
  let openSucceeded: boolean | null = null;

  if (input.openXHome) {
    if (!input.runtime.openUrl) {
      return {
        ok: false,
        failureReason: "Runtime does not support opening X Home.",
        xWindow: {
          openAttempted: true,
          openSucceeded: false,
          failureReason: "Runtime does not support opening X Home.",
        },
        stats,
      };
    }

    const opened = await input.runtime.openUrl({ appName: "Safari" }, "https://x.com/home");
    stats.actionCount += opened.actionCount ?? 1;
    stats.movedFocus ||= Boolean(opened.movedFocus);
    openSucceeded = opened.ok;
    if (!opened.ok) {
      const failureReason = opened.message ?? "Failed to open X Home in Safari.";
      return {
        ok: false,
        failureReason,
        xWindow: {
          openAttempted: true,
          openSucceeded: false,
          failureReason,
        },
        stats,
      };
    }
  }

  const deadline = Date.now() + (input.openXHome && !input.dryRun ? 15_000 : 0);
  for (;;) {
    const resolution = await resolveBenchmarkSafariTarget(input.runtime, {
      allowObservedOpenComputerUseTarget: input.runtime.name === "open-computer-use",
    });
    if (resolution.ok) {
      return {
        ok: true,
        target: resolution.target,
        xWindow: {
          openAttempted: input.openXHome,
          openSucceeded,
          selectedWindowId: resolution.target.windowId,
          selectedWindowTitle: resolution.target.windowTitle,
        },
        stats,
      };
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        failureReason: resolution.failureReason,
        xWindow: {
          openAttempted: input.openXHome,
          openSucceeded,
          failureReason: resolution.failureReason,
        },
        stats,
      };
    }

    stats.retries += 1;
    await sleep(750);
  }
}

async function observeBenchmarkSafariSnapshot(input: {
  runtime: GuiRuntime;
  target: AppTarget;
  allowSettleRetry: boolean;
  dryRun: boolean;
  stats: GuiVerifierStats;
}): Promise<{ ok: true; snapshot: GuiSnapshot } | { ok: false; failureReason: string }> {
  const deadline = Date.now() + (input.allowSettleRetry && !input.dryRun ? 15_000 : 0);
  let lastFailureReason = "";

  for (;;) {
    const snapshot = await input.runtime.observe(input.target);
    if (guiTargetMatchesSnapshot(input.target, snapshot)) {
      return { ok: true, snapshot };
    }

    // Opening a URL can briefly expose Safari before AX reports the final tab
    // title/window state. Retry only in that post-open settle window; an
    // unstabilized or genuinely wrong target still fails before Claude is touched.
    lastFailureReason = describeGuiTargetMismatch(input.target, snapshot);
    if (Date.now() >= deadline) {
      return { ok: false, failureReason: lastFailureReason };
    }

    input.stats.retries += 1;
    await sleep(750);
  }
}

async function prepareBenchmarkClaudeTarget(input: {
  runtime: GuiRuntime;
  openClaudeNew: boolean;
  dryRun: boolean;
  progress: (message: string) => void;
}): Promise<
  | { ok: true; stats: GuiVerifierStats }
  | { ok: false; failureReason: string; stats: GuiVerifierStats }
> {
  if (!input.openClaudeNew) {
    return { ok: true, stats: emptyGuiVerifierStats() };
  }
  if (!input.runtime.openUrl) {
    return {
      ok: false,
      failureReason: "Selected GUI runtime cannot open a fresh Claude chat.",
      stats: emptyGuiVerifierStats(),
    };
  }

  input.progress("Opening Claude");
  const opened = await input.runtime.openUrl({ appName: "Claude" }, "https://claude.ai/new");
  const stats = statsFromActionResult(opened);
  if (!opened.ok) {
    return {
      ok: false,
      failureReason: opened.message ?? "Claude fresh-chat open failed.",
      stats,
    };
  }

  const deadline = Date.now() + (input.dryRun ? 0 : 20_000);
  let lastFailureReason = "";
  let attemptedReload = false;
  let clickedNewChat = false;
  for (;;) {
    const snapshot = await input.runtime.observe({ appName: "Claude" });
    if (!clickedNewChat && !input.dryRun) {
      const newChat = resolveClaudeNewChatButton(snapshot);
      if (newChat.ok) {
        input.progress("Opening Claude new chat");
        const clicked = await input.runtime.click(newChat.element);
        addStats(stats, statsFromActionResult(clicked));
        if (!clicked.ok) {
          return {
            ok: false,
            failureReason: clicked.message ?? "Claude New chat click failed.",
            stats,
          };
        }
        clickedNewChat = true;
        await sleep(3_000);
        continue;
      }
      lastFailureReason = newChat.summary;
    }
    const composer = resolveClaudeComposer(snapshot);
    if (composer.ok) {
      return { ok: true, stats };
    }
    lastFailureReason = composer.summary;
    if (!attemptedReload && !input.dryRun && input.runtime.press) {
      attemptedReload = true;
      input.progress("Reloading Claude");
      const reload = await input.runtime.press({ appName: "Claude" }, ["cmd+r"]);
      addStats(stats, statsFromActionResult(reload));
      if (!reload.ok) {
        return {
          ok: false,
          failureReason: reload.message ?? "Claude fresh-chat reload failed.",
          stats,
        };
      }
      await sleep(8_000);
      continue;
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        failureReason: `Claude fresh-chat composer was not available: ${lastFailureReason}`,
        stats,
      };
    }
    stats.retries += 1;
    await sleep(1_000);
  }
}

function frontmostAppName(apps: AppState[]): string | undefined {
  return apps.find((app) => app.frontmost)?.appName;
}

async function captureWorkspace(runtime: GuiRuntime): Promise<{
  frontmostApp?: string;
  focusedWindow?: WindowState;
  error?: string;
}> {
  try {
    if (runtime.listWindows) {
      const focusedWindow = (await runtime.listWindows()).find((window) => window.focused);
      if (focusedWindow) {
        return { frontmostApp: focusedWindow.appName, focusedWindow };
      }
    }
    return { frontmostApp: frontmostAppName(await runtime.listApps()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function windowForApp(windows: WindowState[], appName: string): WindowState | undefined {
  return (
    windows.find(
      (window) =>
        window.focused && normalizeVisibleText(window.appName) === normalizeVisibleText(appName),
    ) ??
    windows.find((window) => normalizeVisibleText(window.appName) === normalizeVisibleText(appName))
  );
}

function summarizeDiagnosticWindow(window: WindowState | undefined):
  | {
      id?: string;
      title?: string;
    }
  | undefined {
  return window
    ? {
        id: window.id,
        title: window.title,
      }
    : undefined;
}

async function runWorkspaceRestoreCase(input: {
  runtime: GuiRuntime;
  sourceApp: string;
  destinationApp: string;
}): Promise<GuiWorkspaceRestoreDiagnostic> {
  const name = `${input.sourceApp}->${input.destinationApp}->${input.sourceApp}`;
  const windows = input.runtime.listWindows ? await input.runtime.listWindows() : [];
  const sourceWindow = windowForApp(windows, input.sourceApp);
  const destinationWindow = windowForApp(windows, input.destinationApp);
  let actionCount = 0;

  if (!input.runtime.focusWindow || !input.runtime.listWindows) {
    return {
      name,
      sourceApp: input.sourceApp,
      destinationApp: input.destinationApp,
      sourceWindow: summarizeDiagnosticWindow(sourceWindow),
      destinationWindow: summarizeDiagnosticWindow(destinationWindow),
      setupAttempted: false,
      setupSucceeded: null,
      taskFocusAttempted: false,
      taskFocusSucceeded: null,
      restoreAttempted: false,
      restoreSucceeded: null,
      restoredFrontmost: null,
      actionCount,
      failureReason: "Runtime does not expose listWindows and focusWindow.",
    };
  }

  if (!sourceWindow || !destinationWindow) {
    return {
      name,
      sourceApp: input.sourceApp,
      destinationApp: input.destinationApp,
      sourceWindow: summarizeDiagnosticWindow(sourceWindow),
      destinationWindow: summarizeDiagnosticWindow(destinationWindow),
      setupAttempted: false,
      setupSucceeded: null,
      taskFocusAttempted: false,
      taskFocusSucceeded: null,
      restoreAttempted: false,
      restoreSucceeded: null,
      restoredFrontmost: null,
      actionCount,
      failureReason: `Missing diagnostic window: ${sourceWindow ? "" : input.sourceApp}${
        !sourceWindow && !destinationWindow ? ", " : ""
      }${destinationWindow ? "" : input.destinationApp}.`,
    };
  }

  const setup = await input.runtime.focusWindow(sourceWindow);
  actionCount += setup.actionCount ?? 1;
  await sleep(500);
  const before = await captureWorkspace(input.runtime);

  const taskFocus = await input.runtime.focusWindow(destinationWindow);
  actionCount += taskFocus.actionCount ?? 1;
  await sleep(500);
  const afterTask = await captureWorkspace(input.runtime);

  const restore = await input.runtime.focusWindow(sourceWindow);
  actionCount += restore.actionCount ?? 1;
  await sleep(500);
  const afterRestore = await captureWorkspace(input.runtime);

  const restoredFrontmost =
    afterRestore.frontmostApp && input.sourceApp
      ? normalizeVisibleText(afterRestore.frontmostApp) === normalizeVisibleText(input.sourceApp)
      : null;
  const failureReason =
    before.error ??
    afterTask.error ??
    afterRestore.error ??
    (setup.ok ? undefined : (setup.message ?? `Could not focus ${input.sourceApp} for setup.`)) ??
    (taskFocus.ok
      ? undefined
      : (taskFocus.message ?? `Could not focus ${input.destinationApp} for task step.`)) ??
    (restore.ok ? undefined : (restore.message ?? `Could not restore ${input.sourceApp}.`)) ??
    (restoredFrontmost === true
      ? undefined
      : `Expected ${input.sourceApp} frontmost after restore, saw ${
          afterRestore.frontmostApp ?? "unknown"
        }.`);

  return {
    name,
    sourceApp: input.sourceApp,
    destinationApp: input.destinationApp,
    sourceWindow: summarizeDiagnosticWindow(sourceWindow),
    destinationWindow: summarizeDiagnosticWindow(destinationWindow),
    setupAttempted: true,
    setupSucceeded: setup.ok,
    taskFocusAttempted: true,
    taskFocusSucceeded: taskFocus.ok,
    restoreAttempted: true,
    restoreSucceeded: restore.ok,
    frontmostBefore: before.frontmostApp,
    frontmostAfterTask: afterTask.frontmostApp,
    frontmostAfterRestore: afterRestore.frontmostApp,
    restoredFrontmost,
    actionCount,
    failureReason,
  };
}

async function restoreWorkspace(input: {
  runtime: GuiRuntime;
  workspaceBefore: Awaited<ReturnType<typeof captureWorkspace>>;
  dryRun: boolean;
  allowRestore: boolean;
}): Promise<{
  attempted: boolean;
  succeeded: boolean | null;
  actionCount: number;
  failureReason?: string;
}> {
  if (
    input.dryRun ||
    !input.allowRestore ||
    !input.runtime.focusWindow ||
    !input.workspaceBefore.focusedWindow
  ) {
    return { attempted: false, succeeded: null, actionCount: 0 };
  }

  const result = await input.runtime.focusWindow(input.workspaceBefore.focusedWindow);
  return {
    attempted: true,
    succeeded: result.ok,
    actionCount: result.actionCount ?? 1,
    failureReason: result.ok ? undefined : (result.message ?? "Failed to restore focused window."),
  };
}

function workspaceChanged(
  before: Awaited<ReturnType<typeof captureWorkspace>>,
  afterTask: Awaited<ReturnType<typeof captureWorkspace>>,
): boolean {
  if (before.frontmostApp && afterTask.frontmostApp) {
    return before.frontmostApp !== afterTask.frontmostApp;
  }
  if (before.focusedWindow && afterTask.focusedWindow) {
    return (
      before.focusedWindow.id !== afterTask.focusedWindow.id ||
      before.focusedWindow.appName !== afterTask.focusedWindow.appName ||
      before.focusedWindow.title !== afterTask.focusedWindow.title
    );
  }
  return false;
}

function summarizeWindow(window: WindowState | undefined):
  | {
      id?: string;
      appName: string;
      title?: string;
    }
  | undefined {
  return window
    ? {
        id: window.id,
        appName: window.appName,
        title: window.title,
      }
    : undefined;
}

function buildWorkspaceTelemetry(input: {
  before: Awaited<ReturnType<typeof captureWorkspace>>;
  afterTask: Awaited<ReturnType<typeof captureWorkspace>>;
  afterRestore: Awaited<ReturnType<typeof captureWorkspace>>;
  dryRun: boolean;
  restore: Awaited<ReturnType<typeof restoreWorkspace>>;
  runtimeMovedFocus: boolean;
}): GuiBenchmarkResult["workspace"] {
  const error = input.before.error ?? input.afterTask.error ?? input.afterRestore.error;
  if (error) {
    return {
      frontmostBefore: input.before.frontmostApp,
      frontmostAfterTask: input.afterTask.frontmostApp,
      frontmostAfter: input.afterRestore.frontmostApp,
      focusedWindowBefore: summarizeWindow(input.before.focusedWindow),
      focusedWindowAfterTask: summarizeWindow(input.afterTask.focusedWindow),
      focusedWindowAfter: summarizeWindow(input.afterRestore.focusedWindow),
      frontmostChanged: null,
      frontmostRestored: null,
      restoreAttempted: input.restore.attempted,
      restoreSucceeded: input.restore.succeeded,
      restoreActionCount: input.restore.actionCount,
      restoreFailureReason: input.restore.failureReason,
      workspaceMeasurement: "unknown",
      notes: `Workspace telemetry incomplete: ${error}`,
    };
  }
  if (
    !input.before.frontmostApp ||
    !input.afterTask.frontmostApp ||
    !input.afterRestore.frontmostApp
  ) {
    return {
      frontmostBefore: input.before.frontmostApp,
      frontmostAfterTask: input.afterTask.frontmostApp,
      frontmostAfter: input.afterRestore.frontmostApp,
      focusedWindowBefore: summarizeWindow(input.before.focusedWindow),
      focusedWindowAfterTask: summarizeWindow(input.afterTask.focusedWindow),
      focusedWindowAfter: summarizeWindow(input.afterRestore.focusedWindow),
      frontmostChanged: null,
      frontmostRestored: null,
      restoreAttempted: input.restore.attempted,
      restoreSucceeded: input.restore.succeeded,
      restoreActionCount: input.restore.actionCount,
      restoreFailureReason: input.restore.failureReason,
      workspaceMeasurement: "unknown",
      notes: input.dryRun
        ? "Dry-run runtime does not expose a frontmost app."
        : "Runtime did not report a frontmost app before and after the benchmark.",
    };
  }
  const changedDuringTask = input.before.frontmostApp !== input.afterTask.frontmostApp;
  const workspaceMeasurement = !changedDuringTask
    ? "clean"
    : input.runtimeMovedFocus
      ? "changed-by-runtime"
      : "user-interference-suspected";
  const frontmostRestored = input.before.frontmostApp === input.afterRestore.frontmostApp;
  return {
    frontmostBefore: input.before.frontmostApp,
    frontmostAfterTask: input.afterTask.frontmostApp,
    frontmostAfter: input.afterRestore.frontmostApp,
    focusedWindowBefore: summarizeWindow(input.before.focusedWindow),
    focusedWindowAfterTask: summarizeWindow(input.afterTask.focusedWindow),
    focusedWindowAfter: summarizeWindow(input.afterRestore.focusedWindow),
    frontmostChanged: !frontmostRestored,
    frontmostRestored,
    restoreAttempted: input.restore.attempted,
    restoreSucceeded: input.restore.succeeded,
    restoreActionCount: input.restore.actionCount,
    restoreFailureReason: input.restore.failureReason,
    workspaceMeasurement,
    notes:
      workspaceMeasurement === "user-interference-suspected"
        ? "Frontmost app changed without a runtime focus signal; restore skipped because user activity may have contaminated the measurement."
        : frontmostRestored
          ? "Frontmost app matched before and after the benchmark."
          : "Frontmost app changed during the benchmark and was not restored.",
  };
}

function composerContains(snapshot: GuiSnapshot, text: string): boolean {
  return snapshot.elements.some((element) => {
    const descriptor = normalizeVisibleText(
      [element.role, element.label, element.description, element.name, element.title]
        .filter(Boolean)
        .join(" "),
    );
    const looksLikeComposer =
      descriptor.includes("write your prompt to claude") ||
      descriptor.includes("write a message") ||
      descriptor.includes("text entry area") ||
      descriptor.includes("textarea") ||
      descriptor.includes("textfield") ||
      descriptor.includes("text field");

    // OCU text dumps often put the filled Claude composer in AX Description
    // instead of AXValue. Treat those composer-scoped fields as unsent input
    // so nearby visible text cannot be stitched into a fake assistant reply.
    return (
      looksLikeComposer &&
      [element.value, element.description, element.label].some((field) =>
        textIncludesVisible(field, text),
      )
    );
  });
}

function snapshotContainsText(snapshot: GuiSnapshot, text: string): boolean {
  return (
    snapshot.elements.some((element) => textIncludesVisible(element.value, text)) ||
    visibleSnapshotText(snapshot).some((visible) => textIncludesVisible(visible, text))
  );
}

function visibleReplyTextCandidates(snapshot: GuiSnapshot): string[] {
  const visibleText = visibleSnapshotText(snapshot);
  const candidates: string[] = [];
  const seen = new Set<string>();

  function addCandidate(text: string) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    const normalized = normalizeVisibleText(trimmed);
    if (!trimmed || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(trimmed);
  }

  for (let start = 0; start < visibleText.length; start += 1) {
    addCandidate(visibleText[start] ?? "");

    // AX often exposes one visual assistant message as adjacent text runs. Keep
    // reconstruction deterministic and bounded so unrelated page chrome is not
    // accidentally stitched into a "reply".
    for (let end = start + 1; end < Math.min(visibleText.length, start + 4); end += 1) {
      addCandidate(visibleText.slice(start, end + 1).join(" "));
    }
  }

  return candidates;
}

function claudeTextDumpAssistantHasToken(
  snapshot: GuiSnapshot,
  replyToken: string,
): boolean | null {
  const summary = snapshot.summary;
  if (!summary || !summary.includes('Window: "Claude"') || !/^\s*\d+\s+/m.test(summary)) {
    return null;
  }

  const lines = summary.split(/\r?\n/);
  let insideAssistantBlock = false;

  for (const line of lines) {
    if (/^\s*\d+\s+heading\s+You said:/i.test(line)) {
      insideAssistantBlock = false;
    }
    if (/^\s*\d+\s+heading\s+Claude responded:/i.test(line)) {
      insideAssistantBlock = true;
    }
    if (/^\s*\d+\s+container\s+Message actions\b/i.test(line)) {
      insideAssistantBlock = false;
    }

    if (!textIncludesVisible(line, replyToken)) {
      continue;
    }

    const normalized = normalizeVisibleText(line);
    const promptEcho =
      normalized.includes("you said:") ||
      normalized.includes("jarvis gui benchmark x-to-claude") ||
      normalized.includes("jarvis gui benchmark safari-notes-claude") ||
      normalized.includes("when you respond, include the reply token") ||
      normalized.includes("write your prompt to claude") ||
      normalized.includes("text entry area");

    // In OCU's text dump, current-token proof is only decision-grade when the
    // token is in Claude's assistant response block. Tokens in "You said" or
    // composer rows are prompt echoes, even if adjacent visible text looks rich.
    if (insideAssistantBlock && !promptEcho) {
      return true;
    }
  }

  return summary.includes(replyToken) ? false : null;
}

function extractReplyText(
  snapshot: GuiSnapshot,
  sentMessage: string,
  replyToken: string,
): string | undefined {
  const chromeText = new Set([
    "claude",
    "sidebar",
    "skip to content",
    "collapse sidebar",
    "search",
    "mode",
    "chat",
    "cowork",
    "code",
    "new chat",
    "projects",
    "artifacts",
    "customize",
    "recents",
    "view all",
    "primary pane",
    "message actions",
    "copy",
    "read aloud",
    "give positive feedback",
    "give negative feedback",
    "retry",
    "edit",
    "write your prompt to claude",
    "add files, connectors, and more",
    "settings",
    "use voice mode",
  ]);

  if (composerContains(snapshot, replyToken)) {
    return undefined;
  }

  if (claudeTextDumpAssistantHasToken(snapshot, replyToken) === false) {
    return undefined;
  }

  return visibleReplyTextCandidates(snapshot)
    .find((text) => {
      const normalized = normalizeVisibleText(text);
      const looksLikeBenchmarkPrompt =
        normalized.includes("jarvis gui benchmark x-to-claude") ||
        normalized.includes("jarvis gui benchmark safari-notes-claude") ||
        normalized.includes("when you respond, include the reply token");
      const contextWithoutToken = normalizeVisibleText(
        text.replace(new RegExp(replyToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " "),
      );
      const tokenOnlyOrInstructionLabel = /^(reply token|marker)\s*:?\s*$/i.test(
        contextWithoutToken,
      );

      return (
        normalized.length >= 20 &&
        !chromeText.has(normalized) &&
        !looksLikeBenchmarkPrompt &&
        !tokenOnlyOrInstructionLabel &&
        !normalized.includes("more options for") &&
        !normalized.includes("claude is ai and can make mistakes") &&
        textIncludesVisible(text, replyToken) &&
        !textIncludesVisible(text, sentMessage)
      );
    })
    ?.slice(0, 1000);
}

function isPlausibleReplyText(
  text: string | undefined,
  sentMessage: string,
  sentinel: string,
  replyToken: string,
): boolean {
  const normalized = normalizeVisibleText(text ?? "");
  if (normalized.length < 20) {
    return false;
  }
  if (!textIncludesVisible(text, replyToken)) {
    return false;
  }
  if (normalized === normalizeVisibleText(sentinel)) {
    return false;
  }
  if (textIncludesVisible(text, sentMessage)) {
    return false;
  }
  if (/^https?:\/\/\S+$/i.test(text?.trim() ?? "")) {
    return false;
  }
  return true;
}

function copyButtonsNewestFirst(
  snapshot: GuiSnapshot,
): Array<NonNullable<GuiSnapshot["elements"][number]>> {
  return snapshot.elements
    .filter((element) => {
      const text = normalizeVisibleText(
        [element.label, element.name, element.title, element.description].filter(Boolean).join(" "),
      );
      return element.role?.toLowerCase().includes("button") && text === "copy";
    })
    .toReversed();
}

async function extractReplyViaClipboard(
  runtime: GuiRuntime,
  snapshot: GuiSnapshot,
  sentMessage: string,
  replyToken: string,
): Promise<ReplyExtractionResult> {
  if (!runtime.readClipboard || !runtime.writeClipboard) {
    return { method: "none", actionCount: 0, usedClipboard: false };
  }
  const copyButtons = copyButtonsNewestFirst(snapshot);
  if (!copyButtons.length) {
    return { method: "none", actionCount: 0, usedClipboard: false };
  }

  let actionCount = 0;
  const originalClipboard = await runtime.readClipboard();
  const originalText = originalClipboard.text ?? "";
  const sentinel = `JARVIS_GUI_CONTROL_CLIPBOARD_SENTINEL_${Date.now()}`;
  try {
    for (const button of copyButtons) {
      const seeded = await runtime.writeClipboard(sentinel);
      actionCount += seeded.actionCount ?? 1;
      const clicked = await runtime.click(button);
      actionCount += clicked.actionCount ?? 1;
      await sleep(200);
      const copied = await runtime.readClipboard();
      if (copied.ok && isPlausibleReplyText(copied.text, sentMessage, sentinel, replyToken)) {
        return {
          replyText: copied.text,
          method: "clipboard-copy",
          actionCount,
          usedClipboard: true,
        };
      }
    }
    return { method: "none", actionCount, usedClipboard: true };
  } finally {
    const restored = await runtime.writeClipboard(originalText);
    void restored;
  }
}

async function extractReplyAfterSubmit(input: {
  runtime: GuiRuntime;
  target: AppTarget;
  initialSnapshot?: GuiSnapshot;
  sentMessage: string;
  replyToken: string;
  allowClipboardFallback: boolean;
  timeoutMs: number;
  intervalMs: number;
}): Promise<ReplyExtractionResult> {
  const deadline = Date.now() + Math.max(0, input.timeoutMs);
  let snapshot = input.initialSnapshot;
  let actionCount = 0;
  let usedClipboard = false;

  for (;;) {
    if (snapshot) {
      const replyText = extractReplyText(snapshot, input.sentMessage, input.replyToken);
      if (replyText) {
        return { replyText, method: "ax-visible-text", actionCount, usedClipboard };
      }

      if (input.allowClipboardFallback) {
        const clipboardReply = await extractReplyViaClipboard(
          input.runtime,
          snapshot,
          input.sentMessage,
          input.replyToken,
        );
        actionCount += clipboardReply.actionCount;
        usedClipboard ||= clipboardReply.usedClipboard;
        if (clipboardReply.replyText) {
          return {
            replyText: clipboardReply.replyText,
            method: clipboardReply.method,
            actionCount,
            usedClipboard,
          };
        }
      }
    }

    if (Date.now() >= deadline) {
      return { method: "none", actionCount, usedClipboard };
    }

    await sleep(Math.max(50, input.intervalMs));
    snapshot = await input.runtime.observe(input.target);
  }
}

function summarizeVisibleX(snapshot: GuiSnapshot): string {
  const summary = snapshot.summary?.trim();
  if (summary) {
    return summary;
  }
  const visible = visibleSnapshotText(snapshot)
    .filter((text) => !/^(true|false|\d+)$/.test(text.trim()))
    .slice(0, 18)
    .join(" | ");
  return visible || "Visible X Home content observed by GUI benchmark; no X mutation planned.";
}

function evaluateQualityGate(
  result: GuiBenchmarkResultWithWorkspace,
): GuiBenchmarkResult["qualityGate"] {
  const baselineElapsedSeconds = CODEX_COMPUTER_USE_BASELINE.elapsedSeconds;
  const baselineActionCount = CODEX_COMPUTER_USE_BASELINE.actionCount;
  const blockers: string[] = [];

  if (result.dryRun) {
    return {
      codexComputerUseParity: "not-measured",
      onParWithCodexComputerUse: null,
      baselineElapsedSeconds,
      baselineActionCount,
      blockers: ["Dry-run does not measure real desktop latency, focus, pointer, or reply UI."],
    };
  }

  if (!result.ok) {
    return {
      codexComputerUseParity: "fail",
      onParWithCodexComputerUse: false,
      baselineElapsedSeconds,
      baselineActionCount,
      blockers: [result.failureReason ?? "Benchmark task did not complete."],
    };
  }

  if (result.task === "workspace-restore") {
    const failedDiagnostics =
      result.restoreDiagnostics?.filter((diagnostic) => diagnostic.restoredFrontmost !== true) ??
      [];
    const blockers = failedDiagnostics.map(
      (diagnostic) =>
        `${diagnostic.name}: ${diagnostic.failureReason ?? "frontmost restore was not proven."}`,
    );
    return {
      codexComputerUseParity: blockers.length ? "functional-pass-with-debt" : "pass",
      onParWithCodexComputerUse: !blockers.length,
      baselineElapsedSeconds,
      baselineActionCount,
      blockers,
    };
  }

  // A functional pass is not automatically product parity. Codex Computer Use
  // is the reference because it completed the task quickly, visibly, without
  // clipboard recovery, and with less user-workspace disruption.
  if (result.elapsedSeconds > baselineElapsedSeconds * 2) {
    blockers.push(
      `Elapsed ${result.elapsedSeconds.toFixed(2)}s is more than 2x the ${baselineElapsedSeconds}s Codex Computer Use baseline.`,
    );
  }
  if (result.actionCount > baselineActionCount * 2) {
    blockers.push(
      `Action count ${result.actionCount} is more than 2x the ${baselineActionCount}-call Codex Computer Use baseline.`,
    );
  }
  if (result.directRuntimeEscape) {
    blockers.push("Benchmark needed a direct runtime escape outside the wrapper.");
  }
  if (result.usedClipboard || result.replyExtractionMethod === "clipboard-copy") {
    blockers.push(
      "Reply extraction required clipboard copy/restore; Codex Computer Use baseline did not.",
    );
  }
  if (result.falseSuccesses || result.falseFailures) {
    blockers.push(
      `Runtime truth diverged from UI truth (${result.falseSuccesses} false successes, ${result.falseFailures} false failures).`,
    );
  }
  if (result.stageManager.sameStageOrBackgroundSafe !== true) {
    blockers.push("Stage Manager/workspace preservation was not proven true.");
  }
  if (result.workspace.frontmostRestored !== true) {
    blockers.push("Frontmost app restoration was not proven true.");
  }
  if (result.virtualPointer.present !== true) {
    blockers.push(
      "No Codex-style virtual pointer or equivalent visible intent overlay was proven.",
    );
  }
  if (!result.replyTextExtracted || result.replyExtractionMethod === "none") {
    blockers.push("Claude reply text was not extracted from the verified run.");
  }

  return {
    codexComputerUseParity: blockers.length ? "functional-pass-with-debt" : "pass",
    onParWithCodexComputerUse: !blockers.length,
    baselineElapsedSeconds,
    baselineActionCount,
    blockers,
  };
}

function buildMarkdown(result: Omit<GuiBenchmarkResult, "markdownSummary">): string {
  return [
    `# GUI Benchmark: ${result.task}`,
    "",
    `- runtime: ${result.runtime}`,
    `- dry-run: ${result.dryRun ? "yes" : "no"}`,
    `- ok: ${result.ok ? "yes" : "no"}`,
    `- elapsed: ${result.elapsedSeconds.toFixed(2)}s`,
    `- action count: ${result.actionCount}`,
    `- retries: ${result.retries}`,
    `- stale refs: ${result.staleRefs}`,
    `- clipboard used: ${result.usedClipboard ? "yes" : "no"}`,
    `- focus moved: ${result.movedFocus ? "yes" : "no"}`,
    `- false successes: ${result.falseSuccesses}`,
    `- false failures: ${result.falseFailures}`,
    `- direct runtime escape: ${result.directRuntimeEscape ? "yes" : "no"}`,
    `- opened X Home: ${result.xWindow.openAttempted ? result.xWindow.openSucceeded : "no"}`,
    `- X window id: ${result.xWindow.selectedWindowId ?? "unknown"}`,
    `- X window title: ${result.xWindow.selectedWindowTitle ?? "unknown"}`,
    result.xWindow.failureReason ? `- X window failure: ${result.xWindow.failureReason}` : "",
    `- reply text extracted: ${result.replyTextExtracted ? "yes" : "no"}`,
    `- reply extraction method: ${result.replyExtractionMethod}`,
    `- Codex Computer Use parity: ${result.qualityGate.codexComputerUseParity}`,
    `- frontmost before: ${result.workspace.frontmostBefore ?? "unknown"}`,
    `- frontmost after task: ${result.workspace.frontmostAfterTask ?? "unknown"}`,
    `- frontmost after: ${result.workspace.frontmostAfter ?? "unknown"}`,
    `- workspace measurement: ${result.workspace.workspaceMeasurement}`,
    `- frontmost restored: ${result.workspace.frontmostRestored ?? "unknown"}`,
    `- workspace restore attempted: ${result.workspace.restoreAttempted ? "yes" : "no"}`,
    `- workspace restore succeeded: ${result.workspace.restoreSucceeded ?? "unknown"}`,
    `- workspace restore actions: ${result.workspace.restoreActionCount}`,
    result.workspace.restoreFailureReason
      ? `- workspace restore failure: ${result.workspace.restoreFailureReason}`
      : "",
    `- Stage Manager/background-safe: ${result.stageManager.sameStageOrBackgroundSafe ?? "unknown"}`,
    `- virtual pointer/intent: ${result.virtualPointer.present ?? "unknown"}`,
    result.qualityGate.blockers.length
      ? `- parity blockers: ${result.qualityGate.blockers.join(" | ")}`
      : "",
    result.restoreDiagnostics?.length
      ? `- restore diagnostics: ${result.restoreDiagnostics
          .map(
            (diagnostic) => `${diagnostic.name}=${diagnostic.restoredFrontmost ? "pass" : "fail"}`,
          )
          .join(", ")}`
      : "",
    result.failureReason ? `- failure: ${result.failureReason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function scoreStageManagerPreservation(
  stageManager: GuiBenchmarkResultBase["stageManager"],
  workspace: GuiBenchmarkResult["workspace"],
): GuiBenchmarkResultBase["stageManager"] {
  if (stageManager.sameStageOrBackgroundSafe !== null) {
    return stageManager;
  }
  if (workspace.workspaceMeasurement === "clean" && workspace.frontmostRestored === true) {
    // No-focus success is stronger than restore success: the user's workspace
    // never left the original frontmost app, so there is nothing to repair.
    return {
      sameStageOrBackgroundSafe: true,
      notes: "Frontmost app did not change during the measured task; no restore was needed.",
    };
  }
  if (workspace.workspaceMeasurement === "changed-by-runtime") {
    if (workspace.frontmostRestored === true && workspace.restoreSucceeded === true) {
      // Focus-moving runtimes can still preserve the user's workspace if they
      // prove the original frontmost app was restored after the task.
      return {
        sameStageOrBackgroundSafe: true,
        notes: "Frontmost app changed during the measured task and was restored after the task.",
      };
    }
    return {
      sameStageOrBackgroundSafe: false,
      notes:
        "Frontmost app changed during the measured task; restore result is reported separately.",
    };
  }
  return stageManager;
}

async function scoreVirtualPointerProof(
  virtualPointer: GuiBenchmarkResultBase["virtualPointer"],
  input: { runtime: GuiRuntime; dryRun: boolean },
): Promise<GuiBenchmarkResultBase["virtualPointer"]> {
  if (input.dryRun || !input.runtime.getVirtualPointerEvidence) {
    return virtualPointer;
  }

  const evidence: VirtualPointerEvidence = await input.runtime.getVirtualPointerEvidence();
  if (evidence.present) {
    return {
      present: true,
      notes: evidence.notes,
      ...(evidence.evidencePath ? { evidencePath: evidence.evidencePath } : {}),
    };
  }

  // Missing proof must fail closed. A successful GUI task is still only
  // functional-with-debt unless the report carries machine-readable pointer
  // evidence, because human sighting alone is not rerunnable proof.
  if (virtualPointer.present !== true) {
    return {
      present: false,
      notes: evidence.notes,
      ...(evidence.evidencePath ? { evidencePath: evidence.evidencePath } : {}),
    };
  }

  return virtualPointer;
}

async function finalizeBenchmarkResult(
  base: GuiBenchmarkResultBase,
  input: {
    runtime: GuiRuntime;
    workspaceBefore: Awaited<ReturnType<typeof captureWorkspace>>;
    options: Pick<GuiBenchmarkOptions, "writeReport" | "reportDir">;
  },
): Promise<GuiBenchmarkResult> {
  const afterTask = await captureWorkspace(input.runtime);
  const restore = await restoreWorkspace({
    runtime: input.runtime,
    workspaceBefore: input.workspaceBefore,
    dryRun: base.dryRun,
    allowRestore: base.movedFocus && workspaceChanged(input.workspaceBefore, afterTask),
  });
  const afterRestore = await captureWorkspace(input.runtime);
  const workspace = buildWorkspaceTelemetry({
    before: input.workspaceBefore,
    afterTask,
    restore,
    afterRestore,
    dryRun: base.dryRun,
    runtimeMovedFocus: base.movedFocus,
  });
  const virtualPointer = await scoreVirtualPointerProof(base.virtualPointer, {
    runtime: input.runtime,
    dryRun: base.dryRun,
  });
  const resultWithWorkspace: GuiBenchmarkResultWithWorkspace = {
    ...base,
    stageManager: scoreStageManagerPreservation(base.stageManager, workspace),
    virtualPointer,
    actionCount: base.actionCount + workspace.restoreActionCount,
    workspace,
  };
  const resultBase: GuiBenchmarkResultScored = {
    ...resultWithWorkspace,
    qualityGate: evaluateQualityGate(resultWithWorkspace),
  };
  const result: GuiBenchmarkResult = {
    ...resultBase,
    markdownSummary: buildMarkdown(resultBase),
  };
  result.reportPath = await maybeWriteReport(result, input.options);
  return result;
}

function visibleTextContaining(
  snapshot: GuiSnapshot | undefined,
  token: string,
): string | undefined {
  if (!snapshot) {
    return undefined;
  }
  return visibleSnapshotText(snapshot)
    .find((text) => textIncludesVisible(text, token))
    ?.slice(0, 2000);
}

async function maybeWriteReport(
  result: GuiBenchmarkResult,
  options: Pick<GuiBenchmarkOptions, "writeReport" | "reportDir">,
): Promise<string | undefined> {
  if (!options.writeReport) {
    return undefined;
  }
  const dir = options.reportDir ?? path.join(process.cwd(), "artifacts", "gui-benchmark");
  await fs.mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, `${result.task}-${Date.now()}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return reportPath;
}

async function runSafariNotesClaudeBenchmark(
  options: GuiBenchmarkOptions,
): Promise<GuiBenchmarkResult> {
  const started = Date.now();
  const progress = options.progress ?? (() => undefined);
  const audit: GuiAuditRecord[] = [];
  const runtime = options.runtimeImpl ?? createBenchmarkRuntime(options);
  const claudeTarget: AppTarget = { appName: "Claude" };
  const notesTarget: AppTarget = { appName: "Notes" };
  const notesPolicy = getGuiTaskPolicyProfile("notes_write");
  const assistantSendPolicy = getGuiTaskPolicyProfile("send_message_to_approved_assistant");
  const workspaceBefore = await captureWorkspace(runtime);

  const fail = async (input: {
    failureReason: string;
    stats: GuiVerifierStats;
    xWindow: GuiBenchmarkResult["xWindow"];
    stageNotes: string;
    virtualPointerPresent?: boolean | null;
  }) => {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const base = {
      ok: false,
      runtime: options.runtime,
      task: options.task,
      dryRun: Boolean(options.dryRun),
      elapsedSeconds,
      ...input.stats,
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: input.xWindow,
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: input.stageNotes,
      },
      virtualPointer: {
        present: input.virtualPointerPresent ?? false,
        notes: "No virtual pointer surfaced by v0 agent-desktop adapter.",
      },
      audit,
      failureReason: input.failureReason,
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  };

  if (options.openXHome) {
    progress("Opening X");
  }
  const safariPreparation = await prepareBenchmarkSafariTarget({
    runtime,
    openXHome: Boolean(options.openXHome),
    dryRun: Boolean(options.dryRun),
  });
  if (!safariPreparation.ok) {
    return fail({
      failureReason: safariPreparation.failureReason,
      stats: safariPreparation.stats,
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because the Safari/X window could not be selected exactly.",
    });
  }

  progress("Reading X");
  const xObservation = await observeBenchmarkSafariSnapshot({
    runtime,
    target: safariPreparation.target,
    allowSettleRetry: Boolean(options.openXHome),
    dryRun: Boolean(options.dryRun),
    stats: safariPreparation.stats,
  });
  if (!xObservation.ok) {
    return fail({
      failureReason: xObservation.failureReason,
      stats: safariPreparation.stats,
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because the Safari/X read target did not match.",
    });
  }

  const visibleSummary = summarizeVisibleX(xObservation.snapshot);
  const replyToken = `JARVIS_GUI_${Date.now()}_${uniqueBenchmarkToken()}`;
  const notesContent = [
    "Jarvis GUI benchmark safari-notes-claude",
    `Visible token: ${replyToken}`,
    "Safari/X visible summary:",
    visibleSummary,
  ].join("\n");

  if (!options.dryRun && !options.approveNotesWrite) {
    return fail({
      failureReason: "Live benchmark requires --approve-notes-write before writing Apple Notes.",
      stats: safariPreparation.stats,
      xWindow: safariPreparation.xWindow,
      stageNotes:
        "Live run stopped before mutation because Notes write was not explicitly approved.",
      virtualPointerPresent: null,
    });
  }

  let notesPreparationStats = emptyGuiVerifierStats();
  if (!options.dryRun) {
    progress("Creating Notes note");
    const notesPreparationSnapshot = await runtime.observe(notesTarget);
    const newNoteResolution = resolveNotesNewNoteButton(notesPreparationSnapshot);
    if (!newNoteResolution.ok) {
      return fail({
        failureReason: newNoteResolution.summary,
        stats: safariPreparation.stats,
        xWindow: safariPreparation.xWindow,
        stageNotes: "Not measured because Notes new-note resolution failed.",
      });
    }
    const newNoteClick = await runtime.click(newNoteResolution.element);
    notesPreparationStats = statsFromActionResult(newNoteClick);
    if (!newNoteClick.ok) {
      return fail({
        failureReason: newNoteClick.message ?? "Apple Notes new-note click failed.",
        stats: mergeStats([safariPreparation.stats, notesPreparationStats]),
        xWindow: safariPreparation.xWindow,
        stageNotes: "Not measured because Notes fresh-note preparation failed.",
      });
    }
    await sleep(1_000);
  }

  progress("Writing Notes");
  const notesWriteSnapshot = await runtime.observe(notesTarget);
  const notesResolution = resolveNotesBody(notesWriteSnapshot);
  if (!notesResolution.ok) {
    return fail({
      failureReason: notesResolution.summary,
      stats: mergeStats([safariPreparation.stats, notesPreparationStats]),
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because Notes body resolution failed.",
    });
  }

  const notesWrite = await performVerifiedAction({
    runtime,
    target: notesTarget,
    element: notesResolution.element,
    actionType: "setValue",
    value: notesContent,
    reason: "Write labelled GUI benchmark content into Apple Notes.",
    approvedPolicyRisk: Boolean(options.dryRun || options.approveNotesWrite),
    taskPolicy: notesPolicy,
    verificationTimeoutMs: options.dryRun ? 0 : 25_000,
    verificationIntervalMs: 1_000,
    verify: (snapshot) => {
      const visibleProof = visibleTextContaining(snapshot, replyToken);
      return {
        ok: Boolean(visibleProof),
        summary: visibleProof
          ? "Apple Notes visible AX text contains labelled benchmark token."
          : "Apple Notes token was not visible after write.",
      };
    },
  });
  audit.push(notesWrite.audit);
  if (!notesWrite.ok) {
    return fail({
      failureReason: notesWrite.failureReason ?? "Apple Notes write verification failed.",
      stats: mergeStats([safariPreparation.stats, notesPreparationStats, notesWrite.stats]),
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because benchmark stopped during Notes write verification.",
    });
  }

  const notesVisibleProof = visibleTextContaining(notesWrite.snapshot, replyToken);
  if (!notesVisibleProof) {
    return fail({
      failureReason: "Apple Notes token was not extracted from visible AX text after write.",
      stats: mergeStats([safariPreparation.stats, notesPreparationStats, notesWrite.stats]),
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because Notes visible-token proof was missing.",
    });
  }

  if (!options.dryRun && !options.approveClaudeSend) {
    return fail({
      failureReason: "Live benchmark requires --approve-claude-send before writing Claude.",
      stats: mergeStats([safariPreparation.stats, notesPreparationStats, notesWrite.stats]),
      xWindow: safariPreparation.xWindow,
      stageNotes:
        "Live run stopped before Claude mutation because Claude send was not explicitly approved.",
      virtualPointerPresent: null,
    });
  }

  const claudePreparation = await prepareBenchmarkClaudeTarget({
    runtime,
    openClaudeNew: Boolean(options.openClaudeNew),
    dryRun: Boolean(options.dryRun),
    progress,
  });
  if (!claudePreparation.ok) {
    return fail({
      failureReason: claudePreparation.failureReason,
      stats: mergeStats([
        safariPreparation.stats,
        notesPreparationStats,
        notesWrite.stats,
        claudePreparation.stats,
      ]),
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because Claude fresh-chat preparation failed.",
    });
  }

  progress("Writing Claude");
  const claudeMessage = [
    "Jarvis GUI benchmark safari-notes-claude",
    `Reply token: ${replyToken}`,
    "Summarize the Apple Notes content below in one concise paragraph.",
    "When you respond, include the reply token exactly once so Jarvis can verify this run.",
    "",
    "Apple Notes visible AX text:",
    notesVisibleProof,
  ].join("\n");
  const claudeWriteSnapshot = await runtime.observe(claudeTarget);
  const inputResolution = resolveClaudeComposer(claudeWriteSnapshot, options.claudeInputRef);
  if (!inputResolution.ok) {
    return fail({
      failureReason: inputResolution.summary,
      stats: mergeStats([
        safariPreparation.stats,
        notesPreparationStats,
        notesWrite.stats,
        claudePreparation.stats,
      ]),
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because Claude composer resolution failed.",
    });
  }

  const claudeWrite = await performVerifiedAction({
    runtime,
    target: claudeTarget,
    element: inputResolution.element,
    actionType: "setValue",
    value: claudeMessage,
    reason: "Write Notes summarization request into Claude.",
    approvedPolicyRisk: Boolean(options.dryRun || options.approveClaudeSend),
    taskPolicy: assistantSendPolicy,
    verificationTimeoutMs: options.dryRun ? 0 : 25_000,
    verificationIntervalMs: 1_000,
    verify: (snapshot) => {
      const found = composerContains(snapshot, replyToken);
      const visible = snapshotContainsText(snapshot, replyToken);
      return {
        ok: found || visible,
        summary:
          found || visible
            ? "Claude composer contains Notes summarization token."
            : "Claude message not visible after write.",
      };
    },
  });
  audit.push(claudeWrite.audit);
  if (!claudeWrite.ok) {
    return fail({
      failureReason: claudeWrite.failureReason ?? "Claude write verification failed.",
      stats: mergeStats([
        safariPreparation.stats,
        notesPreparationStats,
        notesWrite.stats,
        claudePreparation.stats,
        claudeWrite.stats,
      ]),
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because benchmark stopped during Claude write verification.",
    });
  }

  progress("Verifying the reply");
  const verifySubmit = (snapshot: GuiSnapshot) => {
    const replyText = extractReplyText(snapshot, claudeMessage, replyToken);
    return {
      ok: !composerContains(snapshot, replyToken) || Boolean(replyText),
      summary: replyText
        ? "Claude Notes summary text is visible after scoped submit."
        : "Claude composer cleared after scoped submit.",
    };
  };
  let submitPromise: ReturnType<typeof performVerifiedAction> | undefined;
  let failedSendResolution: Extract<ClaudeSubmitResolution, { ok: false }> | undefined;
  if (runtime.name === "open-computer-use") {
    const sendResolution = resolveClaudeSubmitControl(claudeWrite.snapshot ?? claudeWriteSnapshot);
    if (sendResolution.ok) {
      submitPromise = performVerifiedAction({
        runtime,
        target: claudeTarget,
        element: sendResolution.element,
        actionType: sendResolution.actionType,
        secondaryAction: sendResolution.secondaryAction,
        reason: "Submit the Notes summarization request via Claude's verified Send control.",
        approvedPolicyRisk: Boolean(options.dryRun || options.approveClaudeSend),
        taskPolicy: assistantSendPolicy,
        verify: verifySubmit,
      });
    } else {
      failedSendResolution = sendResolution;
    }
  } else {
    submitPromise = performVerifiedAction({
      runtime,
      target: claudeTarget,
      actionType: "press",
      keys: ["cmd+return"],
      reason: "Submit the Notes summarization request to Claude with a scoped key combo.",
      approvedPolicyRisk: Boolean(options.dryRun || options.approveClaudeSend),
      taskPolicy: assistantSendPolicy,
      verify: verifySubmit,
    });
  }

  if (failedSendResolution) {
    return fail({
      failureReason: failedSendResolution.summary,
      stats: mergeStats([
        safariPreparation.stats,
        notesPreparationStats,
        notesWrite.stats,
        claudePreparation.stats,
        claudeWrite.stats,
      ]),
      xWindow: safariPreparation.xWindow,
      stageNotes: "Not measured because benchmark stopped before Claude submit.",
    });
  }
  if (!submitPromise) {
    throw new Error("Claude submit path was not initialized.");
  }

  const verifiedSubmit = await submitPromise;
  audit.push(verifiedSubmit.audit);
  const stats = mergeStats([
    safariPreparation.stats,
    notesPreparationStats,
    notesWrite.stats,
    claudePreparation.stats,
    claudeWrite.stats,
    verifiedSubmit.stats,
  ]);
  let replyText: string | undefined;
  let replyExtractionMethod: GuiBenchmarkResult["replyExtractionMethod"] = "none";
  if (verifiedSubmit.ok) {
    const replyExtraction = await extractReplyAfterSubmit({
      runtime,
      target: claudeTarget,
      initialSnapshot: verifiedSubmit.snapshot,
      sentMessage: claudeMessage,
      replyToken,
      allowClipboardFallback: false,
      timeoutMs: options.replyExtractionTimeoutMs ?? (options.dryRun ? 0 : 60_000),
      intervalMs: options.replyExtractionIntervalMs ?? 2_000,
    });
    replyText = replyExtraction.replyText;
    replyExtractionMethod = replyExtraction.method;
    stats.actionCount += replyExtraction.actionCount;
    stats.usedClipboard ||= replyExtraction.usedClipboard;
  }

  const elapsedSeconds = (Date.now() - started) / 1000;
  const base = {
    ok: verifiedSubmit.ok && Boolean(replyText),
    runtime: options.runtime,
    task: options.task,
    dryRun: Boolean(options.dryRun),
    elapsedSeconds,
    ...stats,
    directRuntimeEscape: false,
    replyTextExtracted: Boolean(replyText),
    replyExtractionMethod,
    xWindow: safariPreparation.xWindow,
    stageManager: {
      sameStageOrBackgroundSafe: options.dryRun ? true : null,
      notes: options.dryRun
        ? "Dry-run simulates same-stage/background-safe behavior."
        : "Live Stage Manager preservation must be scored from user-visible proof.",
    },
    virtualPointer: {
      present: options.dryRun ? false : null,
      notes: "v0 agent-desktop adapter logs intent; native overlay remains a scored gap.",
    },
    audit,
    replyText,
    failureReason:
      verifiedSubmit.failureReason ??
      (replyText ? undefined : "Claude reply text was not extracted after submit."),
  };
  return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
}

async function runWorkspaceRestoreBenchmark(
  options: GuiBenchmarkOptions,
): Promise<GuiBenchmarkResult> {
  const started = Date.now();
  const progress = options.progress ?? (() => undefined);
  const runtime = options.runtimeImpl ?? createBenchmarkRuntime(options);
  const workspaceBefore = await captureWorkspace(runtime);

  if (options.dryRun) {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const diagnostics: GuiWorkspaceRestoreDiagnostic[] = ["Terminal", "Safari", "Notes"].map(
      (sourceApp) => ({
        name: `${sourceApp}->Claude->${sourceApp}`,
        sourceApp,
        destinationApp: "Claude",
        setupAttempted: false,
        setupSucceeded: null,
        taskFocusAttempted: false,
        taskFocusSucceeded: null,
        restoreAttempted: false,
        restoreSucceeded: null,
        restoredFrontmost: null,
        actionCount: 0,
        failureReason: "Dry-run does not move real macOS focus.",
      }),
    );
    const base = {
      ok: true,
      runtime: options.runtime,
      task: options.task,
      dryRun: true,
      elapsedSeconds,
      ...emptyGuiVerifierStats(),
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: {
        openAttempted: false,
        openSucceeded: null,
      },
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: "Dry-run does not measure real workspace restore.",
      },
      virtualPointer: {
        present: false,
        notes: "Dry-run does not measure OpenComputerUse pointer evidence.",
      },
      audit: [],
      restoreDiagnostics: diagnostics,
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  }

  const cases = ["Terminal", "Safari", "Notes"].map((sourceApp) => ({
    sourceApp,
    destinationApp: "Claude",
  }));
  const diagnostics: GuiWorkspaceRestoreDiagnostic[] = [];

  for (const diagnosticCase of cases) {
    progress(`Testing ${diagnosticCase.sourceApp} restore`);
    diagnostics.push(await runWorkspaceRestoreCase({ runtime, ...diagnosticCase }));
  }

  const elapsedSeconds = (Date.now() - started) / 1000;
  const actionCount = diagnostics.reduce((sum, diagnostic) => sum + diagnostic.actionCount, 0);
  const allRestored = diagnostics.every((diagnostic) => diagnostic.restoredFrontmost === true);
  const base = {
    ok: diagnostics.every(
      (diagnostic) =>
        diagnostic.setupSucceeded === true &&
        diagnostic.taskFocusSucceeded === true &&
        diagnostic.restoreSucceeded === true &&
        diagnostic.restoredFrontmost === true,
    ),
    runtime: options.runtime,
    task: options.task,
    dryRun: false,
    elapsedSeconds,
    ...emptyGuiVerifierStats(),
    actionCount,
    movedFocus: true,
    directRuntimeEscape: false,
    replyTextExtracted: false,
    replyExtractionMethod: "none" as const,
    xWindow: {
      openAttempted: false,
      openSucceeded: null,
    },
    stageManager: {
      sameStageOrBackgroundSafe: allRestored,
      notes: allRestored
        ? "Restore-only diagnostic returned each source app to frontmost."
        : "Restore-only diagnostic found at least one unrestored source app.",
    },
    virtualPointer: {
      present: null,
      notes: "OpenComputerUse pointer evidence is scored if the runtime reports it.",
    },
    audit: [],
    restoreDiagnostics: diagnostics,
    failureReason: allRestored
      ? undefined
      : diagnostics
          .filter((diagnostic) => diagnostic.restoredFrontmost !== true)
          .map((diagnostic) => `${diagnostic.name}: ${diagnostic.failureReason}`)
          .join(" | "),
  };
  return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
}

export async function runGuiBenchmark(options: GuiBenchmarkOptions): Promise<GuiBenchmarkResult> {
  const started = Date.now();
  const progress = options.progress ?? (() => undefined);
  const audit: GuiAuditRecord[] = [];

  if (options.task === "workspace-restore") {
    return runWorkspaceRestoreBenchmark(options);
  }

  if (options.task === "safari-notes-claude") {
    return runSafariNotesClaudeBenchmark(options);
  }

  if (options.task !== "x-to-claude") {
    throw new Error("Unsupported GUI benchmark task.");
  }

  const runtime = options.runtimeImpl ?? createBenchmarkRuntime(options);
  const claudeTarget: AppTarget = { appName: "Claude" };
  const assistantSendPolicy = getGuiTaskPolicyProfile("send_message_to_approved_assistant");
  const workspaceBefore = await captureWorkspace(runtime);

  if (options.openXHome) {
    progress("Opening X");
  }
  const safariPreparation = await prepareBenchmarkSafariTarget({
    runtime,
    openXHome: Boolean(options.openXHome),
    dryRun: Boolean(options.dryRun),
  });
  if (!safariPreparation.ok) {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const base = {
      ok: false,
      runtime: options.runtime,
      task: options.task,
      dryRun: Boolean(options.dryRun),
      elapsedSeconds,
      ...safariPreparation.stats,
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: safariPreparation.xWindow,
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: "Not measured because the Safari/X window could not be selected exactly.",
      },
      virtualPointer: {
        present: false,
        notes: "No virtual pointer surfaced by v0 agent-desktop adapter.",
      },
      audit,
      failureReason: safariPreparation.failureReason,
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  }
  progress("Reading X");
  const safariTarget = safariPreparation.target;
  const xObservation = await observeBenchmarkSafariSnapshot({
    runtime,
    target: safariTarget,
    allowSettleRetry: Boolean(options.openXHome),
    dryRun: Boolean(options.dryRun),
    stats: safariPreparation.stats,
  });
  if (!xObservation.ok) {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const base = {
      ok: false,
      runtime: options.runtime,
      task: options.task,
      dryRun: Boolean(options.dryRun),
      elapsedSeconds,
      ...safariPreparation.stats,
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: safariPreparation.xWindow,
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: "Not measured because the Safari/X read target did not match.",
      },
      virtualPointer: {
        present: false,
        notes: "No virtual pointer surfaced by v0 agent-desktop adapter.",
      },
      audit,
      failureReason: xObservation.failureReason,
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  }
  const xSnapshot = xObservation.snapshot;
  const visibleSummary = summarizeVisibleX(xSnapshot);
  const replyToken = `JARVIS_GUI_${Date.now()}_${uniqueBenchmarkToken()}`;
  const labelledMessage = [
    "Jarvis GUI benchmark x-to-claude",
    `Reply token: ${replyToken}`,
    "When you respond, include the reply token exactly once so Jarvis can verify this run.",
    "",
    "Visible X/Home summary:",
    visibleSummary,
  ].join("\n");

  if (!options.dryRun && !options.approveClaudeSend) {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const base = {
      ok: false,
      runtime: options.runtime,
      task: options.task,
      dryRun: Boolean(options.dryRun),
      elapsedSeconds,
      ...safariPreparation.stats,
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: safariPreparation.xWindow,
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: "Live run stopped before mutation because Claude send was not explicitly approved.",
      },
      virtualPointer: {
        present: null,
        notes: "agent-desktop does not provide a Codex-style pointer overlay in this v0 adapter.",
      },
      audit,
      failureReason: "Live benchmark requires --approve-claude-send before writing Claude.",
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  }

  const claudePreparation = await prepareBenchmarkClaudeTarget({
    runtime,
    openClaudeNew: Boolean(options.openClaudeNew),
    dryRun: Boolean(options.dryRun),
    progress,
  });
  if (!claudePreparation.ok) {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const base = {
      ok: false,
      runtime: options.runtime,
      task: options.task,
      dryRun: Boolean(options.dryRun),
      elapsedSeconds,
      ...mergeStats([safariPreparation.stats, claudePreparation.stats]),
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: safariPreparation.xWindow,
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: "Not measured because Claude fresh-chat preparation failed.",
      },
      virtualPointer: {
        present: false,
        notes: "No virtual pointer surfaced by v0 agent-desktop adapter.",
      },
      audit,
      failureReason: claudePreparation.failureReason,
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  }

  progress("Writing Claude");
  const claudeWriteSnapshot = await runtime.observe(claudeTarget);
  const inputResolution = resolveClaudeComposer(claudeWriteSnapshot, options.claudeInputRef);
  if (!inputResolution.ok) {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const base = {
      ok: false,
      runtime: options.runtime,
      task: options.task,
      dryRun: Boolean(options.dryRun),
      elapsedSeconds,
      ...mergeStats([safariPreparation.stats, claudePreparation.stats]),
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: safariPreparation.xWindow,
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: "Not measured because Claude composer resolution failed.",
      },
      virtualPointer: {
        present: false,
        notes: "No virtual pointer surfaced by v0 agent-desktop adapter.",
      },
      audit,
      failureReason: inputResolution.summary,
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  }
  const writeResult = await performVerifiedAction({
    runtime,
    target: claudeTarget,
    element: inputResolution.element,
    actionType: "setValue",
    value: labelledMessage,
    reason: "Write labelled GUI benchmark summary into Claude.",
    approvedPolicyRisk: Boolean(options.dryRun || options.approveClaudeSend),
    taskPolicy: assistantSendPolicy,
    verificationTimeoutMs: options.dryRun ? 0 : 25_000,
    verificationIntervalMs: 1_000,
    verify: (snapshot) => {
      const found = composerContains(snapshot, replyToken);
      const visible = snapshotContainsText(snapshot, replyToken);
      return {
        ok: found || visible,
        summary:
          found || visible
            ? "Claude composer contains labelled benchmark token."
            : "Claude message not visible after write.",
      };
    },
  });
  audit.push(writeResult.audit);
  if (!writeResult.ok) {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const base = {
      ok: false,
      runtime: options.runtime,
      task: options.task,
      dryRun: Boolean(options.dryRun),
      elapsedSeconds,
      ...mergeStats([safariPreparation.stats, claudePreparation.stats, writeResult.stats]),
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: safariPreparation.xWindow,
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: "Not measured because benchmark stopped during Claude write verification.",
      },
      virtualPointer: {
        present: false,
        notes: "No virtual pointer surfaced by v0 agent-desktop adapter.",
      },
      audit,
      failureReason: writeResult.failureReason,
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  }

  progress("Verifying the reply");
  const verifySubmit = (snapshot: GuiSnapshot) => {
    const replyText = extractReplyText(snapshot, labelledMessage, replyToken);
    return {
      ok: !composerContains(snapshot, replyToken) || Boolean(replyText),
      summary: replyText
        ? "Claude reply text is visible after scoped submit."
        : "Claude composer cleared after scoped submit.",
    };
  };
  let submitPromise: ReturnType<typeof performVerifiedAction> | undefined;
  let failedSendResolution: Extract<ClaudeSubmitResolution, { ok: false }> | undefined;
  if (runtime.name === "open-computer-use") {
    const sendResolution = resolveClaudeSubmitControl(writeResult.snapshot ?? claudeWriteSnapshot);
    if (sendResolution.ok) {
      submitPromise = performVerifiedAction({
        runtime,
        target: claudeTarget,
        element: sendResolution.element,
        actionType: sendResolution.actionType,
        secondaryAction: sendResolution.secondaryAction,
        reason: "Submit the already-labelled benchmark message via Claude's verified Send control.",
        approvedPolicyRisk: Boolean(options.dryRun || options.approveClaudeSend),
        taskPolicy: assistantSendPolicy,
        verify: verifySubmit,
      });
    } else {
      failedSendResolution = sendResolution;
    }
  } else {
    submitPromise = performVerifiedAction({
      runtime,
      target: claudeTarget,
      actionType: "press",
      keys: ["cmd+return"],
      reason: "Submit the already-labelled benchmark message to Claude with a scoped key combo.",
      approvedPolicyRisk: Boolean(options.dryRun || options.approveClaudeSend),
      taskPolicy: assistantSendPolicy,
      verify: verifySubmit,
    });
  }

  if (failedSendResolution) {
    const elapsedSeconds = (Date.now() - started) / 1000;
    const base = {
      ok: false,
      runtime: options.runtime,
      task: options.task,
      dryRun: Boolean(options.dryRun),
      elapsedSeconds,
      ...mergeStats([safariPreparation.stats, claudePreparation.stats, writeResult.stats]),
      directRuntimeEscape: false,
      replyTextExtracted: false,
      replyExtractionMethod: "none" as const,
      xWindow: safariPreparation.xWindow,
      stageManager: {
        sameStageOrBackgroundSafe: null,
        notes: "Not measured because benchmark stopped before Claude submit.",
      },
      virtualPointer: {
        present: false,
        notes: "No virtual pointer surfaced by v0 agent-desktop adapter.",
      },
      audit,
      failureReason: failedSendResolution.summary,
    };
    return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
  }
  if (!submitPromise) {
    throw new Error("Claude submit path was not initialized.");
  }

  const verifiedSubmit = await submitPromise;
  audit.push(verifiedSubmit.audit);

  const stats = mergeStats([
    safariPreparation.stats,
    claudePreparation.stats,
    writeResult.stats,
    verifiedSubmit.stats,
  ]);
  let replyText: string | undefined;
  let replyExtractionMethod: GuiBenchmarkResult["replyExtractionMethod"] = "none";
  if (verifiedSubmit.ok) {
    const replyExtraction = await extractReplyAfterSubmit({
      runtime,
      target: claudeTarget,
      initialSnapshot: verifiedSubmit.snapshot,
      sentMessage: labelledMessage,
      replyToken,
      allowClipboardFallback: options.allowClipboardFallback !== false,
      timeoutMs: options.replyExtractionTimeoutMs ?? (options.dryRun ? 0 : 60_000),
      intervalMs: options.replyExtractionIntervalMs ?? 2_000,
    });
    replyText = replyExtraction.replyText;
    replyExtractionMethod = replyExtraction.method;
    stats.actionCount += replyExtraction.actionCount;
    stats.usedClipboard ||= replyExtraction.usedClipboard;
  }
  const elapsedSeconds = (Date.now() - started) / 1000;
  const base = {
    ok: verifiedSubmit.ok && Boolean(replyText),
    runtime: options.runtime,
    task: options.task,
    dryRun: Boolean(options.dryRun),
    elapsedSeconds,
    ...stats,
    directRuntimeEscape: false,
    replyTextExtracted: Boolean(replyText),
    replyExtractionMethod,
    xWindow: safariPreparation.xWindow,
    stageManager: {
      sameStageOrBackgroundSafe: options.dryRun ? true : null,
      notes: options.dryRun
        ? "Dry-run simulates same-stage/background-safe behavior."
        : "Live Stage Manager preservation must be scored from user-visible proof.",
    },
    virtualPointer: {
      present: options.dryRun ? false : null,
      notes: "v0 agent-desktop adapter logs intent; native overlay remains a scored gap.",
    },
    audit,
    replyText,
    failureReason:
      verifiedSubmit.failureReason ??
      (replyText ? undefined : "Claude reply text was not extracted after submit."),
  };
  return finalizeBenchmarkResult(base, { runtime, workspaceBefore, options });
}
