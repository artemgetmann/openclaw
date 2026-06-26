import { describe, expect, it } from "vitest";
import { runGuiControl } from "./control.js";
import { getGuiTaskPolicyProfile } from "./policy.js";
import type {
  ActionResult,
  AppState,
  AppTarget,
  ElementRef,
  GuiRuntime,
  GuiSnapshot,
} from "./types.js";

const localFixturePolicy = getGuiTaskPolicyProfile("local_fixture_write");
const assistantSendPolicy = getGuiTaskPolicyProfile("send_message_to_approved_assistant");

class MockGuiRuntime implements GuiRuntime {
  readonly name = "agent-desktop" as const;
  observations: GuiSnapshot[];
  actions: ActionResult[];
  secondaryActions: Array<{ target: ElementRef; action: string }> = [];

  constructor(params: { observations: GuiSnapshot[]; actions?: ActionResult[] }) {
    this.observations = [...params.observations];
    this.actions = [...(params.actions ?? [])];
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

  async performSecondaryAction(target: ElementRef, action: string): Promise<ActionResult> {
    this.secondaryActions.push({ target, action });
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
    elements: params.elements ?? [{ ref: "@input", role: "textArea", label: "Message", value: "" }],
  };
}

describe("runGuiControl", () => {
  it("observes an app and returns a bounded element summary", async () => {
    const result = await runGuiControl({
      runtime: new MockGuiRuntime({
        observations: [
          snapshot({
            elements: [
              { ref: "@a", role: "button", label: "Send" },
              { ref: "@b", role: "textArea", label: "Message" },
            ],
          }),
        ],
      }),
      action: "observe",
      appName: "Claude",
      maxElements: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot?.elementCount).toBe(2);
    expect(result.snapshot?.elements).toHaveLength(1);
  });

  it("fails observe closed when the observed window does not match the requested title", async () => {
    const result = await runGuiControl({
      runtime: new MockGuiRuntime({
        observations: [
          snapshot({
            appName: "Safari",
            windowTitle: "Audiomack",
            elements: [{ ref: "@a", role: "link", label: "Go home" }],
          }),
        ],
      }),
      action: "observe",
      appName: "Safari",
      windowTitle: "X",
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.failureReason).toContain("Wrong target");
    expect(result.failureReason).toContain("Audiomack");
  });

  it("fails closed when click has no task-specific verification", async () => {
    const result = await runGuiControl({
      runtime: new MockGuiRuntime({
        observations: [snapshot({ elements: [{ ref: "@send", role: "button", label: "Send" }] })],
      }),
      action: "click",
      appName: "Claude",
      intent: "button",
      labelIncludes: "send",
      approvedPolicyRisk: true,
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.failureReason).toContain("--verify-text");
  });

  it("verifies set-value through the shared verifier path", async () => {
    const result = await runGuiControl({
      runtime: new MockGuiRuntime({
        observations: [
          snapshot({
            id: "resolve",
            elements: [{ ref: "@input", role: "textArea", label: "Message" }],
          }),
          snapshot({
            id: "pre",
            elements: [{ ref: "@input", role: "textArea", label: "Message" }],
          }),
          snapshot({
            id: "post",
            elements: [{ ref: "@input", role: "textArea", label: "Message", value: "hello" }],
          }),
        ],
        actions: [{ ok: true }],
      }),
      action: "set-value",
      appName: "Claude",
      intent: "text-input",
      labelIncludes: "message",
      value: "hello",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
    });

    expect(result.ok).toBe(true);
    expect(result.verifiedAction?.audit.result).toBe("verified");
    expect(result.verifiedAction?.stats.actionCount).toBe(1);
  });

  it("verifies set-value when the executor fails but the requested value is visible", async () => {
    const result = await runGuiControl({
      runtime: new MockGuiRuntime({
        observations: [
          snapshot({
            id: "resolve",
            elements: [{ ref: "@input", role: "textArea", label: "Message" }],
          }),
          snapshot({
            id: "pre",
            elements: [{ ref: "@input", role: "textArea", label: "Message" }],
          }),
          snapshot({
            id: "post",
            elements: [{ ref: "@input", role: "textArea", label: "Message", value: "hello" }],
          }),
        ],
        actions: [{ ok: false, message: "reported failure" }],
      }),
      action: "set-value",
      appName: "Claude",
      intent: "text-input",
      labelIncludes: "message",
      value: "hello",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
    });

    expect(result.ok).toBe(true);
    expect(result.verifiedAction?.stats.falseFailures).toBe(1);
  });

  it("fails observed-only click when post-state is unchanged", async () => {
    const result = await runGuiControl({
      runtime: new MockGuiRuntime({
        observations: [
          snapshot({ id: "resolve", elements: [{ ref: "@send", role: "button", label: "Send" }] }),
          snapshot({ id: "pre", elements: [{ ref: "@send", role: "button", label: "Send" }] }),
          snapshot({ id: "post", elements: [{ ref: "@send", role: "button", label: "Send" }] }),
        ],
        actions: [{ ok: true }],
      }),
      action: "click",
      appName: "Claude",
      intent: "button",
      labelIncludes: "send",
      approvedPolicyRisk: true,
      taskPolicy: assistantSendPolicy,
      allowObservedClick: true,
    });

    expect(result.ok).toBe(false);
    expect(result.verifiedAction?.stats.falseSuccesses).toBe(1);
  });

  it("fails closed when secondary action has no task-specific verification", async () => {
    const result = await runGuiControl({
      runtime: new MockGuiRuntime({
        observations: [
          snapshot({
            elements: [{ ref: "@link", role: "link", label: "Select flight" }],
          }),
        ],
      }),
      action: "secondary-action",
      appName: "Claude",
      ref: "@link",
      secondaryAction: "AXPress",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.failureReason).toContain("--verify-text");
  });

  it("performs a verified element secondary action through the shared verifier path", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({
          id: "resolve",
          elements: [
            { ref: "@link", role: "link", label: "Select flight", secondaryActions: ["AXPress"] },
          ],
        }),
        snapshot({
          id: "pre",
          elements: [
            { ref: "@link", role: "link", label: "Select flight", secondaryActions: ["AXPress"] },
          ],
        }),
        snapshot({
          id: "post",
          summary: "Returning flights",
          visibleText: ["Returning flights"],
          elements: [{ ref: "@back", role: "button", label: "Back" }],
        }),
      ],
      actions: [{ ok: true }],
    });

    const result = await runGuiControl({
      runtime,
      action: "secondary-action",
      appName: "Claude",
      ref: "@link",
      secondaryAction: "AXPress",
      verifyText: "Returning flights",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
    });

    expect(result.ok).toBe(true);
    expect(result.verifiedAction?.audit.actionType).toBe("secondaryAction");
    expect(runtime.secondaryActions).toEqual([
      {
        target: expect.objectContaining({ ref: "@link" }),
        action: "AXPress",
      },
    ]);
  });

  it("runs scroll through the verified action path with changed post-state", async () => {
    const result = await runGuiControl({
      runtime: new MockGuiRuntime({
        observations: [
          snapshot({
            id: "resolve",
            summary: "top of feed",
            elements: [{ ref: "@feed", role: "scrollArea", label: "Home feed" }],
          }),
          snapshot({
            id: "pre",
            summary: "top of feed",
            elements: [{ ref: "@feed", role: "scrollArea", label: "Home feed" }],
          }),
          snapshot({
            id: "post",
            summary: "lower feed",
            elements: [{ ref: "@feed", role: "scrollArea", label: "Home feed" }],
          }),
        ],
        actions: [{ ok: true }],
      }),
      action: "scroll",
      appName: "Claude",
      intent: "any",
      labelIncludes: "home feed",
      approvedPolicyRisk: true,
      taskPolicy: localFixturePolicy,
      allowObservedClick: true,
      scrollDirection: "down",
      scrollAmount: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.verifiedAction?.audit.actionType).toBe("scroll");
    expect(result.verifiedAction?.stats.actionCount).toBe(1);
  });
});
