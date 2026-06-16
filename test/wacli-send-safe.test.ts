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
    lockWaitMs: 1_000,
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
      ts INTEGER NOT NULL DEFAULT 0,
      text TEXT,
      display_text TEXT,
      media_caption TEXT
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

  it("treats a stale dead lock as released and restores the owner around a send", async () => {
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
              lockPidRunning: true,
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
              lockPid: 123,
              lockPidRunning: false,
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
            lockPidRunning: true,
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
            stoppedPid: 123,
            pidFileRemoved: true,
            lockPidRunning: false,
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

  it("restores the owner even when a live unrelated lock blocks the send", async () => {
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
              lockPidRunning: true,
              connected: true,
            }),
            stderr: "",
            timedOut: false,
          };
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: false,
            ownerCommandMatches: true,
            lockHeldByOwner: false,
            lockPid: 999,
            lockPidRunning: true,
            connected: false,
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
            lockPidRunning: true,
            stoppedPid: 123,
            pidFileRemoved: true,
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
            lockPidRunning: true,
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

    expect(report.ok).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.ownerPaused).toBe(false);
    expect(report.ownerRestored).toBe(true);
    expect(report.message).toContain("Failed to pause the recorded wacli sync owner");
    expect(verifySend).not.toHaveBeenCalled();
    expect(calls.map(([, args]) => (args[0] === "--store" ? args[2] : args[0]))).toEqual([
      "status",
      "stop",
      "status",
      "ensure",
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

  it("serializes concurrent safe sends for the same store", async () => {
    const store = await createTempStore();
    let activeSends = 0;
    let maxActiveSends = 0;
    const sendStarts: number[] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
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

      activeSends += 1;
      maxActiveSends = Math.max(maxActiveSends, activeSends);
      sendStarts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 35));
      activeSends -= 1;
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

    try {
      const [first, second] = await Promise.all([
        runOwnerSafeSend(makeFlags({ storeDir: store.root }), {
          runCommand,
          verifySend,
        }),
        runOwnerSafeSend(makeFlags({ storeDir: store.root }), {
          runCommand,
          verifySend,
        }),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(maxActiveSends).toBe(1);
      expect(sendStarts[1] - sendStarts[0]).toBeGreaterThanOrEqual(25);
    } finally {
      store.db.close();
      await fs.rm(store.root, { recursive: true, force: true });
    }
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

  it("reconciles a failed raw send when one exact outbound DB row exists", async () => {
    const store = await createTempStore();
    const message = "please send me Marina's contact";
    try {
      const runCommand = vi.fn(async (_command: string, args: string[]) => {
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

        store.db
          .prepare(
            `INSERT INTO messages (chat_jid, msg_id, from_me, ts, text)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run(
            "41796713221@s.whatsapp.net",
            "3EB0FALSE_NEGATIVE",
            Math.floor(Date.now() / 1000),
            message,
          );
        return {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: true,
        };
      });

      const report = await runOwnerSafeSend(
        makeFlags({
          storeDir: store.root,
          to: "+41 79 671 32 21",
          message,
        }),
        { runCommand },
      );

      expect(report.ok).toBe(true);
      expect(report.send.timedOut).toBe(true);
      expect(report.verification).toEqual({
        status: "verified_local_after_failed_exit",
        chatJid: "41796713221@s.whatsapp.net",
        messageId: "3EB0FALSE_NEGATIVE",
        reason:
          "Raw wacli send failed or timed out, but exactly one matching outbound row was found in local history.",
      });
      expect(report.message).toContain("did not exit cleanly");
    } finally {
      store.db.close();
      await fs.rm(store.root, { recursive: true, force: true });
    }
  });

  it("keeps failed raw sends unverified when local DB reconciliation is ambiguous", async () => {
    const store = await createTempStore();
    const message = "duplicate outbound";
    try {
      for (const msgId of ["first", "second"]) {
        store.db
          .prepare(
            `INSERT INTO messages (chat_jid, msg_id, from_me, ts, text)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run("41796713221@s.whatsapp.net", msgId, Math.floor(Date.now() / 1000), message);
      }

      const verification = await verifyAcceptedSendInLocalHistory({
        storeDir: store.root,
        stdout: "",
        stderr: "",
        to: "+41 79 671 32 21",
        command: "text",
        message,
        startedAtMs: Date.now() - 1_000,
        endedAtMs: Date.now(),
        allowTargetTextFallback: true,
      });

      expect(verification.status).toBe("unverified");
      expect(verification.reason).toContain("Multiple matching outbound rows");
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
