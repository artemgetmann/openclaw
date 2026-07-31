import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionGoal,
  createSessionGoal,
  getSessionGoal,
  recordSessionGoalContinuation,
  resolveSessionGoalAutonomy,
  updateSessionGoalStatus,
} from "./goals.js";
import { loadSessionStore, updateSessionStore } from "./store.js";
import { SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION } from "./types.js";

describe("session goals", () => {
  let tempDir = "";
  let storePath = "";
  const sessionKey = "agent:main:telegram:direct:123";

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-goals-"));
    storePath = path.join(tempDir, "sessions.json");
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-1",
        updatedAt: 1,
        totalTokens: 10,
        totalTokensFresh: true,
      };
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates, reads, updates, and clears one goal per session", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Get the refund confirmed.",
      tokenBudget: 100,
      now: 1000,
    });

    expect(goal.objective).toBe("Get the refund confirmed.");
    expect(goal.status).toBe("active");
    await expect(
      createSessionGoal({ sessionKey, storePath, objective: "Replace it" }),
    ).rejects.toThrow("goal already exists");

    const found = await getSessionGoal({ sessionKey, storePath, persist: false });
    expect(found.goal?.objective).toBe("Get the refund confirmed.");

    const blocked = await updateSessionGoalStatus({
      sessionKey,
      storePath,
      status: "blocked",
      note: "Need order number.",
      now: 2000,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.lastStatusNote).toBe("Need order number.");

    await expect(clearSessionGoal({ sessionKey, storePath })).resolves.toBe(true);
    expect((await getSessionGoal({ sessionKey, storePath })).status).toBe("missing");
  });

  it("persists only explicitly supplied bounded autonomy and defaults legacy goals to observe-only", async () => {
    const authorityGrant = {
      purposeKey: "mac-release:verify-login-item",
      action: {
        kind: SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
        threadId: "thread-release-proof",
        prompt: "Run the deferred release proof.",
      },
      idempotencyKey: "release-proof-1",
      expiresAt: "2026-08-31T00:00:00.000Z",
      stopCondition: "Stop after one accepted continuation.",
      maxExecutions: 1 as const,
    };
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Negotiate within my stated limits.",
      autonomy: {
        level: "act_within_scope",
        allowedActions: ["  follow up with the vendor  ", "follow up with the vendor"],
        approvalRequired: ["accept a higher price"],
        authorityGrants: [authorityGrant, authorityGrant],
      },
    });
    expect(goal.autonomy).toEqual({
      level: "act_within_scope",
      allowedActions: ["follow up with the vendor"],
      approvalRequired: ["accept a higher price"],
      authorityGrants: [authorityGrant],
    });

    await clearSessionGoal({ sessionKey, storePath });
    const legacy = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Observe the ticket.",
    });
    expect(legacy).not.toHaveProperty("autonomy");
    expect(resolveSessionGoalAutonomy(legacy)).toEqual({ level: "observe_only" });
  });

  it("records continuation only for the exact active goal", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Keep the process moving.",
    });
    const continued = await recordSessionGoalContinuation({
      sessionKey,
      storePath,
      expectedGoalId: goal.id,
      now: 2_000,
    });
    expect(continued?.continuationTurns).toBe(1);

    await updateSessionGoalStatus({
      sessionKey,
      storePath,
      status: "complete",
      now: 3_000,
    });
    await expect(
      recordSessionGoalContinuation({
        sessionKey,
        storePath,
        expectedGoalId: goal.id,
        now: 4_000,
      }),
    ).resolves.toBeUndefined();
    expect(
      (await getSessionGoal({ sessionKey, storePath, persist: false })).goal?.continuationTurns,
    ).toBe(1);
  });

  it("accounts token budgets from fresh session usage", async () => {
    await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Finish the dinner plan.",
      tokenBudget: 15,
      now: 1000,
    });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        ...store[sessionKey],
        totalTokens: 30,
        totalTokensFresh: true,
      };
    });

    const snapshot = await getSessionGoal({ sessionKey, storePath, now: 2000 });
    expect(snapshot.goal?.tokensUsed).toBe(20);
    expect(snapshot.goal?.status).toBe("budget_limited");

    const store = loadSessionStore(storePath);
    expect(store[sessionKey]?.goal?.status).toBe("budget_limited");
  });

  it("creates goals on the normalized session key and removes legacy casing", async () => {
    const mixedCaseSessionKey = "Agent:Main:Telegram:Direct:456";
    const normalizedSessionKey = mixedCaseSessionKey.toLowerCase();
    await updateSessionStore(storePath, (store) => {
      store[mixedCaseSessionKey] = {
        sessionId: "session-legacy",
        updatedAt: 1,
      };
    });

    await createSessionGoal({
      sessionKey: normalizedSessionKey,
      storePath,
      objective: "Keep checking the support ticket.",
      now: 1000,
    });

    const store = loadSessionStore(storePath);
    expect(store[mixedCaseSessionKey]).toBeUndefined();
    expect(store[normalizedSessionKey]?.goal?.objective).toBe("Keep checking the support ticket.");
  });
});
