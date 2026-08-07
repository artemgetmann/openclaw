import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compactEmbeddedPiSession = vi.hoisted(() => vi.fn());
const isEmbeddedPiRunActive = vi.hoisted(() => vi.fn(() => false));
const fixtureRoots = new Set<string>();

vi.mock("../../agents/pi-embedded.js", () => ({
  compactEmbeddedPiSession,
  isEmbeddedPiRunActive,
}));

import type { OpenClawConfig } from "../../config/config.js";
import {
  cancelProactiveCompactionForIncomingTurn,
  PROACTIVE_COMPACTION_IDLE_DELAY_MS,
  resetProactiveCompactionStateForTests,
  resolveProactiveCompactionDecision,
  scheduleProactiveCompactionAfterDelivery,
} from "./proactive-compaction.js";

describe("proactive compaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    compactEmbeddedPiSession.mockReset();
    isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    resetProactiveCompactionStateForTests();
  });

  afterEach(async () => {
    resetProactiveCompactionStateForTests();
    vi.useRealTimers();
    await Promise.all(
      [...fixtureRoots].map((root) => fs.rm(root, { recursive: true, force: true })),
    );
    fixtureRoots.clear();
  });

  it("waits until fresh post-turn usage reaches the conservative threshold", () => {
    expect(
      resolveProactiveCompactionDecision({
        totalTokens: 84_999,
        totalTokensFresh: true,
        contextTokens: 100_000,
      }),
    ).toMatchObject({ shouldCompact: false, reason: "below-threshold" });

    expect(
      resolveProactiveCompactionDecision({
        totalTokens: 85_000,
        totalTokensFresh: true,
        contextTokens: 100_000,
      }),
    ).toMatchObject({ shouldCompact: true, reason: "threshold-reached" });

    expect(
      resolveProactiveCompactionDecision({
        totalTokens: 99_000,
        totalTokensFresh: false,
        contextTokens: 100_000,
      }),
    ).toMatchObject({ shouldCompact: false, reason: "stale-token-count" });
  });

  it("does not compact early when static prompt and tool schemas dominate context", () => {
    expect(
      resolveProactiveCompactionDecision({
        totalTokens: 90_000,
        totalTokensFresh: true,
        contextTokens: 100_000,
        systemPromptReport: {
          systemPrompt: { chars: 240_000 },
          tools: { schemaChars: 80_000 },
        },
      }),
    ).toMatchObject({ shouldCompact: false, reason: "insufficient-conversation-history" });
  });

  it("starts only after the idle window and cancels when a new turn arrives first", async () => {
    const fixture = await createSessionFixture();
    scheduleProactiveCompactionAfterDelivery(fixture.params);

    expect(compactEmbeddedPiSession).not.toHaveBeenCalled();
    expect(cancelProactiveCompactionForIncomingTurn(fixture.sessionKey)).toBe("scheduled");

    await vi.advanceTimersByTimeAsync(PROACTIVE_COMPACTION_IDLE_DELAY_MS + 1);
    expect(compactEmbeddedPiSession).not.toHaveBeenCalled();
  });

  it("aborts running background compaction so an incoming user turn wins", async () => {
    const fixture = await createSessionFixture();
    let observedSignal: AbortSignal | undefined;
    compactEmbeddedPiSession.mockImplementation(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise((resolve) => {
          observedSignal = abortSignal;
          abortSignal?.addEventListener("abort", () =>
            resolve({ ok: false, compacted: false, reason: "aborted" }),
          );
        }),
    );

    scheduleProactiveCompactionAfterDelivery(fixture.params);
    await vi.advanceTimersByTimeAsync(PROACTIVE_COMPACTION_IDLE_DELAY_MS);

    expect(compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(false);
    expect(cancelProactiveCompactionForIncomingTurn(fixture.sessionKey)).toBe("running");
    expect(observedSignal?.aborted).toBe(true);
  });
});

async function createSessionFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proactive-compaction-"));
  fixtureRoots.add(root);
  const sessionsDir = path.join(root, "agents", "main", "sessions");
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agents", "main", "agent");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionId = "session-proactive-test";
  const sessionKey = "agent:main:telegram:dm:123";
  await fs.writeFile(
    storePath,
    JSON.stringify({
      [sessionKey]: {
        sessionId,
        updatedAt: 1_000,
        totalTokens: 90_000,
        totalTokensFresh: true,
        contextTokens: 100_000,
        modelProvider: "openai-codex",
        model: "gpt-5.6-sol",
      },
    }),
  );
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), "");
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    agents: {
      defaults: { workspace: workspaceDir },
      list: [{ id: "main", agentDir }],
    },
  };
  return {
    sessionKey,
    params: {
      cfg,
      agentId: "main",
      sessionKey,
      messageChannel: "telegram",
      messageProvider: "telegram",
    },
  };
}
