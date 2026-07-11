import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../../test-utils/env.js";
import {
  ackDurableFollowup,
  hydrateDurableFollowup,
  loadDurableFollowups,
  persistDurableFollowup,
} from "./durable-store.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const settings: QueueSettings = {
  mode: "followup",
  debounceMs: 0,
  cap: 20,
  dropPolicy: "summarize",
};

function createRun(prompt = "queued while busy"): FollowupRun {
  return {
    prompt,
    messageId: "telegram:101",
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    originatingTo: "-100123",
    originatingAccountId: "default",
    originatingThreadId: 42,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:group:-100123:topic:42",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {},
      provider: "test",
      model: "test",
      timeoutMs: 30_000,
      blockReplyBreak: "message_end",
    },
  };
}

describe("durable followup queue", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let stateDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-followup-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("atomically persists a complete replay record", async () => {
    const key = `durable-success-${Date.now()}`;
    const record = await persistDurableFollowup({ queueKey: key, run: createRun(), settings });
    const loaded = await loadDurableFollowups();
    expect(loaded).toEqual([record]);
    expect(loaded[0]?.run.durableId).toBe(record.id);
  });

  it("never writes config secrets and hydrates replay from current config", async () => {
    const run = createRun();
    run.run.config = { channels: { telegram: { botToken: "super-secret-token" } } };
    const record = await persistDurableFollowup({ queueKey: "sanitized", run, settings });
    const files = await fs.readdir(path.join(stateDir, "followup-queue"));
    const raw = await fs.readFile(path.join(stateDir, "followup-queue", files[0] ?? ""), "utf8");
    expect(raw).not.toContain("super-secret-token");
    expect(raw).not.toContain("botToken");

    const currentConfig = { channels: { telegram: { enabled: true } } };
    expect(hydrateDurableFollowup(record, currentConfig).run.config).toBe(currentConfig);
  });

  it("rejects a failed durable write so callers cannot acknowledge transport input", async () => {
    const notADirectory = path.join(stateDir, "state-file");
    await fs.writeFile(notADirectory, "not a directory");
    process.env.OPENCLAW_STATE_DIR = notADirectory;

    await expect(
      persistDurableFollowup({ queueKey: "failed", run: createRun(), settings }),
    ).rejects.toThrow();
  });

  it("deletes stale records instead of replaying old user intent", async () => {
    await persistDurableFollowup({
      queueKey: "stale",
      settings,
      run: createRun(),
      now: 100,
      ttlMs: 1,
    });

    await expect(loadDurableFollowups({ now: 102 })).resolves.toEqual([]);
    await expect(loadDurableFollowups({ now: 102 })).resolves.toEqual([]);
  });

  it("keeps a record across reloads until the successful drain explicitly acknowledges it", async () => {
    const record = await persistDurableFollowup({
      queueKey: "reload",
      settings,
      run: createRun("survive restart"),
    });

    await expect(loadDurableFollowups()).resolves.toEqual([record]);
    await expect(loadDurableFollowups()).resolves.toEqual([record]);
    await ackDurableFollowup(record.id);
    await expect(loadDurableFollowups()).resolves.toEqual([]);
  });
});
