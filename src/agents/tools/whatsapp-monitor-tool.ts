import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveUserPath, shortenHomePath } from "../../utils.js";
import { findLatestInboundReplyAcrossResolvedChats } from "../../whatsapp/wacli-reconciliation.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readStringParam } from "./common.js";

const WhatsAppMonitorToolSchema = Type.Object({
  target: Type.String({
    description:
      "Phone number or WhatsApp JID to reconcile (for example +6281315419230 or 6281315419230@s.whatsapp.net).",
  }),
  dbPath: Type.Optional(
    Type.String({
      description: "Optional path to wacli.db. Overrides storeDir when set.",
    }),
  ),
  storeDir: Type.Optional(
    Type.String({
      description: "Optional wacli store dir. Defaults to ~/.wacli when dbPath is omitted.",
    }),
  ),
});

function resolveWacliDbPath(params: { dbPath?: string; storeDir?: string }): string {
  // Monitor runs need deterministic chat discovery. Default to the operator's
  // local wacli store, but let callers override either the db file or store
  // root for multi-store/debug cases.
  if (params.dbPath?.trim()) {
    return resolveUserPath(params.dbPath);
  }
  const storeDir = resolveUserPath(params.storeDir?.trim() || "~/.wacli");
  return path.join(storeDir, "wacli.db");
}

export function createWhatsAppMonitorTool(): AnyAgentTool {
  return {
    label: "WhatsApp Monitor",
    name: "whatsapp_monitor",
    ownerOnly: true,
    description:
      "Resolve WhatsApp monitor targets across phone-JID and opaque @lid sibling chats using local wacli.db evidence. Use this for reply watches instead of relying on single-chat phone queries.",
    parameters: WhatsAppMonitorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const target = readStringParam(params, "target", { required: true, label: "target" });
      const dbPath = resolveWacliDbPath({
        dbPath: readStringParam(params, "dbPath"),
        storeDir: readStringParam(params, "storeDir"),
      });

      if (!fs.existsSync(dbPath)) {
        throw new ToolInputError(`wacli db not found: ${shortenHomePath(dbPath)}`);
      }

      const result = findLatestInboundReplyAcrossResolvedChats({
        dbPath,
        target,
      });
      return jsonResult(result);
    },
  };
}
