import type { Command } from "commander";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { callGateway } from "../../../src/gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../src/utils/message-channel.js";
import type {
  CodexDurableCallbackInput,
  CodexDurableCallbackStatus,
} from "./callback-route-registry.js";

type CallbackGatewayParams = CodexDurableCallbackInput & {
  routeId: string;
  capability: string;
  sourceThreadId: string;
};

type CallbackCliOptions = {
  routeId: string;
  capability: string;
  callbackId: string;
  sequence: string;
  status: string;
  message: string;
  changedFile: string[];
  proof: string[];
  nextAction?: string;
  workContinues?: string;
};

type RegisterCodexCallbackCliOptions = {
  program: Command;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  send?: (config: OpenClawConfig, params: CallbackGatewayParams) => Promise<unknown>;
  print?: (line: string) => void;
};

/**
 * Register the callback command used inside native Codex turns.
 *
 * Routing identity is deliberately split: the prompt supplies the narrow
 * route capability while CODEX_THREAD_ID comes from the native Codex process.
 * Model-authored text therefore cannot redirect a callback to another thread.
 */
export function registerCodexCallbackCli(options: RegisterCodexCallbackCliOptions): void {
  const send = options.send ?? sendCallbackToGateway;
  const print =
    options.print ??
    ((line: string) => {
      // This is the worker-visible delivery receipt. It never includes the
      // capability or broader Gateway authentication material.
      // eslint-disable-next-line no-console
      console.log(line);
    });
  const env = options.env ?? process.env;

  options.program
    .command("codex-callback")
    .description("Send a scoped native Codex status message back to Jarvis")
    .requiredOption("--route-id <id>", "Durable Jarvis callback route")
    .requiredOption("--capability <token>", "Scoped callback capability")
    .requiredOption("--callback-id <id>", "Stable id for this logical callback")
    .requiredOption("--sequence <number>", "Next monotonic callback sequence")
    .requiredOption("--status <status>", "progress, blocked, decision-needed, or complete")
    .requiredOption("--message <text>", "Natural-language callback message")
    .option("--changed-file <path>", "Changed file (repeatable)", collect, [])
    .option("--proof <text>", "Proof item (repeatable)", collect, [])
    .option("--next-action <text>", "Next useful action")
    .option("--work-continues <boolean>", "Whether safe work continues")
    .action(async (raw: CallbackCliOptions) => {
      const sourceThreadId = env.CODEX_THREAD_ID?.trim();
      if (!sourceThreadId) {
        throw new Error("CODEX_THREAD_ID is required for a scoped Jarvis callback");
      }
      const params: CallbackGatewayParams = {
        routeId: required(raw.routeId, "routeId"),
        capability: required(raw.capability, "capability"),
        sourceThreadId,
        callbackId: required(raw.callbackId, "callbackId"),
        sequence: positiveInteger(raw.sequence, "sequence"),
        status: callbackStatus(raw.status),
        message: required(raw.message, "message", true),
        ...(raw.changedFile.length > 0 ? { changedFiles: raw.changedFile } : {}),
        ...(raw.proof.length > 0 ? { proof: raw.proof } : {}),
        ...(raw.nextAction ? { nextAction: raw.nextAction } : {}),
        ...(raw.workContinues === undefined
          ? {}
          : { workContinues: booleanValue(raw.workContinues, "workContinues") }),
      };
      const result = await send(options.config, params);
      print(JSON.stringify(result));
    });
}

async function sendCallbackToGateway(
  config: OpenClawConfig,
  params: CallbackGatewayParams,
): Promise<unknown> {
  return await callGateway({
    config,
    method: "codex.callback",
    params,
    timeoutMs: 5 * 60 * 1_000,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function required(value: string, field: string, preserveWhitespace = false): string {
  if (!value?.trim()) {
    throw new Error(`${field} is required`);
  }
  return preserveWhitespace ? value : value.trim();
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function callbackStatus(value: string): CodexDurableCallbackStatus {
  if (
    value === "progress" ||
    value === "blocked" ||
    value === "decision-needed" ||
    value === "complete"
  ) {
    return value;
  }
  throw new Error("status must be progress, blocked, decision-needed, or complete");
}

function booleanValue(value: string, field: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${field} must be true or false`);
}
