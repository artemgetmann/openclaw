import { describe, expect, it } from "vitest";
import { evaluateGuiPolicy, getGuiTaskPolicyProfile } from "./policy.js";
import type { GuiSnapshot } from "./types.js";

function snapshot(params: Partial<GuiSnapshot> = {}): GuiSnapshot {
  return {
    id: params.id ?? "s1",
    appName: params.appName ?? "Safari",
    windowTitle: params.windowTitle ?? "Example",
    summary: params.summary ?? "Readable web page",
    visibleText: params.visibleText,
    elements: params.elements ?? [],
  };
}

describe("evaluateGuiPolicy", () => {
  it("allows read-only observation with the read-only web profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "observe",
      target: { appName: "Safari", windowTitle: "X / Home" },
      snapshot: snapshot({ windowTitle: "X / Home" }),
      reason: "Observe a web page without changing it.",
      taskPolicy: getGuiTaskPolicyProfile("read_only_web_context"),
      verificationMode: "observe_only",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("read-only");
    expect(decision.requiredCapability).toBe("read_screen");
  });

  it("blocks mutation when the task lacks the matching capability", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Safari", windowTitle: "Example" },
      snapshot: snapshot(),
      element: { ref: "@input", role: "textbox", label: "Search" },
      reason: "Write text into the current page.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("read_only_web_context"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("lacks capability write_text_to_target");
  });

  it("blocks generic sensitive surfaces before capability approval can bypass them", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Claude", windowTitle: "Claude" },
      snapshot: snapshot({
        appName: "Claude",
        windowTitle: "Claude",
        summary: "Account settings include billing and delete controls",
      }),
      element: { ref: "@billing", role: "button", label: "Billing" },
      reason: "Click billing settings.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("send_message_to_approved_assistant"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI surface");
  });

  it("allows approved assistant message submission with post-state verification", () => {
    const decision = evaluateGuiPolicy({
      actionType: "press",
      target: { appName: "Claude", windowTitle: "Claude" },
      snapshot: snapshot({ appName: "Claude", windowTitle: "Claude", summary: "Composer ready" }),
      reason: "Submit a Claude message.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("send_message_to_approved_assistant"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("submit_message_to_target");
  });

  it("blocks target app mismatch against the task policy", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Telegram", windowTitle: "Telegram" },
      snapshot: snapshot({ appName: "Telegram", windowTitle: "Telegram" }),
      element: { ref: "@input", role: "textbox", label: "Message" },
      reason: "Write to an assistant composer.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("send_message_to_approved_assistant"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("does not allow app Telegram");
  });
});
