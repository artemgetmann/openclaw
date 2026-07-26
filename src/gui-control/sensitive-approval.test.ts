import { describe, expect, it, vi } from "vitest";
import { requestExecApprovalDecision } from "../agents/bash-tools.exec-approval-request.js";
import type { GuiApprovalScope } from "./policy.js";
import { requestGuiSensitiveApproval } from "./sensitive-approval.js";

const scope: GuiApprovalScope = {
  actionType: "setValue",
  runtimeName: "agent-desktop",
  appName: "system settings",
  windowTitle: "sign-in required",
  windowId: "",
  taskPolicyId: "trusted_local_gui_control",
  selectedControl: ["secure text field", "password"],
  actionParameters: [],
  visibleTransactionDetails: [],
  visibleContextSummary: ["merchant alpha", "blue travel bag"],
  visibleContextFingerprint: "safe-context-fingerprint",
  sensitiveTerms: ["password", "sign in"],
};

describe("requestGuiSensitiveApproval", () => {
  it("forwards trusted origin and accepts only allow-once without exposing a secret value", async () => {
    let requestedCommand = "";
    const requestDecision: typeof requestExecApprovalDecision = vi.fn(async (request) => {
      requestedCommand = request.command ?? "";
      return "allow-once";
    });
    const result = await requestGuiSensitiveApproval({
      scope,
      reason: "Enter hunter2 into the password field.",
      origin: {
        agentId: "main",
        sessionKey: "agent:main:telegram:dm:42",
        channel: "telegram",
        to: "42",
        accountId: "default",
        threadId: 7,
      },
      cwd: "/tmp",
      requestDecision,
    });

    expect(result).toBe("allow-once");
    expect(requestDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('app="system settings"'),
        sessionKey: "agent:main:telegram:dm:42",
        turnSourceChannel: "telegram",
        turnSourceTo: "42",
        turnSourceAccountId: "default",
        turnSourceThreadId: 7,
      }),
    );
    expect(requestedCommand).not.toContain("hunter2");
    expect(requestedCommand).toContain('context=["merchant alpha","blue travel bag"]');
  });

  it.each(["allow-always", "deny", null])("rejects non-one-shot decision %s", async (decision) => {
    expect(
      await requestGuiSensitiveApproval({
        scope,
        reason: "Sensitive action.",
        requestDecision: vi.fn(async () => decision),
      }),
    ).toBe("deny");
  });
});
