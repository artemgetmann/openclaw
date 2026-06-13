import { describe, expect, it } from "vitest";
import { getGuiTaskPolicyProfile } from "./policy.js";
import type {
  ActionResult,
  AppState,
  AppTarget,
  ElementRef,
  GuiRuntime,
  GuiSnapshot,
} from "./types.js";
import { performVerifiedAction } from "./verifier.js";

const localFixturePolicy = getGuiTaskPolicyProfile("local_fixture_write");
const assistantSendPolicy = getGuiTaskPolicyProfile("send_message_to_approved_assistant");

class MockGuiRuntime implements GuiRuntime {
  readonly name = "agent-desktop" as const;
  observations: GuiSnapshot[];
  actions: ActionResult[];

  constructor(params: { observations: GuiSnapshot[]; actions: ActionResult[] }) {
    this.observations = [...params.observations];
    this.actions = [...params.actions];
  }

  async listApps(): Promise<AppState[]> {
    return [];
  }

  async observe(_target: AppTarget): Promise<GuiSnapshot> {
    const snapshot = this.observations.shift();
    if (!snapshot) {
      throw new Error("No mock observation queued.");
    }
    return snapshot;
  }

  async setValue(_target: ElementRef, _value: string): Promise<ActionResult> {
    return this.actions.shift() ?? { ok: true };
  }

  async click(_target: ElementRef): Promise<ActionResult> {
    return this.actions.shift() ?? { ok: true };
  }

  async press(_target: AppTarget, _keys: string[]): Promise<ActionResult> {
    return this.actions.shift() ?? { ok: true };
  }

  async scroll(_target: ElementRef): Promise<ActionResult> {
    return this.actions.shift() ?? { ok: true };
  }
}

function snapshot(params: Partial<GuiSnapshot> = {}): GuiSnapshot {
  return {
    id: params.id ?? "s1",
    appName: params.appName ?? "Claude",
    windowTitle: params.windowTitle ?? "Claude",
    summary: params.summary ?? "Claude composer",
    visibleText: params.visibleText,
    elements: params.elements ?? [{ ref: "@input", role: "textArea", value: "" }],
  };
}

