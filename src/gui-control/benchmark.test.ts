import { describe, expect, it } from "vitest";
import { runGuiBenchmark } from "./benchmark.js";
import type { AppTarget, ElementRef, GuiRuntime, GuiSnapshot } from "./types.js";

function benchmarkSnapshot(params: Partial<GuiSnapshot>): GuiSnapshot {
  return {
    id: params.id ?? "snapshot",
    appName: params.appName ?? "Claude",
    windowTitle: params.windowTitle ?? params.appName ?? "Claude",
    summary: params.summary,
    visibleText: params.visibleText,
    elements: params.elements ?? [],
  };
}

function replyTokenFromMessage(message: string): string {
  return message.match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1] ?? "";
}

function createReplyExtractionRuntime(input: {
  afterSubmitSnapshot: (message: string, replyToken: string) => GuiSnapshot;
}): GuiRuntime {
  const messageValues: string[] = [];

  return {
    name: "agent-desktop",
    async listApps() {
      return [];
    },
    async observe(target: AppTarget) {
      if (target.appName === "Safari") {
        return benchmarkSnapshot({
          id: "safari",
          appName: "Safari",
          windowTitle: "Home / X",
          visibleText: ["Home / X", "For you", "Visible timeline item"],
        });
      }
      if (messageValues.length === 0) {
        return benchmarkSnapshot({
          id: "claude-input",
          appName: "Claude",
          elements: [
            {
              ref: "@input",
              role: "textfield",
              label: "Write your prompt to Claude",
              value: "Write a message…",
            },
          ],
        });
      }
      if (messageValues.length === 1) {
        return benchmarkSnapshot({
          id: "claude-written",
          appName: "Claude",
          elements: [
            {
              ref: "@input",
              role: "textfield",
              label: "Write your prompt to Claude",
              value: messageValues[0],
            },
          ],
        });
      }

      const sentMessage = messageValues[0] ?? "";
      return input.afterSubmitSnapshot(sentMessage, replyTokenFromMessage(sentMessage));
    },
    async setValue(_target: ElementRef, value: string) {
      messageValues.push(value);
      return { ok: true, actionCount: 1 };
    },
    async click() {
      return { ok: true };
    },
    async press() {
      messageValues.push("submitted");
      return { ok: true, actionCount: 1, movedFocus: true };
    },
  };
}

