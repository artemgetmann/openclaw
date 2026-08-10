import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSessionWriteLock } from "../agents/session-write-lock.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions.js";
import { syncOriginContextIntoMonitor } from "./context-sync.js";
import { seedMonitorSession } from "./session.js";
import { createMonitorRecord } from "./store.js";

const tempDirs: string[] = [];

function createSessionFile(sessionFile: string, sessionId: string): SessionManager {
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: process.cwd(),
    })}\n`,
  );
  return SessionManager.open(sessionFile);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("monitor conversation context sync", () => {
  it("imports only later origin turns and advances a durable cursor", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-monitor-sync-"));
    tempDirs.push(tempDir);
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const originSessionKey = "agent:main:telegram:group:-1001:topic:42";
    const monitorSessionKey = "agent:main:monitor:monitor-sync";
    const originFile = path.join(tempDir, "origin.jsonl");
    const originManager = createSessionFile(originFile, "origin-session");
    originManager.appendMessage({ role: "user", content: "Initial case context", timestamp: 1 });
    originManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "I am watching the case." }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    await updateSessionStore(storePath, (store) => {
      store[originSessionKey] = {
        sessionId: "origin-session",
        sessionFile: originFile,
        updatedAt: 1,
      };
    });
    await seedMonitorSession({
      cfg,
      agentId: "main",
      monitorId: "monitor-sync",
      sessionKey: monitorSessionKey,
      sessionId: "monitor-session",
      label: "Monitor: sync",
      instructions: "Watch the case.",
      sourceType: "gmail",
      sourceTarget: { threadId: "case" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_only",
      watchDeliveryConfigured: false,
      originSessionKey,
    });
    const monitor = createMonitorRecord(
      {
        monitorId: "monitor-sync",
        agentId: "main",
        instructions: "Watch the case.",
        originSessionKey,
        monitorSessionKey,
        sourceType: "gmail",
        sourceTarget: { threadId: "case" },
        cadence: { kind: "every", everyMs: 300_000 },
        cronJobId: "cron-sync",
      },
      1,
    );

    // Model an active live turn: its user message exists, but the assistant
    // response has not landed and the interactive runner still owns the lock.
    const liveTurnLock = await acquireSessionWriteLock({ sessionFile: originFile });
    SessionManager.open(originFile).appendMessage({
      role: "user",
      content: [
        { type: "text", text: "Use the newer Empower address." },
        { type: "image", data: "raw-base64-must-not-copy", mimeType: "image/jpeg" },
      ],
      timestamp: 2,
    });
    let syncFinished = false;
    const syncDuringLiveTurn = syncOriginContextIntoMonitor({ cfg, monitor }).then((result) => {
      syncFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(syncFinished).toBe(false);
    SessionManager.open(originFile).appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "I will use the newer address." }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
    });
    await liveTurnLock.release();

    await expect(syncDuringLiveTurn).resolves.toEqual({
      ok: true,
      imported: 2,
    });
    await expect(syncOriginContextIntoMonitor({ cfg, monitor })).resolves.toEqual({
      ok: true,
      imported: 0,
    });
    const monitorEntry = loadSessionStore(storePath, { skipCache: true })[monitorSessionKey];
    const entriesAfterFirstSync = SessionManager.open(monitorEntry?.sessionFile ?? "").getEntries()
      .length;
    await expect(syncOriginContextIntoMonitor({ cfg, monitor })).resolves.toEqual({
      ok: true,
      imported: 0,
    });
    expect(SessionManager.open(monitorEntry?.sessionFile ?? "").getEntries()).toHaveLength(
      entriesAfterFirstSync,
    );
    const context = SessionManager.open(monitorEntry?.sessionFile ?? "").buildSessionContext();
    const serialized = JSON.stringify(context.messages);
    expect(serialized).toContain("Use the newer Empower address.");
    expect(serialized).toContain("[image attachment]");
    expect(serialized).not.toContain("raw-base64-must-not-copy");
    expect(serialized.match(/Use the newer Empower address\./g)).toHaveLength(1);

    const oversizedText = `${"A".repeat(12_050)}OVERSIZED_TAIL`;
    SessionManager.open(originFile).appendMessage({
      role: "user",
      content: oversizedText,
      timestamp: 4,
    });
    SessionManager.open(originFile).appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Oversized turn acknowledged." }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 5,
    });
    const monitorWriteLock = await acquireSessionWriteLock({
      sessionFile: monitorEntry?.sessionFile ?? "",
    });
    let targetSyncFinished = false;
    const syncBehindMonitorWriter = syncOriginContextIntoMonitor({ cfg, monitor }).then(
      (result) => {
        targetSyncFinished = true;
        return result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(targetSyncFinished).toBe(false);
    await monitorWriteLock.release();
    await expect(syncBehindMonitorWriter).resolves.toEqual({
      ok: true,
      imported: 1,
    });
    await expect(syncOriginContextIntoMonitor({ cfg, monitor })).resolves.toEqual({
      ok: true,
      imported: 2,
    });
    const resumedContext = SessionManager.open(
      monitorEntry?.sessionFile ?? "",
    ).buildSessionContext();
    const resumedSerialized = JSON.stringify(resumedContext.messages);
    expect(resumedSerialized).toContain("OVERSIZED_TAIL");
    expect(resumedSerialized).toContain("Oversized turn acknowledged.");

    // A reset may rotate the origin mapping while sync is queued behind the
    // previous transcript. The wake must retry the current transcript instead
    // of reporting success with stale pre-reset context.
    const preResetLock = await acquireSessionWriteLock({ sessionFile: originFile });
    let resetSyncFinished = false;
    const syncAcrossReset = syncOriginContextIntoMonitor({ cfg, monitor }).then((result) => {
      resetSyncFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(resetSyncFinished).toBe(false);
    const rotatedOriginFile = path.join(tempDir, "origin-after-reset.jsonl");
    const rotatedOriginManager = createSessionFile(rotatedOriginFile, "origin-session-after-reset");
    rotatedOriginManager.appendMessage({
      role: "user",
      content: "Send the result to Empower after the reset.",
      timestamp: 6,
    });
    rotatedOriginManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "I will use the current conversation." }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 7,
    });
    await updateSessionStore(storePath, (store) => {
      store[originSessionKey] = {
        sessionId: "origin-session-after-reset",
        sessionFile: rotatedOriginFile,
        updatedAt: 6,
      };
    });
    expect(loadSessionStore(storePath, { skipCache: true })[originSessionKey]?.sessionFile).toBe(
      rotatedOriginFile,
    );
    expect(SessionManager.open(rotatedOriginFile).buildSessionContext().messages).toHaveLength(2);
    await preResetLock.release();
    await expect(syncAcrossReset).resolves.toEqual({ ok: true, imported: 2 });
    const resetSerialized = JSON.stringify(
      SessionManager.open(monitorEntry?.sessionFile ?? "").buildSessionContext().messages,
    );
    expect(resetSerialized).toContain("Send the result to Empower after the reset.");
  });
});
