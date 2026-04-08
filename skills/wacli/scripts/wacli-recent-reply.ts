import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideWacliMonitorBootstrapAction,
  resolvePreferredMonitorChatJid,
} from "../../../src/whatsapp/wacli-monitor.js";
import { findLatestInboundReplyAcrossResolvedChats } from "../../../src/whatsapp/wacli-reconciliation.js";

type Args = {
  dbPath: string;
  json: boolean;
  lastProcessedMsgId: string | null;
  stateFile: string | null;
  target: string | null;
};

type MonitorState = {
  lastProcessedMsgId?: string;
  msgId?: string;
  ts?: number;
};

type RecentReplyCliResult = Awaited<ReturnType<typeof buildRecentReplyCliResult>>;

function printUsage(): never {
  console.error(`Usage: wacli-recent-reply.ts --target <phone|jid> [--db <path>] [--json] [--state-file <path>] [--last-processed-msg-id <id>]

Examples:
  node --import tsx skills/wacli/scripts/wacli-recent-reply.ts --target 6281238581815@s.whatsapp.net --json
  node --import tsx skills/wacli/scripts/wacli-recent-reply.ts --target +6281238581815 --last-processed-msg-id inbound-17 --json
  node --import tsx skills/wacli/scripts/wacli-recent-reply.ts --target +6281238581815 --state-file /tmp/wacli-monitor-state.json --json
  node --import tsx skills/wacli/scripts/wacli-recent-reply.ts --target +6281238581815
`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: path.join(process.env.HOME ?? "~", ".wacli", "wacli.db"),
    json: false,
    lastProcessedMsgId: null,
    stateFile: null,
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
    if (arg === "--state-file") {
      args.stateFile = argv[idx + 1] ?? printUsage();
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

async function readMonitorState(stateFile: string): Promise<MonitorState | null> {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as MonitorState;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeMonitorState(
  stateFile: string,
  payload: { lastProcessedMsgId: string; ts: number },
): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(
    stateFile,
    `${JSON.stringify(
      {
        lastProcessedMsgId: payload.lastProcessedMsgId,
        msgId: payload.lastProcessedMsgId,
        ts: payload.ts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function buildRecentReplyCliResult(args: Args): Promise<{
  target: string;
  seedJids: string[];
  seedPhones: string[];
  identityNames: string[];
  candidates: Awaited<ReturnType<typeof findLatestInboundReplyAcrossResolvedChats>>["candidates"];
  latestInboundReply: Awaited<
    ReturnType<typeof findLatestInboundReplyAcrossResolvedChats>
  >["latestInboundReply"];
  preferredMonitorChatJid: string;
  monitorBootstrapDecision: ReturnType<typeof decideWacliMonitorBootstrapAction>;
  monitorStatus?: "new_message" | "no_change";
  status?: "new_message" | "no_change";
  stateFile?: string | null;
}> {
  const result = findLatestInboundReplyAcrossResolvedChats({
    dbPath: args.dbPath,
    target: args.target!,
  });
  const preferredMonitorChatJid = resolvePreferredMonitorChatJid(result);
  const persistedState = args.stateFile ? await readMonitorState(args.stateFile) : null;
  const effectiveLastProcessedMsgId =
    persistedState?.lastProcessedMsgId ?? persistedState?.msgId ?? args.lastProcessedMsgId;
  const bootstrapDecision = decideWacliMonitorBootstrapAction({
    lastProcessedMsgId: effectiveLastProcessedMsgId,
    lookup: result,
  });
  const monitorStatus = args.stateFile
    ? bootstrapDecision.action === "process-latest"
      ? "new_message"
      : "no_change"
    : undefined;

  if (
    args.stateFile &&
    bootstrapDecision.action === "process-latest" &&
    result.latestInboundReply
  ) {
    await writeMonitorState(args.stateFile, {
      lastProcessedMsgId: result.latestInboundReply.msgId,
      ts: result.latestInboundReply.ts,
    });
  }

  return {
    ...result,
    preferredMonitorChatJid,
    monitorBootstrapDecision: bootstrapDecision,
    monitorStatus,
    status: monitorStatus,
    stateFile: args.stateFile,
  };
}

function printHumanResult(result: RecentReplyCliResult): void {
  console.log(`Target: ${result.target}`);
  console.log(`Seed JIDs: ${result.seedJids.join(", ") || "(none)"}`);
  console.log(`Identity names: ${result.identityNames.join(", ") || "(none)"}`);
  console.log(`Preferred monitor chat: ${result.preferredMonitorChatJid}`);
  console.log(
    `Bootstrap decision: ${result.monitorBootstrapDecision.action} (${result.monitorBootstrapDecision.reason})`,
  );
  if (result.stateFile) {
    console.log(`Monitor status: ${result.monitorStatus ?? result.status ?? "no_change"}`);
    console.log(`State file: ${result.stateFile}`);
  }
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildRecentReplyCliResult(args);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ...result,
          ...(args.stateFile ? { monitorStatus: result.monitorStatus, status: result.status } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  printHumanResult(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
