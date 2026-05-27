import { afterEach, describe, expect, it } from "vitest";
import {
  canStartAnotherDurableTaskAttempt,
  cancelDurableReplyTasksForKeys,
  formatDurableTaskExhaustedFailure,
  recordDurableTaskAttemptStart,
  recordDurableTaskEvidence,
  recordDurableTaskFallbackNotice,
  resetDurableReplyTasksForTest,
  startDurableReplyTask,
} from "./durable-task-state.js";

afterEach(() => {
  resetDurableReplyTasksForTest();
});

describe("durable reply task state", () => {
  it("uses bounded attempts instead of allowing infinite retries", () => {
    const task = startDurableReplyTask({
      sessionKey: "main",
      sessionId: "session",
      maxAttempts: 2,
      maxWallClockMs: 60_000,
    });

    recordDurableTaskAttemptStart(task);
    expect(canStartAnotherDurableTaskAttempt(task)).toEqual({ ok: true });

    recordDurableTaskAttemptStart(task);
    expect(canStartAnotherDurableTaskAttempt(task)).toEqual({
      ok: false,
      reason: "attempts",
    });
  });

  it("turns Stop into a cancel flag that blocks the next attempt", () => {
    const task = startDurableReplyTask({
      sessionKey: "main",
      sessionId: "session",
      maxAttempts: 5,
      maxWallClockMs: 60_000,
    });
    recordDurableTaskAttemptStart(task);

    expect(cancelDurableReplyTasksForKeys(["session"])).toBe(1);

    expect(canStartAnotherDurableTaskAttempt(task)).toEqual({
      ok: false,
      reason: "canceled",
    });
  });

  it("formats exhausted failures with the last evidence snapshot", () => {
    const task = startDurableReplyTask({
      sessionKey: "main",
      sessionId: "session",
      maxAttempts: 1,
      maxWallClockMs: 60_000,
    });
    recordDurableTaskAttemptStart(task);
    recordDurableTaskEvidence(task, "tool_result", {
      text: "Found checkpoint skill at r0/checkpoint/SKILL.md.",
    });

    expect(formatDurableTaskExhaustedFailure(task)).toMatchObject({
      isError: true,
      text: expect.stringContaining("Found checkpoint skill"),
    });
  });

  it("dedupes provider fallback notices within one task", () => {
    const task = startDurableReplyTask({
      sessionKey: "main",
      sessionId: "session",
      maxAttempts: 5,
      maxWallClockMs: 60_000,
    });

    expect(
      recordDurableTaskFallbackNotice(task, "Claude CLI unavailable; continuing with GPT-5.4."),
    ).toBe(true);
    expect(
      recordDurableTaskFallbackNotice(task, "Claude CLI unavailable; continuing with GPT-5.4."),
    ).toBe(false);
  });
});
