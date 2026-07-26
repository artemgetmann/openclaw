import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { ExecApprovalRequestParamsSchema } from "./protocol/schema/exec-approvals.js";

describe("ExecApprovalManager allowed decisions", () => {
  it("rejects a resolution that the request did not offer", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "gui-control sensitive action",
        allowedDecisions: ["allow-once", "deny"],
      },
      10_000,
      "gui-sensitive-1",
    );
    const decision = manager.register(record, 10_000);

    expect(manager.resolve(record.id, "allow-always")).toBe(false);
    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await expect(decision).resolves.toBe("allow-once");
  });

  it("requires restricted decision sets to include allow-once", () => {
    expect(
      Value.Check(ExecApprovalRequestParamsSchema, {
        command: "gui-control sensitive action",
        allowedDecisions: ["allow-once", "deny"],
      }),
    ).toBe(true);
    expect(
      Value.Check(ExecApprovalRequestParamsSchema, {
        command: "gui-control sensitive action",
        allowedDecisions: ["deny"],
      }),
    ).toBe(false);
    expect(
      Value.Check(ExecApprovalRequestParamsSchema, {
        command: "gui-control sensitive action",
        allowedDecisions: ["allow-once"],
      }),
    ).toBe(false);
  });
});
