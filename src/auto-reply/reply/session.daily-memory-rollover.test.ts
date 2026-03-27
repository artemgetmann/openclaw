import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: async () => ({ release: async () => {} }),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-rollover-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeSessionStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
}

async function writeTranscript(params: {
  filePath: string;
  sessionId: string;
  messages: Array<{ role: "user" | "assistant"; text: string; timestamp: number }>;
}) {
  await fs.mkdir(path.dirname(params.filePath), { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: params.sessionId,
      timestamp: new Date(params.messages[0]?.timestamp ?? Date.now()).toISOString(),
      cwd: process.cwd(),
    }),
    ...params.messages.map((message) =>
      JSON.stringify({
        type: "message",
        timestamp: message.timestamp,
        message: {
          role: message.role,
          content: message.text,
        },
      }),
    ),
  ];
  await fs.writeFile(params.filePath, `${lines.join("\n")}\n`, "utf-8");
}

describe("initSessionState daily memory rollover", () => {
  it("writes one personal daily snapshot and rotates the triggering session after the boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-27T05:30:00"));

    const root = await makeCaseDir("openclaw-daily-rollover-");
    const workspaceDir = path.join(root, "workspace");
    const sessionsDir = path.join(root, "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    const personalSessionId = "personal-session";
    const sharedSessionId = "shared-session";
    const personalSessionFile = path.join(sessionsDir, `${personalSessionId}.jsonl`);
    const sharedSessionFile = path.join(sessionsDir, `${sharedSessionId}.jsonl`);
    const boundaryDay = new Date("2026-03-26T09:15:00").getTime();
    await writeTranscript({
      filePath: personalSessionFile,
      sessionId: personalSessionId,
      messages: [
        {
          role: "user",
          text: "We decided the deploy rollback rule stays manual.",
          timestamp: boundaryDay,
        },
        {
          role: "assistant",
          text: "I documented the rollback rule and the tester bot plan.",
          timestamp: boundaryDay + 60_000,
        },
      ],
    });
    await writeTranscript({
      filePath: sharedSessionFile,
      sessionId: sharedSessionId,
      messages: [
        {
          role: "user",
          text: "Shared room note that must not land in personal memory.",
          timestamp: boundaryDay + 120_000,
        },
      ],
    });
    await writeSessionStore(storePath, {
      "agent:main:telegram:dm:owner": {
        sessionId: personalSessionId,
        updatedAt: new Date("2026-03-26T23:30:00").getTime(),
        sessionFile: personalSessionFile,
        chatType: "direct",
        memoryScope: "personal",
      },
      "agent:main:telegram:group:shared": {
        sessionId: sharedSessionId,
        updatedAt: new Date("2026-03-26T20:00:00").getTime(),
        sessionFile: sharedSessionFile,
        chatType: "group",
        memoryScope: "shared",
      },
    });

    const cfg = {
      session: {
        store: storePath,
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Morning",
        SessionKey: "agent:main:telegram:dm:owner",
        ChatType: "direct",
      },
      cfg,
      commandAuthorized: true,
      workspaceDir,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.previousSessionEntry?.sessionId).toBe(personalSessionId);
    expect(result.sessionEntry.sessionId).not.toBe(personalSessionId);

    const memoryFile = path.join(workspaceDir, "memory", "2026-03-26.md");
    const memoryContent = await fs.readFile(memoryFile, "utf-8");
    expect(memoryContent).toContain("Auto Snapshot 2026-03-26");
    expect(memoryContent).toContain("rollback rule stays manual");
    expect(memoryContent).not.toContain("Shared room note");
  });
});
