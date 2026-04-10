import { SessionManager } from "@mariozechner/pi-coding-agent";
import { prepareSessionManagerForRun } from "../agents/pi-embedded-runner/session-manager-init.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath, updateSessionStore, type SessionEntry } from "../config/sessions.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

function buildMonitorBootstrapPrompt(params: {
  instructions: string;
  sourceType: string;
  sourceTarget: Record<string, unknown>;
  cadence: unknown;
  stopCondition?: string;
  expiryAt?: string;
  actionPolicy: string;
  originSessionKey: string;
}) {
  // Seed the monitor session with the durable task contract once so later cron
  // wakes can stay tiny and resume the same conversation instead of
  // reconstructing monitor intent from scratch.
  const lines = [
    "You are a durable monitor task.",
    "Treat future wake messages as the same monitor session continuing the same task.",
    `Task: ${params.instructions.trim()}`,
    "",
    "Monitor metadata:",
    `- sourceType: ${params.sourceType}`,
    `- sourceTarget: ${JSON.stringify(params.sourceTarget)}`,
    `- cadence: ${JSON.stringify(params.cadence)}`,
    `- actionPolicy: ${params.actionPolicy}`,
    `- originSessionKey: ${params.originSessionKey}`,
    "- defaultRoute: origin chat",
    ...(params.stopCondition?.trim() ? [`- stopCondition: ${params.stopCondition.trim()}`] : []),
    ...(params.expiryAt?.trim() ? [`- expiryAt: ${params.expiryAt.trim()}`] : []),
    "",
    "Use normal OpenClaw tools and skills to fetch fresh source state on each wake.",
    "Do not treat the watched source as the default delivery destination.",
  ];
  return lines.join("\n");
}

export async function seedMonitorSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  label: string;
  instructions: string;
  sourceType: string;
  sourceTarget: Record<string, unknown>;
  cadence: unknown;
  stopCondition?: string;
  expiryAt?: string;
  actionPolicy: string;
  originSessionKey: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const sessionStore: Record<string, SessionEntry> = {};
  const entry: SessionEntry = {
    sessionId: params.sessionId,
    updatedAt: Date.now(),
    label: params.label,
  };

  await updateSessionStore(storePath, (store) => {
    sessionStore[params.sessionKey] = store[params.sessionKey] = {
      ...store[params.sessionKey],
      ...entry,
    };
  });

  const resolved = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: sessionStore[params.sessionKey],
    sessionStore,
    storePath,
    agentId: params.agentId,
  });
  const sessionFile = resolved.sessionFile;
  const hadSessionFile = await import("node:fs/promises").then((fs) =>
    fs
      .access(sessionFile)
      .then(() => true)
      .catch(() => false),
  );
  const sessionManager = SessionManager.open(sessionFile);
  await prepareSessionManagerForRun({
    sessionManager,
    sessionFile,
    hadSessionFile,
    sessionId: params.sessionId,
    cwd: process.cwd(),
  });
  sessionManager.appendMessage({
    role: "user",
    content: buildMonitorBootstrapPrompt({
      instructions: params.instructions,
      sourceType: params.sourceType,
      sourceTarget: params.sourceTarget,
      cadence: params.cadence,
      stopCondition: params.stopCondition,
      expiryAt: params.expiryAt,
      actionPolicy: params.actionPolicy,
      originSessionKey: params.originSessionKey,
    }),
    timestamp: Date.now(),
  });
  emitSessionTranscriptUpdate(sessionFile);
}
