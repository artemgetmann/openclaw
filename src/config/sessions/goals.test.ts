import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionGoal,
  createSessionGoal,
  getSessionGoal,
  recordSessionGoalEvaluation,
  recordSessionGoalContinuation,
  requestSessionGoalEvaluation,
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

  it("lets only a satisfied evaluator verdict complete a goal", async () => {
    const authorityGrant = {
      purposeKey: "deployment:health-proof",
      action: {
        kind: SESSION_GOAL_CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
        threadId: "thread-health-proof",
        prompt: "Run the approved health proof.",
      },
      idempotencyKey: "health-proof-1",
      expiresAt: "2026-08-31T00:00:00.000Z",
      stopCondition: "Stop after one accepted proof run.",
      maxExecutions: 1 as const,
    };
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Prove the deployment is healthy.",
      autonomy: { level: "act_within_scope", authorityGrants: [authorityGrant] },
    });

    const revision = await recordSessionGoalEvaluation({
      sessionKey,
      storePath,
      expectedGoalId: goal.id,
      attemptId: "judge-1",
      verdict: "needs_revision",
      reason: "The build passed, but no runtime health evidence was supplied.",
      evidence: ["pnpm test passed", "No health endpoint result in the turn evidence"],
      materialProgress: true,
      now: 2_000,
    });
    expect(revision.goal.status).toBe("active");
    expect(revision.goal.autonomy?.authorityGrants).toEqual([authorityGrant]);
    expect(revision.shouldContinueAutomatically).toBe(true);
    expect(revision.attempt.verdict).toBe("needs_revision");

    const needsInput = await recordSessionGoalEvaluation({
      sessionKey,
      storePath,
      expectedGoalId: goal.id,
      attemptId: "judge-2",
      verdict: "needs_input",
      reason: "One deployment target must be selected.",
      evidence: ["Both staging and production are configured"],
      materialProgress: false,
      now: 3_000,
    });
    expect(needsInput.goal.status).toBe("active");
    expect(needsInput.shouldContinueAutomatically).toBe(false);
    expect(needsInput.stopReason).toBe("needs_input");

    const satisfied = await recordSessionGoalEvaluation({
      sessionKey,
      storePath,
      expectedGoalId: goal.id,
      attemptId: "judge-3",
      verdict: "satisfied",
      reason: "The requested deployment is healthy.",
      evidence: ["Health endpoint returned 200", "Live smoke test passed"],
      materialProgress: true,
      now: 4_000,
    });
    expect(satisfied.goal.status).toBe("complete");
    expect(satisfied.goal.autonomy?.authorityGrants).toEqual([authorityGrant]);
    expect(satisfied.goal.completedAt).toBe(4_000);
    expect(satisfied.stopReason).toBe("satisfied");
  });

  it("persists an idempotent model claim without granting completion authority", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Prove the release is healthy.",
    });
    const first = await requestSessionGoalEvaluation({
      sessionKey,
      storePath,
      expectedGoalId: goal.id,
      requestId: "tool-call-1",
      proposedStatus: "complete",
      reason: "All focused checks passed.",
      now: 2_000,
    });
    const duplicate = await requestSessionGoalEvaluation({
      sessionKey,
      storePath,
      expectedGoalId: goal.id,
      requestId: "tool-call-1",
      proposedStatus: "complete",
      reason: "This conflicting retry must not replace the original claim.",
      now: 3_000,
    });

    expect(first.status).toBe("active");
    expect(duplicate.pendingEvaluation).toEqual(first.pendingEvaluation);
    expect(duplicate.pendingEvaluation?.reason).toBe("All focused checks passed.");
  });

  it("blocks only after three evidenced no-progress attempts against the same blocker", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Wait for the vendor export.",
    });
    const evaluateBlocked = (attempt: number, blockerKey = "vendor-export") =>
      recordSessionGoalEvaluation({
        sessionKey,
        storePath,
        expectedGoalId: goal.id,
        attemptId: `judge-${attempt}`,
        verdict: "goal_blocked",
        reason: "The same vendor export is still unavailable.",
        evidence: [`Attempt ${attempt}: vendor API returned export_pending`],
        materialProgress: false,
        blockerKey,
        now: 1_000 + attempt,
      });

    const first = await evaluateBlocked(1);
    expect(first.attempt).toMatchObject({
      proposedVerdict: "goal_blocked",
      verdict: "needs_revision",
      consecutiveNoProgress: 1,
    });
    expect(first.goal.status).toBe("active");

    const second = await evaluateBlocked(2);
    expect(second.attempt.verdict).toBe("needs_revision");
    expect(second.attempt.consecutiveNoProgress).toBe(2);
    expect(second.goal.status).toBe("active");

    const third = await evaluateBlocked(3);
    expect(third.attempt.verdict).toBe("goal_blocked");
    expect(third.attempt.consecutiveNoProgress).toBe(3);
    expect(third.goal.status).toBe("blocked");
    expect(third.goal.blockedAt).toBe(1_003);
    expect(third.stopReason).toBe("goal_blocked");

    // Reloading from disk proves the terminal verdict and evidence survive restarts.
    const persisted = await getSessionGoal({ sessionKey, storePath, persist: false });
    expect(persisted.goal?.evaluation?.history).toHaveLength(3);
    expect(persisted.goal?.evaluation?.history[2]?.evidence).toEqual([
      "Attempt 3: vendor API returned export_pending",
    ]);
  });

  it("does not combine different blockers and resets the streak after material progress", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Collect both external confirmations.",
    });
    const evaluate = (params: {
      attemptId: string;
      blockerKey: string;
      materialProgress: boolean;
    }) =>
      recordSessionGoalEvaluation({
        sessionKey,
        storePath,
        expectedGoalId: goal.id,
        verdict: "goal_blocked",
        reason: "An external confirmation is missing.",
        evidence: [`Checked ${params.blockerKey}`],
        now: 2_000,
        ...params,
      });

    expect(
      (await evaluate({ attemptId: "one", blockerKey: "vendor-a", materialProgress: false }))
        .attempt.consecutiveNoProgress,
    ).toBe(1);
    expect(
      (await evaluate({ attemptId: "two", blockerKey: "vendor-b", materialProgress: false }))
        .attempt.consecutiveNoProgress,
    ).toBe(1);
    await expect(
      evaluate({ attemptId: "three", blockerKey: "vendor-b", materialProgress: true }),
    ).rejects.toThrow("goal_blocked requires a blocker key and no material progress");

    const progress = await recordSessionGoalEvaluation({
      sessionKey,
      storePath,
      expectedGoalId: goal.id,
      attemptId: "three-progress",
      verdict: "needs_revision",
      reason: "Vendor A replied; vendor B remains.",
      evidence: ["Vendor A confirmation received"],
      materialProgress: true,
      blockerKey: "vendor-b",
      now: 3_000,
    });
    expect(progress.attempt.consecutiveNoProgress).toBe(0);
    expect(progress.goal.evaluation?.sameBlockerNoProgressCount).toBe(0);
  });

  it("is idempotent across restarts and rejects stale goal ids", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Verify once.",
    });
    const input = {
      sessionKey,
      storePath,
      expectedGoalId: goal.id,
      attemptId: "stable-attempt",
      verdict: "needs_revision" as const,
      reason: "One proof is missing.",
      evidence: ["No screenshot was inspected"],
      materialProgress: false,
      blockerKey: "visual-proof",
      now: 2_000,
    };
    const first = await recordSessionGoalEvaluation(input);
    const duplicate = await recordSessionGoalEvaluation(input);

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.goal.evaluation?.history).toHaveLength(1);
    expect(duplicate.goal.evaluation?.automaticRevisionCount).toBe(1);
    await expect(
      recordSessionGoalEvaluation({ ...input, attemptId: "stale", expectedGoalId: "old-goal" }),
    ).rejects.toThrow("goal mismatch");
  });

  it("persists the automatic revision bound without mislabeling exhaustion as blocked", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Try bounded revisions.",
    });
    let latest;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      latest = await recordSessionGoalEvaluation({
        sessionKey,
        storePath,
        expectedGoalId: goal.id,
        attemptId: `revision-${attempt}`,
        verdict: "needs_revision",
        reason: "There is still a viable autonomous next step.",
        evidence: [`Revision ${attempt} produced a distinct test result`],
        materialProgress: true,
        now: 3_000 + attempt,
      });
    }

    expect(latest?.goal.status).toBe("active");
    expect(latest?.shouldContinueAutomatically).toBe(false);
    expect(latest?.stopReason).toBe("revision_limit");
    expect(latest?.goal.evaluation?.automaticRevisionExhaustedAt).toBe(3_005);
    expect(latest?.goal.blockedAt).toBeUndefined();
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
