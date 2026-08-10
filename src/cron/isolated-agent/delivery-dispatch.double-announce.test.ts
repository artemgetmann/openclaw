/**
 * Tests for the double-announce bug in cron delivery dispatch.
 *
 * Bug: early return paths in text finalization (active subagent suppression
 * and stale interim message suppression) returned without setting
 * deliveryAttempted = true. The timer saw deliveryAttempted = false and
 * fired enqueueSystemEvent as a fallback, causing a second delivery.
 *
 * Fix: both early return paths now set deliveryAttempted = true before
 * returning so the timer correctly skips the system-event fallback.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks (must be hoisted before imports) ---

vi.mock("../../agents/subagent-registry.js", () => ({
  countActiveDescendantRuns: vi.fn().mockReturnValue(0),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([{ ok: true }]),
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("./subagent-followup.js", () => ({
  expectsSubagentFollowup: vi.fn().mockReturnValue(false),
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
  readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
}));

import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
// Import after mocks
import { countActiveDescendantRuns } from "../../agents/subagent-registry.js";
import {
  appendAssistantMessageToSessionTranscript,
  updateSessionStore,
} from "../../config/sessions.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { shouldEnqueueCronMainSummary } from "../heartbeat-policy.js";
import {
  dispatchCronDelivery,
  getCompletedDirectCronDeliveriesCountForTests,
  resetCompletedDirectCronDeliveriesForTests,
} from "./delivery-dispatch.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.js";
import {
  expectsSubagentFollowup,
  isLikelyInterimCronMessage,
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolvedDelivery(): Extract<DeliveryTargetResolution, { ok: true }> {
  return {
    ok: true,
    channel: "telegram",
    to: "123456",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
  };
}

function makeWithRunSession() {
  return (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: "test-session-id",
    sessionKey: "test-session-key",
  });
}

function makeBaseParams(overrides: {
  synthesizedText?: string;
  deliveryRequested?: boolean;
  runSessionId?: string;
  runStartedAt?: number;
  deliveryPayloads?: Array<{ text?: string; channelData?: Record<string, unknown> }>;
}) {
  const resolvedDelivery = makeResolvedDelivery();
  return {
    cfg: {} as never,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      deleteAfterRun: false,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main",
    runSessionId: overrides.runSessionId ?? "run-123",
    runStartedAt: overrides.runStartedAt ?? Date.now(),
    runEndedAt: Date.now(),
    timeoutMs: 30_000,
    resolvedDelivery,
    deliveryRequested: overrides.deliveryRequested ?? true,
    skipHeartbeatDelivery: false,
    deliveryBestEffort: false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads:
      overrides.deliveryPayloads ??
      (overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : []),
    synthesizedText: overrides.synthesizedText ?? "on it",
    summary: overrides.synthesizedText ?? "on it",
    outputText: overrides.synthesizedText ?? "on it",
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: makeWithRunSession(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchCronDelivery — double-announce guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCompletedDirectCronDeliveriesForTests();
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(expectsSubagentFollowup).mockReturnValue(false);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("early return (active subagent) sets deliveryAttempted=true so timer skips enqueueSystemEvent", async () => {
    // countActiveDescendantRuns returns >0 → enters wait block; still >0 after wait → early return
    vi.mocked(countActiveDescendantRuns).mockReturnValue(2);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);

    const params = makeBaseParams({ synthesizedText: "on it" });
    const state = await dispatchCronDelivery(params);

    // deliveryAttempted must be true so timer does NOT fire enqueueSystemEvent
    expect(state.deliveryAttempted).toBe(true);

    // Verify timer guard agrees: shouldEnqueueCronMainSummary returns false
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "on it",
        deliveryRequested: true,
        delivered: state.delivered,
        deliveryAttempted: state.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);

    // No announce should have been attempted (subagents still running)
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("early return (stale interim suppression) sets deliveryAttempted=true so timer skips enqueueSystemEvent", async () => {
    // First countActiveDescendantRuns call returns >0 (had descendants), second returns 0
    vi.mocked(countActiveDescendantRuns)
      .mockReturnValueOnce(2) // initial check → hadDescendants=true, enters wait block
      .mockReturnValueOnce(0); // second check after wait → activeSubagentRuns=0
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    // synthesizedText matches initialSynthesizedText & isLikelyInterimCronMessage → stale interim
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);

    const params = makeBaseParams({ synthesizedText: "on it, pulling everything together" });
    const state = await dispatchCronDelivery(params);

    // deliveryAttempted must be true so timer does NOT fire enqueueSystemEvent
    expect(state.deliveryAttempted).toBe(true);

    // Verify timer guard agrees
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "on it, pulling everything together",
        deliveryRequested: true,
        delivered: state.delivered,
        deliveryAttempted: state.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);

    // No direct delivery should have been sent (stale interim suppressed)
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("consolidates descendant output into the final direct delivery", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(
      "Detailed child result, everything finished successfully.",
    );

    const params = makeBaseParams({ synthesizedText: "on it" });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        payloads: [{ text: "Detailed child result, everything finished successfully." }],
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ skipQueue: true }),
    );
  });

  it("normal text delivery sends exactly once and sets deliveryAttempted=true", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "Morning briefing complete." });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);

    // Timer should not fire enqueueSystemEvent (delivered=true)
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "Morning briefing complete.",
        deliveryRequested: true,
        delivered: state.delivered,
        deliveryAttempted: state.deliveryAttempted,
        suppressMainSummary: false,
        isCronSystemEvent: () => true,
      }),
    ).toBe(false);
  });

  it("makes a delivered monitor result the durable parent of an immediate follow-up", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-monitor-delivery-race-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sessionFile = path.join(tempDir, "origin.jsonl");
    const sessionKey = "agent:main:telegram:group:-1001:topic:42";
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "origin-session",
        timestamp: new Date(0).toISOString(),
        cwd: process.cwd(),
      })}\n`,
    );
    SessionManager.open(sessionFile).appendMessage({
      role: "user",
      content: "Tell me when Empower replies.",
      timestamp: 1,
    });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "origin-session",
        sessionFile,
        updatedAt: 1,
      };
    });

    let providerAccepted!: () => void;
    const providerAcceptedPromise = new Promise<void>((resolve) => {
      providerAccepted = resolve;
    });
    let finishProvider!: () => void;
    const finishProviderPromise = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    vi.mocked(deliverOutboundPayloads).mockImplementationOnce(async (params) => {
      // Model Telegram accepting the visible result before the outbound helper
      // appends its mirror. The dispatch layer must still hold the origin lock.
      providerAccepted();
      await finishProviderPromise;
      const mirror = params.mirror;
      expect(mirror).toBeDefined();
      await appendAssistantMessageToSessionTranscript({
        agentId: mirror?.agentId,
        sessionKey: mirror?.sessionKey ?? "",
        text: mirror?.text,
        mediaUrls: mirror?.mediaUrls,
        idempotencyKey: mirror?.idempotencyKey,
        storePath: mirror?.storePath,
      });
      return [{ channel: "telegram", messageId: "monitor-result-1" }];
    });

    try {
      const delivery = dispatchCronDelivery({
        ...makeBaseParams({ synthesizedText: "Empower replied. The draft is ready." }),
        deliveryMirror: {
          agentId: "main",
          sessionKey,
          storePath,
          idempotencyPrefix: "monitor-result:monitor-1:",
        },
      });
      await providerAcceptedPromise;
      const immediateFollowUp = (async () => {
        const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 10_000 });
        try {
          SessionManager.open(sessionFile).appendMessage({
            role: "user",
            content: "send that",
            timestamp: 2,
          });
        } finally {
          await lock.release();
        }
      })();
      finishProvider();
      await expect(delivery).resolves.toMatchObject({ delivered: true });
      await immediateFollowUp;

      // Reopen from disk to model a gateway restart. The live agent sees the
      // monitor result immediately before the unquoted reference.
      const restartedContext = SessionManager.open(sessionFile).buildSessionContext();
      const messages = restartedContext.messages.map((message) => ({
        role: message.role,
        content: JSON.stringify("content" in message ? message.content : undefined),
      }));
      expect(messages.slice(-2)).toEqual([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Empower replied. The draft is ready."),
        }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("send that") }),
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses synthesized text when selected direct delivery payload has no visible content", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({
      synthesizedText: "Alex replied. Draft: 8 or 9 works.",
      deliveryPayloads: [{ text: "", channelData: { telegram: { silentShell: true } } }],
    });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "Alex replied. Draft: 8 or 9 works." }],
      }),
    );
  });

  it("text delivery fires exactly once (no double-deliver)", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Briefing ready." });
    const state = await dispatchCronDelivery(params);

    // Delivery was attempted; direct fallback picked up the slack
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("retries transient direct announce failures before succeeding", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads)
      .mockRejectedValueOnce(new Error("ECONNRESET while sending"))
      .mockResolvedValueOnce([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Retry me once." });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);
  });

  it("keeps direct announce delivery idempotent across replay for the same run session", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Replay-safe cron update." });
    const first = await dispatchCronDelivery(params);
    const second = await dispatchCronDelivery(params);

    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(true);
    expect(second.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("delivers distinct wakes for one durable session while deduping replay of one wake", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const firstWake = makeBaseParams({
      runSessionId: "durable-monitor-session",
      runStartedAt: 1_000,
      synthesizedText: "First monitor wake.",
    });
    const secondWake = makeBaseParams({
      runSessionId: "durable-monitor-session",
      runStartedAt: 2_000,
      synthesizedText: "Second monitor wake.",
    });

    const first = await dispatchCronDelivery(firstWake);
    const second = await dispatchCronDelivery(secondWake);
    const replay = await dispatchCronDelivery(secondWake);

    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(true);
    expect(replay.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);
  });

  it("prunes the completed-delivery cache back to the entry cap", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    for (let i = 0; i < 2003; i += 1) {
      const params = makeBaseParams({
        synthesizedText: `Replay-safe cron update ${i}.`,
        runSessionId: `run-${i}`,
      });
      const state = await dispatchCronDelivery(params);
      expect(state.delivered).toBe(true);
    }

    expect(getCompletedDirectCronDeliveriesCountForTests()).toBe(2000);
  });

  it("does not retry permanent direct announce failures", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockRejectedValue(new Error("chat not found"));

    const params = makeBaseParams({ synthesizedText: "This should fail once." });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(state.result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "Error: chat not found",
        deliveryAttempted: true,
      }),
    );
  });

  it("no delivery requested means deliveryAttempted stays false and no delivery is sent", async () => {
    const params = makeBaseParams({
      synthesizedText: "Task done.",
      deliveryRequested: false,
    });
    const state = await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(state.deliveryAttempted).toBe(false);
  });

  it("text delivery always bypasses the write-ahead queue", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Daily digest ready." });
    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);

    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
        payloads: [{ text: "Daily digest ready." }],
        skipQueue: true,
      }),
    );
  });

  it("structured/thread delivery also bypasses the write-ahead queue", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);

    const params = makeBaseParams({ synthesizedText: "Report attached." });
    // Simulate structured content so useDirectDelivery path is taken (no retryTransient)
    (params as Record<string, unknown>).deliveryPayloadHasStructuredContent = true;
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ skipQueue: true }),
    );
  });

  it("transient retry delivers exactly once with skipQueue on both attempts", async () => {
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    // First call throws a transient error, second call succeeds.
    vi.mocked(deliverOutboundPayloads)
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce([{ ok: true } as never]);

    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    try {
      const params = makeBaseParams({ synthesizedText: "Retry test." });
      const state = await dispatchCronDelivery(params);

      expect(state.delivered).toBe(true);
      expect(state.deliveryAttempted).toBe(true);
      // Two calls total: first failed transiently, second succeeded.
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(2);

      const calls = vi.mocked(deliverOutboundPayloads).mock.calls;
      expect(calls[0][0]).toEqual(expect.objectContaining({ skipQueue: true }));
      expect(calls[1][0]).toEqual(expect.objectContaining({ skipQueue: true }));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
