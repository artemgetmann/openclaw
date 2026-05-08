import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  buildSendArgs,
  parseSendReceipt,
  runOwnerSafeSend,
  verifyAcceptedSendInLocalHistory,
  type Flags,
} from "../skills/wacli/scripts/wacli-send-safe.ts";
import { requireNodeSqlite } from "../src/memory/sqlite.js";

function makeFlags(overrides: Partial<Flags> = {}): Flags {
  return {
    command: "text",
    json: false,
    storeDir: "/tmp/wacli-store",
    to: "+15555550123",
    message: "hello",
    timeoutMs: 1_000,
    settleMs: 1_000,
    graceMs: 1_000,
    ...overrides,
  } as Flags;
}

async function createTempStore(): Promise<{ root: string; db: DatabaseSync }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wacli-send-safe-"));
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(root, "wacli.db"));
  db.exec(`
    CREATE TABLE messages (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      from_me INTEGER NOT NULL,
      text TEXT
    );
  `);
  return { root, db };
}

describe("wacli-send-safe", () => {
  it("builds the raw wacli send args for text", () => {
    expect(buildSendArgs(makeFlags())).toEqual([
      "--store",
      "/tmp/wacli-store",
      "send",
      "text",
      "--to",
      "+15555550123",
      "--message",
      "hello",
    ]);
  });

  it("builds the raw wacli send args for file", () => {
    expect(
      buildSendArgs(
        makeFlags({
          command: "file",
          file: "/tmp/report.pdf",
          caption: "agenda",
          message: undefined,
        }),
      ),
    ).toEqual([
      "--store",
      "/tmp/wacli-store",
      "send",
      "file",
      "--to",
      "+15555550123",
      "--file",
      "/tmp/report.pdf",
      "--caption",
      "agenda",
    ]);
  });

  it("pauses and restores the recorded owner around a send", async () => {
    const calls: Array<[string, string[]]> = [];
    let statusCalls = 0;
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      calls.push([command, args]);
      if (args[0] === "status") {
        statusCalls += 1;
        if (statusCalls === 1) {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              ownerRunning: true,
              ownerCommandMatches: true,
              lockHeldByOwner: true,
              connected: true,
            }),
            stderr: "",
            timedOut: false,
          };
        }
        if (statusCalls === 2) {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              ownerRunning: false,
              ownerCommandMatches: true,
              lockHeldByOwner: false,
              connected: false,
            }),
            stderr: "",
            timedOut: false,
          };
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: true,
            ownerCommandMatches: true,
            lockHeldByOwner: true,
            connected: true,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      if (args[0] === "stop") {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: false,
            ownerCommandMatches: true,
            lockHeldByOwner: false,
            connected: false,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      if (args[0] === "ensure") {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: true,
            ownerCommandMatches: true,
            lockHeldByOwner: true,
            connected: true,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: "Sent to 48100060180533@lid (id 3BEC123)",
        stderr: "",
        timedOut: false,
      };
    });
    const verifySend = vi.fn(async () => ({
      status: "verified_local" as const,
      chatJid: "48100060180533@lid",
      messageId: "3BEC123",
    }));

    const report = await runOwnerSafeSend(makeFlags(), {
      runCommand,
      sleep: async () => undefined,
      verifySend,
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe("sent_with_owner_restored");
    expect(report.verification.status).toBe("verified_local");
    expect(report.message).toContain("accepted the WhatsApp text");
    expect(report.message).toContain("verified it in local history");
    expect(report.ownerPaused).toBe(true);
    expect(report.ownerRestored).toBe(true);
    expect(calls.map(([, args]) => (args[0] === "--store" ? args[2] : args[0]))).toEqual([
      "status",
      "stop",
      "status",
      "send",
      "ensure",
      "status",
    ]);
  });

  it("sends directly when no recorded owner is running", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "status") {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: false,
            ownerCommandMatches: false,
            lockHeldByOwner: false,
            connected: false,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: "Sent to 48100060180533@lid (id 3BEC123)",
        stderr: "",
        timedOut: false,
      };
    });
    const verifySend = vi.fn(async () => ({
      status: "unverified" as const,
      chatJid: "48100060180533@lid",
      messageId: "3BEC123",
      reason: "No matching outbound row found in /tmp/wacli-store/wacli.db.",
    }));

    const report = await runOwnerSafeSend(makeFlags(), {
      runCommand,
      sleep: async () => undefined,
      verifySend,
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe("sent");
    expect(report.verification.status).toBe("unverified");
    expect(report.message).toContain("Accepted WhatsApp text");
    expect(report.message).toContain("not verified in local history");
    expect(report.message).toContain("wa.me fallback");
    expect(report.ownerPaused).toBe(false);
    expect(report.ownerRestored).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("parses accepted send receipts from human and JSON wacli output", () => {
    expect(parseSendReceipt("Sent to 48100060180533@lid (id 3BECDEADBEEF)")).toEqual({
      chatJid: "48100060180533@lid",
      messageId: "3BECDEADBEEF",
    });
    expect(
      parseSendReceipt('{ "sent": true, "to": "48100060180533@lid", "id": "ABC123" }'),
    ).toEqual({
      chatJid: "48100060180533@lid",
      messageId: "ABC123",
    });
  });

  it("verifies an accepted send against the local wacli history DB", async () => {
    const store = await createTempStore();
    try {
      store.db
        .prepare(
          `INSERT INTO messages (chat_jid, msg_id, from_me, text)
           VALUES (?, ?, 1, ?)`,
        )
        .run("48100060180533@lid", "3BEC123", "hello");

      const verification = await verifyAcceptedSendInLocalHistory({
        storeDir: store.root,
        stdout: "Sent to 48100060180533@lid (id 3BEC123)",
        stderr: "",
      });

      expect(verification).toEqual({
        status: "verified_local",
        chatJid: "48100060180533@lid",
        messageId: "3BEC123",
      });
    } finally {
      store.db.close();
      await fs.rm(store.root, { recursive: true, force: true });
    }
  });

  it("keeps accepted sends successful when local history cannot verify them", async () => {
    const store = await createTempStore();
    try {
      const verification = await verifyAcceptedSendInLocalHistory({
        storeDir: store.root,
        stdout: '{ "sent": true, "to": "48100060180533@lid", "id": "missing-id" }',
        stderr: "",
      });

      expect(verification.status).toBe("unverified");
      expect(verification.chatJid).toBe("48100060180533@lid");
      expect(verification.messageId).toBe("missing-id");
      expect(verification.reason).toContain("No matching outbound row found");
    } finally {
      store.db.close();
      await fs.rm(store.root, { recursive: true, force: true });
    }
  });
});
