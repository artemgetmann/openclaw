import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DURABLE_PLAN_FILE_POLICY_PROMPT,
  resolveDurablePlanFileDecision,
  resolveDurablePlanFilePath,
} from "./durable-plan-file-policy.js";

describe("durable plan file policy", () => {
  it("keeps normal update_plan usage session-scoped with no plan file", () => {
    expect(resolveDurablePlanFileDecision()).toEqual({
      enabled: false,
      reason: "not_requested",
    });
  });

  it("allows explicit user requests and stores them under OpenClaw state", () => {
    const stateDir = path.resolve("/var/lib/openclaw-test");
    const decision = resolveDurablePlanFileDecision(
      {
        reason: "explicit_user_request",
        agentId: "Jarvis Main",
        sessionId: "session-1",
      },
      {
        env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      },
    );

    expect(decision).toEqual({
      enabled: true,
      reason: "explicit_user_request",
      agentId: "jarvis-main",
      sessionId: "session-1",
      path: path.join(stateDir, "agents", "jarvis-main", "plans", "session-1.plan.json"),
    });
  });

  it("allows approved long-running work without treating it as default behavior", () => {
    const stateDir = path.resolve("/var/lib/openclaw-test");
    expect(
      resolveDurablePlanFileDecision(
        {
          reason: "approved_long_running",
          sessionId: "multi-day-task",
        },
        {
          env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
        },
      ),
    ).toMatchObject({
      enabled: true,
      reason: "approved_long_running",
      path: path.join(stateDir, "agents", "main", "plans", "multi-day-task.plan.json"),
    });
  });

  it("rejects product plan state under /tmp", () => {
    expect(() =>
      resolveDurablePlanFilePath(
        {
          agentId: "main",
          sessionId: "session-1",
        },
        {
          env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-plans" } as NodeJS.ProcessEnv,
        },
      ),
    ).toThrow(/must not be stored in \/tmp/);
  });

  it("rejects product plan state when the state dir is the platform temp dir itself", () => {
    expect(() =>
      resolveDurablePlanFilePath(
        {
          agentId: "main",
          sessionId: "session-1",
        },
        {
          env: { OPENCLAW_STATE_DIR: os.tmpdir() } as NodeJS.ProcessEnv,
        },
      ),
    ).toThrow(/must not be stored in \/tmp/);
  });

  it("rejects unsafe session ids before building a durable path", () => {
    expect(() =>
      resolveDurablePlanFileDecision(
        {
          reason: "explicit_user_request",
          sessionId: "../escape",
        },
        {
          env: { OPENCLAW_STATE_DIR: "/var/lib/openclaw-test" } as NodeJS.ProcessEnv,
        },
      ),
    ).toThrow(/Invalid session ID/);
  });

  it("states the model-facing policy constraints plainly", () => {
    expect(DURABLE_PLAN_FILE_POLICY_PROMPT).toContain("normal tasks");
    expect(DURABLE_PLAN_FILE_POLICY_PROMPT).toContain("explicit user request");
    expect(DURABLE_PLAN_FILE_POLICY_PROMPT).toContain("receiving approval");
    expect(DURABLE_PLAN_FILE_POLICY_PROMPT).toContain("/tmp");
  });
});
