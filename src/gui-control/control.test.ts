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
  clicks: ElementRef[] = [];
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

  async click(target: ElementRef): Promise<ActionResult> {
    this.clicks.push(target);
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

  it("fails closed before clicking a broad browser link with ambiguous sibling controls", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({
          appName: "Safari",
          windowTitle: "Google Flights",
          elements: [
            {
              ref: "@71",
              role: "link From 2485582 Indonesian rupiahs round trip total. Nonstop flight with KLM. Leaves I Gusti Ngurah Rai International Airport at 8:45 PM on Friday, September 18 and arrives at Singapore Changi Airport at 11:25 PM on Friday, September 18. Total duration 2 hr 40 min. Select flight",
              label:
                "link From 2485582 Indonesian rupiahs round trip total. Nonstop flight with KLM. Leaves I Gusti Ngurah Rai International Airport at 8:45 PM on Friday, September 18 and arrives at Singapore Changi Airport at 11:25 PM on Friday, September 18. Total duration 2 hr 40 min. Select flight",
            },
          ],
        }),
        snapshot({
          appName: "Safari",
          windowTitle: "Google Flights",
          elements: [
            {
              ref: "@71",
              role: "link From 2485582 Indonesian rupiahs round trip total. Nonstop flight with KLM. Leaves I Gusti Ngurah Rai International Airport at 8:45 PM on Friday, September 18 and arrives at Singapore Changi Airport at 11:25 PM on Friday, September 18. Total duration 2 hr 40 min. Select flight",
              label:
                "link From 2485582 Indonesian rupiahs round trip total. Nonstop flight with KLM. Leaves I Gusti Ngurah Rai International Airport at 8:45 PM on Friday, September 18 and arrives at Singapore Changi Airport at 11:25 PM on Friday, September 18. Total duration 2 hr 40 min. Select flight",
            },
            {
              ref: "@78",
              role: "pop up button Carbon emissions estimate: 145 kilograms. +26% emissions. Learn more about this emissions estimate",
              label:
                "pop up button Carbon emissions estimate: 145 kilograms. +26% emissions. Learn more about this emissions estimate",
            },
            {
              ref: "@81",
              role: "button Flight details. Leaves I Gusti Ngurah Rai International Airport at 8:45 PM on Friday, September 18 and arrives at Singapore Changi Airport at 11:25 PM on Friday, September 18.",
              label:
                "button Flight details. Leaves I Gusti Ngurah Rai International Airport at 8:45 PM on Friday, September 18 and arrives at Singapore Changi Airport at 11:25 PM on Friday, September 18.",
            },
          ],
        }),
      ],
    });

    const result = await runGuiControl({
      runtime,
      action: "click",
      appName: "Safari",
      windowTitle: "Google Flights",
      ref: "@71",
      taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
      approvedPolicyRisk: true,
      verifyText: "Returning flights",
      reason: "Activate the visible Select flight result link without final booking.",
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("Refusing blind click on broad browser link @71");
    expect(result.verifiedAction?.stats.actionCount).toBe(0);
    expect(runtime.clicks).toEqual([]);
  });

  it("allows a normal narrow browser link to continue through verified click", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({
          appName: "Safari",
          windowTitle: "Example",
          elements: [{ ref: "@7", role: "link Pricing", label: "link Pricing" }],
        }),
        snapshot({
          appName: "Safari",
          windowTitle: "Example",
          elements: [{ ref: "@7", role: "link Pricing", label: "link Pricing" }],
        }),
        snapshot({
          appName: "Safari",
          windowTitle: "Example",
          visibleText: ["Plans"],
          elements: [{ ref: "@9", role: "heading Plans", label: "heading Plans" }],
        }),
      ],
      actions: [{ ok: true }],
    });

    const result = await runGuiControl({
      runtime,
      action: "click",
      appName: "Safari",
      windowTitle: "Example",
      ref: "@7",
      taskPolicy: getGuiTaskPolicyProfile("commerce_flow_until_final_confirmation"),
      approvedPolicyRisk: true,
      verifyText: "Plans",
      reason: "Open a reversible browser link.",
    });

    expect(result.ok).toBe(true);
    expect(runtime.clicks).toEqual([expect.objectContaining({ ref: "@7" })]);
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

  it("fails closed when the runtime does not support secondary actions", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({
          elements: [
            { ref: "@link", role: "link", label: "Select flight", secondaryActions: ["AXPress"] },
          ],
        }),
      ],
    });
    runtime.performSecondaryAction = undefined as never;

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

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.failureReason).toContain("Runtime does not support secondary actions");
    expect(runtime.secondaryActions).toEqual([]);
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

  it("fails closed before runtime mutation when the element does not advertise the secondary action", async () => {
    const runtime = new MockGuiRuntime({
      observations: [
        snapshot({
          id: "resolve",
          elements: [{ ref: "@link", role: "link", label: "Select flight" }],
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

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.failureReason).toContain("does not advertise");
    expect(runtime.secondaryActions).toEqual([]);
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
