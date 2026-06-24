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

  it("allows Jarvis About-row navigation when unrelated settings controls are dangerous", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Jarvis", windowTitle: "Settings" },
      snapshot: snapshot({
        appName: "Jarvis",
        windowTitle: "Settings",
        summary: "Settings sidebar with General, Permissions, About, Stop AI Operator",
        visibleText: ["General", "Permissions", "About", "Stop AI Operator", "Quit App Only"],
      }),
      element: { ref: "@about", role: "row", label: "About" },
      reason: "Navigate to the About settings row.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("safe_local_settings_navigation"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("click_verified_button");
  });

  it.each(["Stop AI Operator", "Quit App Only", "Destructive Settings"])(
    "blocks dangerous Jarvis settings label %s under the local navigation profile",
    (label) => {
      const decision = evaluateGuiPolicy({
        actionType: "click",
        target: { appName: "Jarvis", windowTitle: "Settings" },
        snapshot: snapshot({
          appName: "Jarvis",
          windowTitle: "Settings",
          summary: "Jarvis settings",
        }),
        element: { ref: "@danger", role: "button", label },
        reason: `Click ${label}.`,
        approvedPolicyRisk: true,
        taskPolicy: getGuiTaskPolicyProfile("safe_local_settings_navigation"),
        verificationMode: "post_state",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("Blocked sensitive GUI surface");
    },
  );

  it("allows Google Flights destination writes under the non-committal web dry-run profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Safari", windowTitle: "Google Flights" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Google Flights",
        summary: "Flight search page showing Denpasar origin and destination field",
      }),
      element: { ref: "@destination", role: "textbox", label: "Where to?" },
      reason: "Set the destination field to Singapore for a dry-run search.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("write_text_to_target");
  });

  it("allows visible Google Flights suggestion-card clicks under the web dry-run profile", () => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Google Flights" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Google Flights",
        summary: "Flight search page with visible DPS to SIN suggestion cards",
      }),
      element: { ref: "@suggestion", role: "button", label: "DPS to SIN" },
      reason: "Click the already-visible Google Flights suggestion card.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("click_verified_button");
  });

  it.each([
    "Log in",
    "Payment",
    "Passenger details",
    "Traveler details",
    "Checkout",
    "Purchase",
    "Book",
    "Confirm",
    "Card details",
  ])("blocks committal web surface %s under the dry-run profile", (label) => {
    const decision = evaluateGuiPolicy({
      actionType: "click",
      target: { appName: "Safari", windowTitle: "Google Flights" },
      snapshot: snapshot({
        appName: "Safari",
        windowTitle: "Google Flights",
        summary: "Flight search page",
      }),
      element: { ref: "@commit", role: "button", label },
      reason: `Click ${label}.`,
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("non_committal_web_dry_run"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Blocked sensitive GUI surface");
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

  it("does not block a safe mutation because unrelated snapshot chrome says remove", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Claude", windowTitle: "Claude" },
      snapshot: snapshot({
        appName: "Claude",
        windowTitle: "Claude",
        summary: "Composer ready. Toolbar secondary action: Remove from toolbar.",
        visibleText: ["Write your prompt to Claude", "Remove from toolbar"],
      }),
      element: {
        ref: "@input",
        role: "text entry area",
        label: "Write your prompt to Claude",
        description: "Write your prompt to Claude",
        value: "Write a message…",
      },
      reason: "Write approved benchmark message.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("send_message_to_approved_assistant"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
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

  it("allows approved Apple Notes writes with the Notes policy", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Notes", windowTitle: "Notes" },
      snapshot: snapshot({ appName: "Notes", windowTitle: "Notes", summary: "Note body ready" }),
      element: { ref: "@note-body", role: "textArea", label: "Note body" },
      reason: "Write approved benchmark text into Apple Notes.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("notes_write"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe("allowed-mutation");
    expect(decision.requiredCapability).toBe("write_text_to_target");
  });

  it("does not let the Notes policy write to assistant apps", () => {
    const decision = evaluateGuiPolicy({
      actionType: "setValue",
      target: { appName: "Claude", windowTitle: "Claude" },
      snapshot: snapshot({ appName: "Claude", windowTitle: "Claude", summary: "Composer ready" }),
      element: { ref: "@input", role: "textfield", label: "Write your prompt to Claude" },
      reason: "Write benchmark text into Claude.",
      approvedPolicyRisk: true,
      taskPolicy: getGuiTaskPolicyProfile("notes_write"),
      verificationMode: "post_state",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("does not allow app Claude");
  });
});
