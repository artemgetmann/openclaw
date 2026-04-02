import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { findLatestInboundReplyAcrossResolvedChats } from "./wacli-reconciliation.js";

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wacli-reconcile-"));
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
          ('6281238581815@s.whatsapp.net', 'dm', 'GYMNASIUM BALI', 1775039816),
          ('235317080666280@lid', 'unknown', 'GYMNASIUM BALI', 1775039860);
        INSERT INTO messages (
          chat_jid, chat_name, msg_id, sender_jid, sender_name, ts, from_me, text, display_text, media_type, media_caption
        ) VALUES
          (
            '6281238581815@s.whatsapp.net',
            'GYMNASIUM BALI',
            'outbound-1',
            NULL,
            NULL,
            1775039816,
            1,
            'Hi. I’m staying nearby and considering joining for a month.',
            'Hi. I’m staying nearby and considering joining for a month.',
            NULL,
            NULL
          ),
          (
            '235317080666280@lid',
            'GYMNASIUM BALI',
            'inbound-1',
            '235317080666280:61@lid',
            'GYMNASIUM BALI',
            1775039860,
            0,
            '',
            'Sent image',
            'image',
            ''
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
  // No global state should leak across tests.
});

describe("findLatestInboundReplyAcrossResolvedChats", () => {
  it("resolves opaque @lid sibling chats from DB-backed identity evidence", async () => {
    await withTempDb(async (dbPath) => {
      const result = findLatestInboundReplyAcrossResolvedChats({
        dbPath,
        target: "6281238581815@s.whatsapp.net",
      });

      expect(result.seedJids).toContain("6281238581815@s.whatsapp.net");
      expect(result.candidates.map((candidate) => candidate.jid)).toEqual([
        "6281238581815@s.whatsapp.net",
        "235317080666280@lid",
      ]);
      expect(result.candidates[1]?.reasons).toContain("matching-name");
      expect(result.candidates.map((candidate) => candidate.jid)).not.toContain(
        "6281238581815@lid",
      );
    });
  });

  it("treats inbound media rows as valid replies even when text and caption are empty", async () => {
    await withTempDb(async (dbPath) => {
      const result = findLatestInboundReplyAcrossResolvedChats({
        dbPath,
        target: "6281238581815@s.whatsapp.net",
      });

      expect(result.latestInboundReply?.chatJid).toBe("235317080666280@lid");
      expect(result.latestInboundReply?.mediaType).toBe("image");
      expect(result.latestInboundReply?.hasRenderableContent).toBe(true);
      expect(result.latestInboundReply?.effectiveText).toBe("Sent image");
    });
  });
});
