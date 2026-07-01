import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
}));

import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";

describe("sendExecApprovalFollowup", () => {
  it("passes turn-source channel, account, target, and topic to the gateway agent followup", async () => {
    await expect(
      sendExecApprovalFollowup({
        approvalId: "approval-1",
        sessionKey: "agent:main:telegram:group:-1003783709877:topic:17730",
        turnSourceChannel: "telegram",
        turnSourceTo: "-1003783709877",
        turnSourceAccountId: "default",
        turnSourceThreadId: 17730,
        resultText: "The approved async command finished successfully.",
      }),
    ).resolves.toBe(true);

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "agent",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        sessionKey: "agent:main:telegram:group:-1003783709877:topic:17730",
        deliver: true,
        bestEffortDeliver: true,
        channel: "telegram",
        to: "-1003783709877",
        accountId: "default",
        threadId: "17730",
        idempotencyKey: "exec-approval-followup:approval-1",
      }),
      { expectFinal: true },
    );
  });
});
