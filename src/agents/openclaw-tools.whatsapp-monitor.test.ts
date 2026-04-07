import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const ORIGINAL_HOME = process.env.HOME;

function getWhatsAppMonitorTool() {
  const tool = createOpenClawTools().find((candidate) => candidate.name === "whatsapp_monitor");
  if (!tool) {
    throw new Error("missing whatsapp_monitor tool");
  }
  return tool;
}

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-monitor-tool-"));
  const dbPath = path.join(root, "wacli.db");
  try {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT,
          last_message_ts INTEGER
        );
        CREATE TABLE contacts (
          jid TEXT PRIMARY KEY,
          phone TEXT,
          push_name TEXT,
          full_name TEXT,
          first_name TEXT,
          business_name TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE contact_aliases (
          jid TEXT PRIMARY KEY,
          alias TEXT NOT NULL,
          notes TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_jid TEXT NOT NULL,
          chat_name TEXT,
          msg_id TEXT NOT NULL,
          sender_jid TEXT,
          sender_name TEXT,
          ts INTEGER NOT NULL,
          from_me INTEGER NOT NULL,
          text TEXT,
          display_text TEXT,
          media_type TEXT,
          media_caption TEXT
        );
      `);

      db.exec(`
        INSERT INTO chats (jid, kind, name, last_message_ts) VALUES
          ('6281315419230@s.whatsapp.net', 'dm', 'Dana Recruiter', 1775039816),
          ('206876293779512@lid', 'unknown', 'Dana Recruiter', 1775039860);
        INSERT INTO messages (
          chat_jid, chat_name, msg_id, sender_jid, sender_name, ts, from_me, text, display_text, media_type, media_caption
        ) VALUES
          (
            '6281315419230@s.whatsapp.net',
            'Dana Recruiter',
            'outbound-1',
            NULL,
            NULL,
            1775039816,
            1,
            'Hi Dana, following up on the schedule.',
            'Hi Dana, following up on the schedule.',
            NULL,
            NULL
          ),
          (
            '206876293779512@lid',
            'Dana Recruiter',
            'inbound-1',
            '206876293779512:61@lid',
            'Dana Recruiter',
            1775039860,
            0,
            'Hello sure at 8pm',
            'Hello sure at 8pm',
            NULL,
            NULL
          );
      `);
    } finally {
      db.close();
    }

    await run(dbPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
    return;
  }
  process.env.HOME = ORIGINAL_HOME;
});

describe("whatsapp_monitor tool", () => {
  it("returns the latest inbound reply across @lid sibling chats", async () => {
    await withTempDb(async (dbPath) => {
      const tool = getWhatsAppMonitorTool();
      const result = await tool.execute("call-whatsapp-monitor", {
        target: "6281315419230",
        dbPath,
      });

      const body = result.details as {
        candidates: Array<{ jid: string }>;
        latestInboundReply: { chatJid: string; effectiveText: string | null } | null;
      };
      expect(body.candidates.map((candidate) => candidate.jid)).toEqual([
        "6281315419230@s.whatsapp.net",
        "206876293779512@lid",
      ]);
      expect(body.latestInboundReply?.chatJid).toBe("206876293779512@lid");
      expect(body.latestInboundReply?.effectiveText).toBe("Hello sure at 8pm");
    });
  });

  it("defaults to ~/.wacli/wacli.db when dbPath is omitted", async () => {
    await withTempDb(async (dbPath) => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-monitor-home-"));
      process.env.HOME = tempHome;
      const storeDir = path.join(tempHome, ".wacli");
      await fs.mkdir(storeDir, { recursive: true });
      await fs.copyFile(dbPath, path.join(storeDir, "wacli.db"));

      const tool = getWhatsAppMonitorTool();
      const result = await tool.execute("call-whatsapp-monitor-home-default", {
        target: "6281315419230@s.whatsapp.net",
      });

      const body = result.details as {
        latestInboundReply: { effectiveText: string | null } | null;
      };
      expect(body.latestInboundReply?.effectiveText).toBe("Hello sure at 8pm");

      await fs.rm(tempHome, { recursive: true, force: true });
    });
  });
});
