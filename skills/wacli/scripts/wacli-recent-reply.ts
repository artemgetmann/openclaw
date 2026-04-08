import path from "node:path";
import {
  decideWacliMonitorBootstrapAction,
  resolvePreferredMonitorChatJid,
} from "../../../src/whatsapp/wacli-monitor.js";
import { findLatestInboundReplyAcrossResolvedChats } from "../../../src/whatsapp/wacli-reconciliation.js";

type Args = {
  dbPath: string;
  json: boolean;
  lastProcessedMsgId: string | null;
  target: string | null;
};

function printUsage(): never {
  console.error(`Usage: wacli-recent-reply.ts --target <phone|jid> [--db <path>] [--json] [--last-processed-msg-id <id>]

Examples:
  node --import tsx skills/wacli/scripts/wacli-recent-reply.ts --target 6281238581815@s.whatsapp.net --json
  node --import tsx skills/wacli/scripts/wacli-recent-reply.ts --target +6281238581815 --last-processed-msg-id inbound-17 --json
  node --import tsx skills/wacli/scripts/wacli-recent-reply.ts --target +6281238581815
`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: path.join(process.env.HOME ?? "~", ".wacli", "wacli.db"),
    json: false,
    lastProcessedMsgId: null,
    target: null,
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--db") {
      args.dbPath = argv[idx + 1] ?? printUsage();
      idx += 1;
      continue;
    }
    if (arg === "--target") {
      args.target = argv[idx + 1] ?? printUsage();
      idx += 1;
      continue;
    }
    if (arg === "--last-processed-msg-id") {
      args.lastProcessedMsgId = argv[idx + 1] ?? printUsage();
      idx += 1;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    printUsage();
  }

  if (!args.target?.trim()) {
    printUsage();
  }

  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = findLatestInboundReplyAcrossResolvedChats({
    dbPath: args.dbPath,
    target: args.target!,
  });
  const preferredMonitorChatJid = resolvePreferredMonitorChatJid(result);
  const bootstrapDecision = decideWacliMonitorBootstrapAction({
    lastProcessedMsgId: args.lastProcessedMsgId,
    lookup: result,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ...result,
          preferredMonitorChatJid,
          monitorBootstrapDecision: bootstrapDecision,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Target: ${result.target}`);
  console.log(`Seed JIDs: ${result.seedJids.join(", ") || "(none)"}`);
  console.log(`Identity names: ${result.identityNames.join(", ") || "(none)"}`);
  console.log(`Preferred monitor chat: ${preferredMonitorChatJid}`);
  console.log(`Bootstrap decision: ${bootstrapDecision.action} (${bootstrapDecision.reason})`);
  console.log("Candidates:");
  for (const candidate of result.candidates) {
    const name = candidate.name ? ` (${candidate.name})` : "";
    console.log(`- ${candidate.jid}${name} [${candidate.reasons.join(", ")}]`);
  }
  if (!result.latestInboundReply) {
    console.log("Latest inbound reply: none");
    return;
  }
  console.log("Latest inbound reply:");
  console.log(`- chat: ${result.latestInboundReply.chatJid}`);
  console.log(`- sender: ${result.latestInboundReply.senderJid ?? "(unknown)"}`);
  console.log(`- ts: ${result.latestInboundReply.ts}`);
  console.log(`- media: ${result.latestInboundReply.mediaType ?? "(none)"}`);
  console.log(`- effective text: ${result.latestInboundReply.effectiveText ?? "(empty)"}`);
}

main();
