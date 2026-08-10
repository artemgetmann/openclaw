import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions.js";
import { buildMonitorBootstrapPrompt, seedMonitorSession } from "./session.js";
import { CODEX_THREAD_UNARCHIVE_RESUME_ACTION } from "./types.js";

const tempDirs: string[] = [];

function createSessionFile(params: { sessionFile: string; sessionId: string }) {
  // SessionManager appends in memory when a file has not been initialized yet.
  // Production origin transcripts already have this header; create the same
  // durable shape here so the branch helper exercises the real disk path.
  fs.writeFileSync(
    params.sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: process.cwd(),
    })}\n`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("monitor bootstrap contract", () => {
  it("branches a new monitor from the origin chat transcript", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-monitor-context-"));
    tempDirs.push(tempDir);
    const storePath = path.join(tempDir, "sessions.json");
    const originSessionKey = "agent:main:telegram:group:-1001:topic:42";
    const monitorSessionKey = "agent:main:monitor:monitor-1";
    const originSessionId = "origin-session";
    const originSessionFile = path.join(tempDir, `${originSessionId}.jsonl`);
    createSessionFile({ sessionFile: originSessionFile, sessionId: originSessionId });
    const originManager = SessionManager.open(originSessionFile);
    originManager.appendMessage({
      role: "user",
      content: "The boarding pass is attached in Telegram message 123.",
      timestamp: 1,
    });
    originManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "I have the boarding pass reference." }],
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
      timestamp: 2,
    });
    await updateSessionStore(storePath, (store) => {
      store[originSessionKey] = {
        sessionId: originSessionId,
        sessionFile: originSessionFile,
        updatedAt: 1,
        totalTokens: 50,
      };
    });

    await seedMonitorSession({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      monitorId: "monitor-1",
      sessionKey: monitorSessionKey,
      sessionId: "unused-fresh-session",
      label: "Monitor: AirAsia",
      instructions: "Watch AirAsia for a reply and continue the case.",
      sourceType: "gmail",
      sourceTarget: { account: "owner@example.com", threadId: "airasia" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_only",
      watchDeliveryConfigured: false,
      originSessionKey,
    });

    const monitorEntry = loadSessionStore(storePath, { skipCache: true })[monitorSessionKey];
    expect(monitorEntry?.forkedFromParent).toBe(true);
    expect(monitorEntry?.sessionId).not.toBe("unused-fresh-session");
    const context = SessionManager.open(monitorEntry?.sessionFile ?? "").buildSessionContext();
    expect(context.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "The boarding pass is attached in Telegram message 123.",
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("You are a durable monitor task."),
        }),
      ]),
    );
  });

  it("starts fresh when the origin context exceeds the configured fork limit", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-monitor-limit-"));
    tempDirs.push(tempDir);
    const storePath = path.join(tempDir, "sessions.json");
    const originSessionKey = "agent:main:telegram:direct:user-1";
    const originSessionFile = path.join(tempDir, "large-origin.jsonl");
    createSessionFile({ sessionFile: originSessionFile, sessionId: "large-origin" });
    const originManager = SessionManager.open(originSessionFile);
    originManager.appendMessage({
      role: "user",
      content: "Large prior context",
      timestamp: 1,
    });
    originManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Acknowledged." }],
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
      timestamp: 2,
    });
    await updateSessionStore(storePath, (store) => {
      store[originSessionKey] = {
        sessionId: "large-origin",
        sessionFile: originSessionFile,
        updatedAt: 1,
        totalTokens: 101,
      };
    });

    await seedMonitorSession({
      cfg: { session: { store: storePath, parentForkMaxTokens: 100 } } as OpenClawConfig,
      agentId: "main",
      monitorId: "monitor-large",
      sessionKey: "agent:main:monitor:monitor-large",
      sessionId: "fresh-monitor-session",
      label: "Monitor: bounded",
      instructions: "Watch the case.",
      sourceType: "gmail",
      sourceTarget: { account: "owner@example.com", threadId: "case" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_only",
      watchDeliveryConfigured: false,
      originSessionKey,
    });

    const monitorEntry = loadSessionStore(storePath, { skipCache: true })[
      "agent:main:monitor:monitor-large"
    ];
    expect(monitorEntry?.sessionId).toBe("fresh-monitor-session");
    expect(monitorEntry?.forkedFromParent).not.toBe(true);
    const monitorEntries = SessionManager.open(monitorEntry?.sessionFile ?? "").getEntries();
    expect(
      monitorEntries.some(
        (entry) => entry.type === "custom" && entry.customType === "monitor-origin-sync-cursor",
      ),
    ).toBe(false);
  });

  it("includes the exact approved continuation prompt in the seeded session", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Watch for the release.",
      sourceType: "github-release",
      sourceTarget: { repo: "artemgetmann/openclaw" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_only",
      authority: {
        schemaVersion: 1,
        grantId: "grant-1",
        goalId: "goal-1",
        purposeKey: "release-proof",
        action: {
          kind: CODEX_THREAD_UNARCHIVE_RESUME_ACTION,
          threadId: "thread-release-proof",
          prompt: "Run the deferred release proof exactly once.",
        },
        idempotencyKey: "release-proof-1",
        expiresAt: "2026-08-31T00:00:00.000Z",
        stopCondition: "Stop after one accepted continuation.",
        maxExecutions: 1,
        grantedAtMs: 1,
        execution: { status: "available", executions: 0 },
        audit: [{ event: "granted", atMs: 1 }],
      },
      watchDeliveryConfigured: false,
      originSessionKey: "agent:main:main",
    });

    expect(prompt).toContain(
      'Authorized continuation prompt (use exactly): "Run the deferred release proof exactly once."',
    );
  });

  it("requires the actual requested draft for notify_draft completion", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Quote the matching inbound text and draft the next response for approval.",
      sourceType: "whatsapp",
      sourceTarget: { target: "+971552857036" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_draft",
      watchDeliveryConfigured: false,
      originSessionKey: "agent:main:telegram:group:-1003783709877:topic:21581",
    });

    expect(prompt).toContain("explicitly requires a draft");
    expect(prompt).toContain("must include the actual draft text");
    expect(prompt).toContain("status-only completion is incomplete");
  });

  it("does not impose a draft requirement on notify_only", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Report whether a matching reply arrived.",
      sourceType: "whatsapp",
      sourceTarget: { target: "+971552857036" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_only",
      watchDeliveryConfigured: false,
      originSessionKey: "agent:main:main",
    });

    expect(prompt).not.toContain("status-only completion is incomplete");
  });

  it("requires fresh external confirmation before completing an external outcome", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Keep coordinating until the appointment is confirmed.",
      sourceType: "custom-service",
      sourceTarget: { thread: "appointment-1" },
      cadence: { kind: "every", everyMs: 300_000 },
      stopCondition: "The counterparty confirms the appointment.",
      actionPolicy: "auto_send",
      watchDeliveryConfigured: true,
      originSessionKey: "agent:main:main",
    });

    expect(prompt).toContain("require fresh external evidence confirming that outcome");
    expect(prompt).toContain(
      "Your own outbound proposal, acceptance, or follow-up is not evidence that the external outcome was achieved",
    );
  });

  it("preserves goal autonomy when watched-surface delivery is unavailable", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Keep the ticket moving.",
      sourceType: "custom-service",
      sourceTarget: { thread: "ticket-1" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "auto_send",
      goal: {
        id: "goal-1",
        objective: "Resolve the ticket.",
        autonomy: {
          level: "act_within_scope",
          allowedActions: ["use the service skill to post approved follow-ups"],
          approvalRequired: ["change the requested outcome"],
        },
      },
      watchDeliveryConfigured: false,
      originSessionKey: "agent:main:main",
    });

    expect(prompt).toContain("Goal autonomy: act_within_scope.");
    expect(prompt).toContain("Only the delivery adapter is unavailable");
    expect(prompt).toContain("Use an available normal tool or skill path");
    expect(prompt).toContain("preserve every approval-required boundary");
    expect(prompt).toContain("notificationEvent set to unchanged");
    expect(prompt).toContain("deadline_passed");
  });

  it("guides WhatsApp auto_send monitors through one safe wacli send", () => {
    const prompt = buildMonitorBootstrapPrompt({
      instructions: "Coordinate the exact allowed dinner time with this friend.",
      sourceType: "whatsapp",
      sourceTarget: { target: "74333133234289@lid" },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "auto_send",
      watchDeliveryConfigured: true,
      originSessionKey: "agent:main:telegram:direct:user-1",
    });

    expect(prompt).toContain("WhatsApp-as-me watched-surface delivery is authorized");
    expect(prompt).toContain("use the wacli skill/CLI");
    expect(prompt).toContain("safe-send helper");
    expect(prompt).toContain("After a successful WhatsApp-as-me send");
    expect(prompt).toContain("return exactly NO_REPLY");
  });
});