describe("performVerifiedAction", () => {
  it("re-observes and retries once when the runtime reports a stale ref", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({ id: "pre", elements: [{ ref: "@input", value: "" }] }),
        snapshot({ id: "refresh", elements: [{ ref: "@input", value: "" }] }),
        snapshot({ id: "post", elements: [{ ref: "@input", value: "hello" }] }),
      ],
      actions: [{ ok: false, staleRef: true }, { ok: true }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@input" },
      actionType: "setValue",
      value: "hello",
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
      verify: (post) => ({
        ok: post.elements.some((element) => element.value === "hello"),
        summary: "post-state contains expected value",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.stats.staleRefs).toBe(1);
    expect(result.stats.retries).toBe(1);
    expect(result.stats.actionCount).toBe(2);
  });

  it("treats executor success as advisory and fails when post-state verification fails", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({ id: "pre", elements: [{ ref: "@input", value: "" }] }),
        snapshot({ id: "post", elements: [{ ref: "@input", value: "" }] }),
      ],
      actions: [{ ok: true }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@input" },
      actionType: "setValue",
      value: "hello",
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
      verify: () => ({ ok: false, summary: "expected value missing" }),
    });

    expect(result.ok).toBe(false);
    expect(result.stats.falseSuccesses).toBe(1);
    expect(result.audit.result).toBe("failed");
    expect(result.audit.postStateVerification).toBe("expected value missing");
  });

  it("treats executor failure as advisory and verifies set-value when post-state contains the value", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({ id: "pre", elements: [{ ref: "@input", value: "" }] }),
        snapshot({ id: "post", elements: [{ ref: "@input", value: "hello" }] }),
      ],
      actions: [{ ok: false, message: "executor reported failure" }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@input" },
      actionType: "setValue",
      value: "hello",
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
      verify: (post) => ({
        ok: post.elements.some((element) => element.value === "hello"),
        summary: "post-state contains expected value",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.stats.falseFailures).toBe(1);
    expect(result.audit.result).toBe("verified");
  });

  it("does not block Claude writes because existing composer text mentions profile", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({
          id: "pre",
          visibleText: ["Claude", "Profile", "Write your prompt to Claude"],
          elements: [
            {
              ref: "@input",
              role: "textfield",
              label: "Write your prompt to Claude",
              value: "Visible X summary: Profile",
            },
          ],
        }),
        snapshot({
          id: "post",
          visibleText: ["JARVIS_GUI_WRITE_PROBE_DO_NOT_SEND"],
          elements: [
            {
              ref: "@input",
              role: "textfield",
              label: "Write your prompt to Claude",
              value: "JARVIS_GUI_WRITE_PROBE_DO_NOT_SEND",
            },
          ],
        }),
      ],
      actions: [{ ok: true }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@input" },
      actionType: "setValue",
      value: "JARVIS_GUI_WRITE_PROBE_DO_NOT_SEND",
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
      verify: (post) => ({
        ok: post.visibleText?.includes("JARVIS_GUI_WRITE_PROBE_DO_NOT_SEND") === true,
        summary: "post-state contains expected value",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.audit.result).toBe("verified");
  });

  it("polls post-state before failing an asynchronous set-value false failure", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({ id: "pre", elements: [{ ref: "@input", value: "" }] }),
        snapshot({ id: "post-early", elements: [{ ref: "@input", value: "" }] }),
        snapshot({ id: "post-late", elements: [{ ref: "@input", value: "hello" }] }),
      ],
      actions: [{ ok: false, message: "executor reported failure" }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@input" },
      actionType: "setValue",
      value: "hello",
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
      verificationTimeoutMs: 250,
      verificationIntervalMs: 100,
      verify: (post) => ({
        ok: post.elements.some((element) => element.value === "hello"),
        summary: "post-state contains expected value",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.stats.retries).toBe(1);
    expect(result.stats.falseFailures).toBe(1);
  });

  it("blocks scoped press without explicit mutation approval", async () => {
    const runtime = new MockGuiRuntime({
      observations: [snapshot({ id: "pre", elements: [] })],
      actions: [{ ok: true }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      actionType: "press",
      keys: ["cmd+return"],
      reason: "Submit a Claude message.",
      approvedPolicyRisk: false,
      taskPolicy: assistantSendPolicy,
      verify: () => ({ ok: true, summary: "should not run" }),
    });

    expect(result.ok).toBe(false);
    expect(result.audit.result).toBe("blocked");
    expect(result.stats.actionCount).toBe(0);
  });

  it("runs app-scoped press after approval and verifies post-state", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({ id: "pre", summary: "Claude composer contains message", elements: [] }),
        snapshot({ id: "post", summary: "Claude reply visible", elements: [] }),
      ],
      actions: [{ ok: true, movedFocus: true }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      actionType: "press",
      keys: ["cmd+return"],
      reason: "Submit a Claude message.",
      approvedPolicyRisk: true,
      taskPolicy: assistantSendPolicy,
      verify: (post) => ({
        ok: post.summary === "Claude reply visible",
        summary: "reply appeared",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.stats.actionCount).toBe(1);
    expect(result.stats.movedFocus).toBe(true);
  });

  it("runs approved semantic Send button clicks and verifies post-state", async () => {
    const sendButton = { ref: "@send", role: "button", label: "Send" };
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({ id: "pre", elements: [sendButton] }),
        snapshot({ id: "post", summary: "Claude reply visible", elements: [] }),
      ],
      actions: [{ ok: true, actionCount: 1, movedFocus: false }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: sendButton,
      actionType: "click",
      reason: "Submit a Claude message.",
      approvedPolicyRisk: true,
      taskPolicy: assistantSendPolicy,
      verify: (post) => ({
        ok: post.summary === "Claude reply visible",
        summary: "reply appeared",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.audit.actionType).toBe("click");
    expect(result.stats.actionCount).toBe(1);
    expect(result.stats.movedFocus).toBe(false);
  });

  it("re-resolves a uniquely matching semantic Send button when refs churn", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({ id: "pre", elements: [{ ref: "@send-new", role: "button", label: "Send" }] }),
        snapshot({ id: "post", summary: "Claude reply visible", elements: [] }),
      ],
      actions: [{ ok: true, actionCount: 1, movedFocus: false }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@send-old", role: "button", label: "Send" },
      actionType: "click",
      reason: "Submit a Claude message.",
      approvedPolicyRisk: true,
      taskPolicy: assistantSendPolicy,
      verify: (post) => ({
        ok: post.summary === "Claude reply visible",
        summary: "reply appeared",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.audit.elementRef).toBe("@send-new");
  });

  it("fails closed before acting when the observed app/window is wrong", async () => {
    const runtime = new MockGuiRuntime({
      observations: [snapshot({ appName: "Telegram", windowTitle: "Telegram" })],
      actions: [{ ok: true }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@input" },
      actionType: "setValue",
      value: "hello",
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
      verify: () => ({ ok: true, summary: "should not run" }),
    });

    expect(result.ok).toBe(false);
    expect(result.audit.result).toBe("failed");
    expect(result.stats.actionCount).toBe(0);
    expect(result.failureReason).toContain("Wrong target");
  });

  it("blocks generic sensitive surfaces even with approval and capability", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({
          appName: "Claude",
          windowTitle: "Claude",
          summary: "Account settings with delete workspace button",
          elements: [{ ref: "@delete", role: "button", label: "Delete workspace" }],
        }),
      ],
      actions: [{ ok: true }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@delete" },
      actionType: "click",
      reason: "Click a verified destructive settings button.",
      approvedPolicyRisk: true,
      taskPolicy: assistantSendPolicy,
      verify: () => ({ ok: true, summary: "should not run" }),
    });

    expect(result.ok).toBe(false);
    expect(result.audit.result).toBe("blocked");
    expect(result.audit.risk).toBe("blocked");
    expect(result.stats.actionCount).toBe(0);
  });

  it("creates an audit record for verified actions", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({ id: "pre", elements: [{ ref: "@input", value: "" }] }),
        snapshot({ id: "post", elements: [{ ref: "@input", value: "hello" }] }),
      ],
      actions: [{ ok: true }],
    });

    const result = await performVerifiedAction({
      runtime,
      target: { appName: "Claude" },
      element: { ref: "@input" },
      actionType: "setValue",
      value: "hello",
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
      verify: () => ({ ok: true, summary: "verified" }),
    });

    expect(result.ok).toBe(true);
    expect(result.audit.actionType).toBe("setValue");
    expect(result.audit.result).toBe("verified");
    expect(result.audit.reason).toContain("benchmark");
  });
});