describe("runGuiBenchmark", () => {
  it("runs x-to-claude in dry-run mode without real GUI mutation", async () => {
    const progress: string[] = [];

    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: true,
      progress: (message) => progress.push(message),
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.actionCount).toBe(2);
    expect(result.usedClipboard).toBe(false);
    expect(result.directRuntimeEscape).toBe(false);
    expect(result.replyTextExtracted).toBe(true);
    expect(result.replyExtractionMethod).toBe("ax-visible-text");
    expect(result.workspace.frontmostRestored).toBeNull();
    expect(result.qualityGate.codexComputerUseParity).toBe("not-measured");
    expect(result.qualityGate.onParWithCodexComputerUse).toBeNull();
    expect(result.replyText).toContain("Claude dry-run reply");
    expect(result.audit).toHaveLength(2);
    expect(progress).toEqual(["Reading X", "Writing Claude", "Verifying the reply"]);
    expect(result.markdownSummary).toContain("GUI Benchmark: x-to-claude");
  });

  it("can prepare a fresh Claude chat before x-to-claude writes", async () => {
    const progress: string[] = [];

    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: true,
      openClaudeNew: true,
      progress: (message) => progress.push(message),
    });

    expect(result.ok).toBe(true);
    expect(result.actionCount).toBe(3);
    expect(result.movedFocus).toBe(true);
    expect(result.replyTextExtracted).toBe(true);
    expect(progress).toEqual([
      "Reading X",
      "Opening Claude",
      "Writing Claude",
      "Verifying the reply",
    ]);
  });

  it("runs safari-notes-claude in dry-run mode without real GUI mutation", async () => {
    const progress: string[] = [];

    const result = await runGuiBenchmark({
      runtime: "open-computer-use",
      task: "safari-notes-claude",
      dryRun: true,
      progress: (message) => progress.push(message),
    });

    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("open-computer-use");
    expect(result.task).toBe("safari-notes-claude");
    expect(result.dryRun).toBe(true);
    expect(result.actionCount).toBe(3);
    expect(result.usedClipboard).toBe(false);
    expect(result.movedFocus).toBe(false);
    expect(result.directRuntimeEscape).toBe(false);
    expect(result.replyTextExtracted).toBe(true);
    expect(result.replyExtractionMethod).toBe("ax-visible-text");
    expect(result.audit.map((record) => record.appName)).toEqual(["Notes", "Claude", "Claude"]);
    expect(result.audit.map((record) => record.actionType)).toEqual([
      "setValue",
      "setValue",
      "click",
    ]);
    expect(result.audit.every((record) => record.elementRef?.startsWith("@"))).toBe(true);
    expect(result.replyText).toContain("JARVIS_GUI_");
    expect(progress).toEqual([
      "Reading X",
      "Writing Notes",
      "Writing Claude",
      "Verifying the reply",
    ]);
    expect(result.markdownSummary).toContain("GUI Benchmark: safari-notes-claude");
  });

  it("runs safari-notes-claude with semantic Notes and Claude actions plus pointer proof", async () => {
    let notesValue = "";
    let claudeValue = "";
    let claudeReply = "";

    const result = await runGuiBenchmark({
      runtime: "open-computer-use",
      task: "safari-notes-claude",
      dryRun: false,
      approveNotesWrite: true,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "open-computer-use",
        async listApps() {
          return [
            { appName: "Terminal", frontmost: true },
            { appName: "Safari", frontmost: false },
            { appName: "Notes", frontmost: false },
            { appName: "Claude", frontmost: false },
          ];
        },
        async listWindows() {
          return [
            { id: "w-terminal", appName: "Terminal", title: "tmux", focused: true },
            { id: "w-x", appName: "Safari", title: "Home / X", focused: false },
          ];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowId: target.windowId,
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (target.appName === "Notes") {
            return benchmarkSnapshot({
              id: "notes",
              appName: "Notes",
              windowTitle: "Notes",
              summary: notesValue ? `Apple Notes visible text: ${notesValue}` : "Note body ready",
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
            });
          }
          return benchmarkSnapshot({
            id: "claude",
            appName: "Claude",
            windowTitle: "Claude",
            summary:
              claudeReply || (claudeValue ? `Composer contains ${claudeValue}` : "Composer ready"),
            visibleText: claudeReply ? [claudeReply] : undefined,
            elements: [
              {
                ref: "@claude-input",
                role: "textArea",
                label: "Write your prompt to Claude",
                value: claudeValue || "Write a message…",
                appName: "Claude",
                windowTitle: "Claude",
              },
              {
                ref: "@claude-send",
                role: "button",
                label: "Send",
                appName: "Claude",
                windowTitle: "Claude",
              },
            ],
          });
        },
        async setValue(target: ElementRef, value: string) {
          if (target.appName === "Notes") {
            notesValue = value;
          } else {
            claudeValue = value;
          }
          return { ok: true, actionCount: 1 };
        },
        async click(target: ElementRef) {
          expect(target.ref).toBe("@claude-send");
          const replyToken = replyTokenFromMessage(claudeValue);
          claudeReply = `Claude summarized the Apple Notes content and included ${replyToken}.`;
          claudeValue = "";
          return { ok: true, actionCount: 1 };
        },
        async getVirtualPointerEvidence() {
          return {
            present: true,
            source: "fixture",
            evidencePath: "/tmp/ocu-pointer-proof.json",
            notes: "Fixture pointer proof for semantic OCU action.",
          };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.usedClipboard).toBe(false);
    expect(result.movedFocus).toBe(false);
    expect(result.virtualPointer).toMatchObject({
      present: true,
      evidencePath: "/tmp/ocu-pointer-proof.json",
    });
    expect(result.workspace.workspaceMeasurement).toBe("clean");
    expect(result.stageManager.sameStageOrBackgroundSafe).toBe(true);
    expect(
      result.audit.map((record) => [record.appName, record.actionType, record.elementRef]),
    ).toEqual([
      ["Notes", "setValue", "@notes-body"],
      ["Claude", "setValue", "@claude-input"],
      ["Claude", "click", "@claude-send"],
    ]);
    expect(notesValue).toContain("Jarvis GUI benchmark safari-notes-claude");
    expect(notesValue).toContain("Visible token: JARVIS_GUI_");
    expect(claudeValue).toBe("");
    expect(result.replyText).toContain("JARVIS_GUI_");
  });

  it("fails safari-notes-claude before live Notes mutation unless explicitly approved", async () => {
    let notesWrites = 0;

    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "safari-notes-claude",
      dryRun: false,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          return benchmarkSnapshot({
            id: "notes",
            appName: "Notes",
            windowTitle: "Notes",
            elements: [{ ref: "@notes-body", role: "textArea", label: "Note body" }],
          });
        },
        async setValue() {
          notesWrites += 1;
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("--approve-notes-write");
    expect(result.actionCount).toBe(0);
    expect(result.audit).toHaveLength(0);
    expect(notesWrites).toBe(0);
  });

  it("fails closed before a live Claude send unless explicitly approved", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe() {
          return {
            id: "safari",
            appName: "Safari",
            windowTitle: "X / Home",
            summary: "visible X home",
            elements: [],
          };
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("--approve-claude-send");
    expect(result.actionCount).toBe(0);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.qualityGate.codexComputerUseParity).toBe("fail");
  });

  it("fails closed when the Safari read target is not the requested X window", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe() {
          return {
            id: "safari",
            appName: "Safari",
            windowTitle: "Audiomack",
            summary: "wrong Safari tab",
            elements: [],
          };
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("Wrong target");
    expect(result.failureReason).toContain("Audiomack");
    expect(result.actionCount).toBe(0);
    expect(result.qualityGate.codexComputerUseParity).toBe("fail");
  });

  it("uses an exact Safari Home / X window id when the runtime exposes windows", async () => {
    const observedTargets: AppTarget[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async listWindows() {
          return [
            { id: "w-x", appName: "Safari", title: "(1) Home / X", focused: false },
            {
              id: "w-private",
              appName: "Safari",
              title: "Private Browsing Locked",
              focused: false,
            },
          ];
        },
        async observe(target: AppTarget) {
          observedTargets.push(target);
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowId: target.windowId,
              windowTitle: "(1) Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          return benchmarkSnapshot({
            id: "claude-input",
            appName: "Claude",
            elements: [],
          });
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(observedTargets[0]).toMatchObject({
      appName: "Safari",
      windowId: "w-x",
      windowTitle: "(1) Home / X",
    });
    expect(result.failureReason).toContain("No text-input element matched");
  });

  it("accepts the literal X Home URL as the Safari benchmark window title", async () => {
    const observedTargets: AppTarget[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async listWindows() {
          return [{ id: "w-x", appName: "Safari", title: "https://x.com/home", focused: false }];
        },
        async observe(target: AppTarget) {
          observedTargets.push(target);
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowId: target.windowId,
              windowTitle: "https://x.com/home",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          return benchmarkSnapshot({
            id: "claude-input",
            appName: "Claude",
            elements: [],
          });
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(observedTargets[0]).toMatchObject({ appName: "Safari", windowId: "w-x" });
    expect(result.failureReason).toContain("No text-input element matched");
  });

  it("fails closed when no exact Safari Home / X window is available", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async listWindows() {
          return [{ id: "w-audio", appName: "Safari", title: "Audiomack", focused: false }];
        },
        async observe() {
          throw new Error("observe should not run without an exact X window");
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe(
      "No exact Safari Home / X window was found for the benchmark.",
    );
    expect(result.actionCount).toBe(0);
    expect(result.xWindow.openAttempted).toBe(false);
  });

  it("opens X Home when explicitly requested before resolving the exact Safari window", async () => {
    const observedTargets: AppTarget[] = [];
    let openedUrl = "";
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      openXHome: true,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async listWindows() {
          return openedUrl
            ? [{ id: "w-x", appName: "Safari", title: "Home / X", focused: false }]
            : [{ id: "w-terminal", appName: "Terminal", title: "tmux", focused: true }];
        },
        async openUrl(target: AppTarget, url: string) {
          expect(target.appName).toBe("Safari");
          openedUrl = url;
          return { ok: true, actionCount: 1, movedFocus: true };
        },
        async observe(target: AppTarget) {
          observedTargets.push(target);
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowId: target.windowId,
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          return benchmarkSnapshot({
            id: "claude-input",
            appName: "Claude",
            elements: [],
          });
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(openedUrl).toBe("https://x.com/home");
    expect(observedTargets[0]).toMatchObject({ appName: "Safari", windowId: "w-x" });
    expect(result.actionCount).toBe(1);
    expect(result.xWindow).toMatchObject({
      openAttempted: true,
      openSucceeded: true,
      selectedWindowId: "w-x",
      selectedWindowTitle: "Home / X",
    });
    expect(result.failureReason).toContain("No text-input element matched");
  });

  it("waits for the opened Safari X snapshot to settle before touching Claude", async () => {
    const observedTargets: AppTarget[] = [];
    let safariObserves = 0;
    const result = await runGuiBenchmark({
      runtime: "open-computer-use",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      openXHome: true,
      runtimeImpl: {
        name: "open-computer-use",
        async listApps() {
          return [];
        },
        async openUrl() {
          return { ok: true, actionCount: 1, movedFocus: true };
        },
        async observe(target: AppTarget) {
          observedTargets.push(target);
          if (target.appName === "Safari") {
            safariObserves += 1;
            return safariObserves === 1
              ? benchmarkSnapshot({
                  id: "safari-loading",
                  appName: "Safari",
                  windowId: "SafariWindow?IsSecure=false&UUID=fixture",
                  windowTitle: "Safari",
                  visibleText: ["Loading x.com"],
                })
              : benchmarkSnapshot({
                  id: "safari-ready",
                  appName: "Safari",
                  windowId: "SafariWindow?IsSecure=true&UUID=fixture",
                  windowTitle: "Home / X",
                  visibleText: ["Home / X", "For you", "Visible timeline item"],
                });
          }
          return benchmarkSnapshot({
            id: "claude-input-missing",
            appName: "Claude",
            elements: [],
          });
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(safariObserves).toBe(2);
    expect(result.retries).toBe(1);
    expect(observedTargets.at(-1)).toMatchObject({ appName: "Claude" });
    expect(result.failureReason).toContain("No text-input element matched");
  });

  it("lets open-computer-use prove opened X Home through observed Safari state", async () => {
    const observedTargets: AppTarget[] = [];
    let opened = false;
    const result = await runGuiBenchmark({
      runtime: "open-computer-use",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      openXHome: true,
      runtimeImpl: {
        name: "open-computer-use",
        async listApps() {
          return [
            { appName: opened ? "Safari" : "Terminal", frontmost: true },
            { appName: opened ? "Terminal" : "Safari", frontmost: false },
          ];
        },
        async listWindows() {
          return [
            { appName: opened ? "Safari" : "Terminal", focused: true },
            { appName: opened ? "Terminal" : "Safari", focused: false },
          ];
        },
        async openUrl() {
          opened = true;
          return { ok: true, actionCount: 1, movedFocus: true };
        },
        async observe(target: AppTarget) {
          observedTargets.push(target);
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari-ready",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          return benchmarkSnapshot({
            id: "claude-input-missing",
            appName: "Claude",
            elements: [],
          });
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(observedTargets[0]).toMatchObject({ appName: "Safari", windowTitle: "Home / X" });
    expect(result.xWindow).toMatchObject({
      openAttempted: true,
      openSucceeded: true,
      selectedWindowTitle: "Home / X",
    });
    expect(result.failureReason).toContain("No text-input element matched");
  });

  it("lets open-computer-use prove an existing X Home tab through observed Safari state", async () => {
    const observedTargets: AppTarget[] = [];
    const result = await runGuiBenchmark({
      runtime: "open-computer-use",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      runtimeImpl: {
        name: "open-computer-use",
        async listApps() {
          return [
            { appName: "Terminal", frontmost: true },
            { appName: "Safari", frontmost: false },
          ];
        },
        async listWindows() {
          return [
            { appName: "Terminal", focused: true },
            { appName: "Safari", focused: false },
          ];
        },
        async observe(target: AppTarget) {
          observedTargets.push(target);
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari-ready",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          return benchmarkSnapshot({
            id: "claude-input-missing",
            appName: "Claude",
            elements: [],
          });
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(observedTargets[0]).toMatchObject({ appName: "Safari", windowTitle: "Home / X" });
    expect(result.xWindow).toMatchObject({
      openAttempted: false,
      openSucceeded: null,
      selectedWindowTitle: "Home / X",
    });
    expect(result.failureReason).toContain("No text-input element matched");
  });

  it("fails closed when multiple Safari Home / X windows are available", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async listWindows() {
          return [
            { id: "w-1", appName: "Safari", title: "Home / X", focused: false },
            { id: "w-2", appName: "Safari", title: "(1) Home / X", focused: false },
          ];
        },
        async observe() {
          throw new Error("observe should not run with ambiguous X windows");
        },
        async setValue() {
          return { ok: true };
        },
        async click() {
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("Ambiguous Safari Home / X windows");
    expect(result.actionCount).toBe(0);
  });

  it("does not count Claude app chrome as extracted reply text", async () => {
    const messageValues: string[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              visibleText: ["Claude", "Write your prompt to Claude"],
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              visibleText: ["Claude", "Write your prompt to Claude"],
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: ["Claude", "Greeting - Claude", "Write your prompt to Claude"],
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: "Write a message…",
              },
            ],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.replyTextExtracted).toBe(false);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.replyText).toBeUndefined();
    expect(result.failureReason).toContain("reply text was not extracted");
    expect(result.qualityGate.codexComputerUseParity).toBe("fail");
  });

  it("does not count a truncated benchmark prompt echo as extracted reply text", async () => {
    const messageValues: string[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              [
                "text Jarvis GUI benchmark x-to-claude",
                `Reply token: ${replyToken}`,
                "When you respond, include the reply token exactly once",
                "Visible X/Home summary: App=com.apple.Safari Window: Home / X",
              ].join(" "),
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.replyTextExtracted).toBe(false);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.failureReason).toContain("reply text was not extracted");
  });

  it("does not count a split benchmark prompt echo token label as extracted reply text", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: createReplyExtractionRuntime({
        afterSubmitSnapshot(_message, replyToken) {
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              "text Jarvis GUI benchmark x-to-claude",
              `Reply token: ${replyToken}`,
              "When you respond, include the reply token exactly once",
              "Visible X/Home summary: App=com.apple.Safari Window: Home / X",
            ],
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: "Write a message…",
              },
            ],
          });
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.replyTextExtracted).toBe(false);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.failureReason).toContain("reply text was not extracted");
  });

  it("extracts assistant-visible reply text with the current token without keyword coupling", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: createReplyExtractionRuntime({
        afterSubmitSnapshot(_message, replyToken) {
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Done. I inspected the visible page and here is the marker: ${replyToken}`,
            ],
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: "Write a message…",
              },
            ],
          });
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.replyTextExtracted).toBe(true);
    expect(result.replyExtractionMethod).toBe("ax-visible-text");
    expect(result.replyText).toContain("I inspected the visible page");
  });

  it("does not count a previous-run assistant reply with an old token", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: createReplyExtractionRuntime({
        afterSubmitSnapshot() {
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              "Previous assistant reply completed with token JARVIS_GUI_OLD_RUN_TOKEN.",
            ],
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: "Write a message…",
              },
            ],
          });
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.replyTextExtracted).toBe(false);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.failureReason).toContain("reply text was not extracted");
  });

  it("extracts the current assistant reply when AX splits it across adjacent text nodes", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: createReplyExtractionRuntime({
        afterSubmitSnapshot(_message, replyToken) {
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              "Claude",
              "Done.",
              "I inspected the visible page.",
              `Marker: ${replyToken}`,
              "Write your prompt to Claude",
            ],
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: "Write a message…",
              },
            ],
          });
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.replyTextExtracted).toBe(true);
    expect(result.replyExtractionMethod).toBe("ax-visible-text");
    expect(result.replyText).toContain("I inspected the visible page");
  });

  it("verifies Claude writes when the composer text is exposed as visible text", async () => {
    const messageValues: string[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              visibleText: ["Claude", "Write your prompt to Claude"],
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              visibleText: [messageValues[0]],
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.audit[0]?.postStateVerification).toBe(
      "Claude composer contains labelled benchmark token.",
    );
    expect(result.replyExtractionMethod).toBe("ax-visible-text");
  });

  it("verifies Claude writes when only the per-run token is exposed after text flattening", async () => {
    const messageValues: string[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              visibleText: ["Claude", "Write your prompt to Claude"],
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              visibleText: [`Flattened Claude composer only exposes ${replyToken}`],
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: `Jarvis GUI benchmark x-to-claude ${replyToken}`,
                },
              ],
            });
          }
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.audit[0]?.postStateVerification).toBe(
      "Claude composer contains labelled benchmark token.",
    );
    expect(result.replyExtractionMethod).toBe("ax-visible-text");
  });

  it("resolves a filled Claude composer by stable AX label instead of only placeholder text", async () => {
    const messageValues: string[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-filled-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  description: "Write your prompt to Claude",
                  value: "Previous unsent text without the placeholder",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  description: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(messageValues[0]).toContain("Jarvis GUI benchmark x-to-claude");
  });

  it("does not treat a no-op submit as verified while the reply token remains in composer", async () => {
    const messageValues: string[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          return benchmarkSnapshot({
            id: "claude-still-composing",
            appName: "Claude",
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: `Flattened composer still has ${replyToken}`,
              },
            ],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.falseSuccesses).toBe(1);
    expect(result.audit[1]?.postStateVerification).toBe(
      "Claude composer cleared after scoped submit.",
    );
  });

  it("submits open-computer-use via semantic Send click without pressing Return", async () => {
    const messageValues: string[] = [];
    let clickedRef = "";
    let submitted = false;
    const result = await runGuiBenchmark({
      runtime: "open-computer-use",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "open-computer-use",
        async listApps() {
          return [
            { appName: "Terminal", frontmost: true },
            { appName: "Claude", frontmost: false },
          ];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (submitted) {
            const replyToken =
              messageValues[0]?.match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1] ?? "";
            return benchmarkSnapshot({
              id: "claude-after-click",
              appName: "Claude",
              visibleText: [
                `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
              ],
              elements: [],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          return benchmarkSnapshot({
            id: "claude-written",
            appName: "Claude",
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: messageValues[0],
              },
              { ref: "@send", role: "button", label: "Send" },
            ],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1, movedFocus: false };
        },
        async click(target: ElementRef) {
          clickedRef = target.ref;
          submitted = true;
          return { ok: true, actionCount: 1, movedFocus: false };
        },
        async press() {
          throw new Error("OCU no-focus path must not use press_key.");
        },
        async getVirtualPointerEvidence() {
          return {
            present: true,
            source: "open-computer-use-visual-cursor-observation-file",
            evidencePath: "/tmp/ocu-visual-cursor.json",
            phase: "idle",
            notes:
              'OpenComputerUse visual cursor observation recorded phase "idle" with machine-readable cursor geometry.',
          };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(clickedRef).toBe("@send");
    expect(result.audit[1]?.actionType).toBe("click");
    expect(result.movedFocus).toBe(false);
    expect(result.usedClipboard).toBe(false);
    expect(result.replyExtractionMethod).toBe("ax-visible-text");
    expect(result.workspace.frontmostBefore).toBe("Terminal");
    expect(result.workspace.frontmostAfterTask).toBe("Terminal");
    expect(result.workspace.frontmostRestored).toBe(true);
    expect(result.stageManager.sameStageOrBackgroundSafe).toBe(true);
    expect(result.virtualPointer.present).toBe(true);
    expect(result.virtualPointer.evidencePath).toBe("/tmp/ocu-visual-cursor.json");
    expect(result.qualityGate.codexComputerUseParity).toBe("pass");
    expect(result.qualityGate.onParWithCodexComputerUse).toBe(true);
    expect(result.qualityGate.blockers).toEqual([]);
    expect(result.qualityGate.blockers).not.toContain(
      "Stage Manager/workspace preservation was not proven true.",
    );
    expect(result.qualityGate.blockers).not.toContain(
      "Frontmost app restoration was not proven true.",
    );
  });

  it("keeps OCU as functional debt when virtual pointer proof is missing", async () => {
    const messageValues: string[] = [];
    let submitted = false;
    const result = await runGuiBenchmark({
      runtime: "open-computer-use",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "open-computer-use",
        async listApps() {
          return [
            { appName: "Terminal", frontmost: true },
            { appName: "Claude", frontmost: false },
          ];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (submitted) {
            const replyToken = replyTokenFromMessage(messageValues[0] ?? "");
            return benchmarkSnapshot({
              id: "claude-after-click",
              appName: "Claude",
              visibleText: [
                `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
              ],
              elements: [],
            });
          }
          return benchmarkSnapshot({
            id: messageValues.length ? "claude-written" : "claude-input",
            appName: "Claude",
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: messageValues[0] ?? "Write a message…",
              },
              ...(messageValues.length ? [{ ref: "@send", role: "button", label: "Send" }] : []),
            ],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1, movedFocus: false };
        },
        async click() {
          submitted = true;
          return { ok: true, actionCount: 1, movedFocus: false };
        },
        async getVirtualPointerEvidence() {
          return {
            present: false,
            source: "open-computer-use-visual-cursor-observation-file",
            evidencePath: "/tmp/missing-ocu-visual-cursor.json",
            notes: "OpenComputerUse visual cursor observation file was not readable: ENOENT.",
          };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.virtualPointer.present).toBe(false);
    expect(result.qualityGate.codexComputerUseParity).toBe("functional-pass-with-debt");
    expect(result.qualityGate.onParWithCodexComputerUse).toBe(false);
    expect(result.qualityGate.blockers).toContain(
      "No Codex-style virtual pointer or equivalent visible intent overlay was proven.",
    );
  });

  it("fails closed for open-computer-use when no semantic Send target exists", async () => {
    const messageValues: string[] = [];
    const result = await runGuiBenchmark({
      runtime: "open-computer-use",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "open-computer-use",
        async listApps() {
          return [{ appName: "Terminal", frontmost: true }];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          return benchmarkSnapshot({
            id: messageValues.length ? "claude-written-no-send" : "claude-input",
            appName: "Claude",
            elements: [
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: messageValues[0] ?? "Write a message…",
              },
            ],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1, movedFocus: false };
        },
        async click() {
          throw new Error("OCU no-focus path must not click without a Send target.");
        },
        async press() {
          throw new Error("OCU no-focus path must not fall back to press_key.");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.actionCount).toBe(1);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.failureReason).toBe(
      "No semantic Claude Send control was present after writing the benchmark message.",
    );
    expect(result.audit).toHaveLength(1);
  });

  it("does not treat an OCU AX description composer echo as a Claude reply", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: createReplyExtractionRuntime({
        afterSubmitSnapshot(message, replyToken) {
          return benchmarkSnapshot({
            id: "claude-after-noop-press",
            appName: "Claude",
            visibleText: [
              "text )",
              "76 text |",
              "77 pop up button More",
              `105 button Reload this page text 2:42 PM container ${replyToken} Snap`,
            ],
            elements: [
              {
                ref: "@350",
                role: "text entry area (settable, string)",
                label: "text entry area (settable, string)",
                description: `Write your prompt to Claude ${message}`,
              },
            ],
          });
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.replyTextExtracted).toBe(false);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.audit[1]?.postStateVerification).toBe(
      "Claude composer cleared after scoped submit.",
    );
  });

  it("does not treat an OCU You-said prompt token as a Claude reply", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: createReplyExtractionRuntime({
        afterSubmitSnapshot(message, replyToken) {
          return benchmarkSnapshot({
            id: "claude-after-sent-prompt-only",
            appName: "Claude",
            summary: [
              'Window: "Claude", App: Claude.',
              `129 heading You said: Jarvis GUI benchmark x-to-claude Reply token: ${replyToken.replaceAll(
                "_",
                "",
              )} When you respond, include the reply token exactly once so Jarvis can verify this run.`,
              `134 text ${message}`,
              "186 container Message actions",
            ].join("\n"),
            visibleText: [
              "text ) 76 button Grok actions",
              "77 pop up button More",
              "78 text visible X post body",
              `110 button Reload this page text 3:09 PM text ${replyToken}`,
            ],
            elements: [
              {
                ref: "@451",
                role: "text entry area (settable, string)",
                label: "text entry area (settable, string)",
                description: "Write your prompt to Claude Write a message…",
              },
            ],
          });
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.replyTextExtracted).toBe(false);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.failureReason).toContain("reply text was not extracted");
  });

  it("extracts an OCU Claude responded block with the current token", async () => {
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: createReplyExtractionRuntime({
        afterSubmitSnapshot(_message, replyToken) {
          return benchmarkSnapshot({
            id: "claude-after-assistant-reply",
            appName: "Claude",
            summary: [
              'Window: "Claude", App: Claude.',
              `411 heading Claude responded: ${replyToken.replaceAll("_", "")} Value: 2`,
              `414 text ${replyToken}`,
              "415 text I read the visible X Home state and verified the benchmark token.",
              "441 container Message actions",
            ].join("\n"),
            visibleText: [
              "Claude responded:",
              replyToken,
              "I read the visible X Home state and verified the benchmark token.",
            ],
            elements: [
              {
                ref: "@451",
                role: "text entry area (settable, string)",
                label: "text entry area (settable, string)",
                description: "Write your prompt to Claude Write a message…",
              },
            ],
          });
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.replyTextExtracted).toBe(true);
    expect(result.replyExtractionMethod).toBe("ax-visible-text");
    expect(result.replyText).toContain("verified the benchmark token");
  });

  it("extracts Claude reply through copy fallback and restores clipboard", async () => {
    const messageValues: string[] = [];
    let clipboard = "original clipboard";
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              visibleText: ["Claude", "Write your prompt to Claude"],
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              visibleText: ["Claude", "Write your prompt to Claude"],
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: ["Claude", "Greeting - Claude", "Write your prompt to Claude"],
            elements: [
              { ref: "@copy", role: "button", label: "Copy" },
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: "Write a message…",
              },
            ],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click(target: ElementRef) {
          if (target.ref === "@copy") {
            const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
            clipboard = `Claude reply summary: I can see the X Home timeline context. ${replyToken}`;
          }
          return { ok: true, actionCount: 1 };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
        async readClipboard() {
          return { ok: true, text: clipboard };
        },
        async writeClipboard(text: string) {
          clipboard = text;
          return { ok: true, actionCount: 1, usedClipboard: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.replyTextExtracted).toBe(true);
    expect(result.replyExtractionMethod).toBe("clipboard-copy");
    expect(result.replyText).toContain("X Home timeline");
    expect(result.usedClipboard).toBe(true);
    expect(result.qualityGate.codexComputerUseParity).toBe("functional-pass-with-debt");
    expect(result.qualityGate.blockers).toContain(
      "Reply extraction required clipboard copy/restore; Codex Computer Use baseline did not.",
    );
    expect(clipboard).toBe("original clipboard");
  });

  it("does not touch clipboard fallback when it is disabled", async () => {
    const messageValues: string[] = [];
    let clipboardTouched = false;
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      allowClipboardFallback: false,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: ["Claude", "Greeting - Claude", "Write your prompt to Claude"],
            elements: [
              { ref: "@copy", role: "button", label: "Copy" },
              {
                ref: "@input",
                role: "textfield",
                label: "Write your prompt to Claude",
                value: "Write a message…",
              },
            ],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true, actionCount: 1 };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
        async readClipboard() {
          clipboardTouched = true;
          return { ok: true, text: "clipboard reply" };
        },
        async writeClipboard() {
          clipboardTouched = true;
          return { ok: true, actionCount: 1, usedClipboard: true };
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.replyTextExtracted).toBe(false);
    expect(result.replyExtractionMethod).toBe("none");
    expect(result.usedClipboard).toBe(false);
    expect(clipboardTouched).toBe(false);
    expect(result.failureReason).toContain("reply text was not extracted");
  });

  it("records restored frontmost app telemetry when the wrapper gives focus back", async () => {
    const messageValues: string[] = [];
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [
            { appName: "Terminal", frontmost: true },
            { appName: "Safari", frontmost: false },
            { appName: "Claude", frontmost: false },
          ];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.workspace.frontmostBefore).toBe("Terminal");
    expect(result.workspace.frontmostAfter).toBe("Terminal");
    expect(result.workspace.frontmostRestored).toBe(true);
    expect(result.qualityGate.blockers).not.toContain(
      "Frontmost app restoration was not proven true.",
    );
  });

  it("records workspace debt when the wrapper leaves a different app frontmost", async () => {
    const messageValues: string[] = [];
    let listAppsCalls = 0;
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          listAppsCalls += 1;
          return [
            { appName: listAppsCalls === 1 ? "Terminal" : "Claude", frontmost: true },
            { appName: "Safari", frontmost: false },
          ];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.workspace.frontmostBefore).toBe("Terminal");
    expect(result.workspace.frontmostAfter).toBe("Claude");
    expect(result.workspace.frontmostRestored).toBe(false);
    expect(result.qualityGate.codexComputerUseParity).toBe("functional-pass-with-debt");
    expect(result.qualityGate.blockers).toContain("Frontmost app restoration was not proven true.");
  });

  it("marks workspace measurement inconclusive when user interference is suspected", async () => {
    const messageValues: string[] = [];
    let listAppsCalls = 0;
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          listAppsCalls += 1;
          return [
            { appName: listAppsCalls === 1 ? "Terminal" : "Claude", frontmost: true },
            { appName: "Safari", frontmost: false },
          ];
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: false };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.workspace.workspaceMeasurement).toBe("user-interference-suspected");
    expect(result.workspace.restoreAttempted).toBe(false);
    expect(result.workspace.notes).toContain("user activity may have contaminated");
  });

  it("restores the originally focused window when the runtime supports it", async () => {
    const messageValues: string[] = [];
    let focusedApp = "Terminal";
    let restoreCalls = 0;
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async listWindows() {
          return [
            {
              id: "w-x",
              appName: "Safari",
              title: "Home / X",
              focused: false,
            },
            {
              id: "w-terminal",
              appName: "Terminal",
              title: "tmux",
              focused: focusedApp === "Terminal",
            },
            {
              id: "w-claude",
              appName: "Claude",
              title: "Claude",
              focused: focusedApp === "Claude",
            },
          ];
        },
        async focusWindow(target) {
          restoreCalls += 1;
          focusedApp = target.appName;
          return { ok: true, actionCount: 1, movedFocus: true };
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          focusedApp = "Claude";
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(restoreCalls).toBe(1);
    expect(result.actionCount).toBe(3);
    expect(result.workspace.focusedWindowBefore).toEqual({
      appName: "Terminal",
      id: "w-terminal",
      title: "tmux",
    });
    expect(result.workspace.frontmostAfter).toBe("Terminal");
    expect(result.workspace.restoreAttempted).toBe(true);
    expect(result.workspace.restoreSucceeded).toBe(true);
    expect(result.workspace.frontmostRestored).toBe(true);
  });

  it("keeps workspace debt when focused-window restoration fails", async () => {
    const messageValues: string[] = [];
    let focusedApp = "Terminal";
    const result = await runGuiBenchmark({
      runtime: "agent-desktop",
      task: "x-to-claude",
      dryRun: false,
      approveClaudeSend: true,
      replyExtractionTimeoutMs: 0,
      runtimeImpl: {
        name: "agent-desktop",
        async listApps() {
          return [];
        },
        async listWindows() {
          return [
            {
              id: "w-x",
              appName: "Safari",
              title: "Home / X",
              focused: false,
            },
            {
              id: "w-terminal",
              appName: "Terminal",
              title: "tmux",
              focused: focusedApp === "Terminal",
            },
            {
              id: "w-claude",
              appName: "Claude",
              title: "Claude",
              focused: focusedApp === "Claude",
            },
          ];
        },
        async focusWindow() {
          return { ok: false, actionCount: 1, movedFocus: true, message: "focus failed" };
        },
        async observe(target: AppTarget) {
          if (target.appName === "Safari") {
            return benchmarkSnapshot({
              id: "safari",
              appName: "Safari",
              windowTitle: "Home / X",
              visibleText: ["Home / X", "For you", "Visible timeline item"],
            });
          }
          if (messageValues.length === 0) {
            return benchmarkSnapshot({
              id: "claude-input",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: "Write a message…",
                },
              ],
            });
          }
          if (messageValues.length === 1) {
            return benchmarkSnapshot({
              id: "claude-written",
              appName: "Claude",
              elements: [
                {
                  ref: "@input",
                  role: "textfield",
                  label: "Write your prompt to Claude",
                  value: messageValues[0],
                },
              ],
            });
          }
          const replyToken = messageValues[0].match(/Reply token: (JARVIS_GUI_[A-Z0-9_]+)/)?.[1];
          return benchmarkSnapshot({
            id: "claude-after-press",
            appName: "Claude",
            visibleText: [
              `Claude reply summary acknowledged visible X Home timeline context. ${replyToken}`,
            ],
            elements: [],
          });
        },
        async setValue(_target: ElementRef, value: string) {
          messageValues.push(value);
          return { ok: true, actionCount: 1 };
        },
        async click() {
          return { ok: true };
        },
        async press() {
          focusedApp = "Claude";
          messageValues.push("submitted");
          return { ok: true, actionCount: 1, movedFocus: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.workspace.frontmostAfter).toBe("Claude");
    expect(result.workspace.restoreAttempted).toBe(true);
    expect(result.workspace.restoreSucceeded).toBe(false);
    expect(result.workspace.restoreFailureReason).toBe("focus failed");
    expect(result.workspace.frontmostRestored).toBe(false);
    expect(result.qualityGate.blockers).toContain("Frontmost app restoration was not proven true.");
  });
});
