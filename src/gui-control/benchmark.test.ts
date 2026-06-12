import { describe, expect, it } from "vitest";
import { runGuiBenchmark } from "./benchmark.js";
import type { AppTarget, ElementRef, GuiSnapshot } from "./types.js";

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
