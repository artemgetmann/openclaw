import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { parseNodeList } from "../shared/node-list-parse.js";
import { shortenHomePath } from "../utils.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import {
  buildNodeInvokeParams,
  callGatewayCli,
  nodesCallOpts,
  resolveNodeId,
} from "./nodes-cli/rpc.js";
import type { NodeListNode } from "./nodes-cli/types.js";
import {
  parseScreenRecordPayload,
  screenRecordTempPath,
  writeScreenRecordToFile,
} from "./nodes-screen.js";
import { parseDurationMs } from "./parse-duration.js";

export type ScreenRecordCliOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  app?: string;
  bundle?: string;
  windowId?: string;
  screen?: string;
  display?: string;
  reason?: string;
  duration?: string;
  fps?: string;
  audio?: boolean;
  out?: string;
  invokeTimeout?: string;
};

type ScreenRecordBuildMode = {
  requireTarget: boolean;
  requireDisplayReason: boolean;
};

export function registerScreenRecordCallOptions(cmd: Command) {
  return nodesCallOpts(cmd, { timeoutMs: 180_000 });
}

function parseOptionalNumber(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const text = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : undefined;
  if (!text) {
    return undefined;
  }
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return parsed;
}

function parseOptionalInt(raw: unknown, label: string): number | undefined {
  const parsed = parseOptionalNumber(raw, label);
  if (parsed === undefined) {
    return undefined;
  }
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

function parseWindowId(raw: unknown): number | undefined {
  const windowId = parseOptionalInt(raw, "--window-id");
  if (windowId === undefined) {
    return undefined;
  }
  if (windowId < 0 || windowId > 4_294_967_295) {
    throw new Error("--window-id must be between 0 and 4294967295");
  }
  return windowId;
}

function trimmed(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}

export function buildScreenRecordParams(
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
): Record<string, unknown> {
  const appName = trimmed(opts.app);
  const bundleId = trimmed(opts.bundle);
  const windowId = parseWindowId(opts.windowId);
  const display = parseOptionalInt(
    opts.display ?? opts.screen,
    opts.display ? "--display" : "--screen",
  );
  const reason = trimmed(opts.reason);
  const explicitTargets = [
    appName,
    bundleId,
    windowId,
    opts.display !== undefined ? display : undefined,
  ].filter((value) => value !== undefined);

  if (mode.requireTarget && explicitTargets.length === 0) {
    throw new Error(
      "target required: pass --app, --bundle, --window-id, or --display with --reason",
    );
  }
  if (explicitTargets.length > 1) {
    throw new Error("choose one recording target: --app, --bundle, --window-id, or --display");
  }
  if (mode.requireDisplayReason && opts.display !== undefined && !reason) {
    throw new Error(
      "--display requires --reason because full-display recording can capture unrelated windows",
    );
  }

  const durationMs = opts.duration ? parseDurationMs(opts.duration) : 30_000;
  const fps = parseOptionalNumber(opts.fps ?? "12", "--fps");

  return {
    durationMs,
    fps,
    format: "mp4",
    includeAudio: opts.audio === true,
    screenIndex: display,
    appName,
    bundleId,
    windowId,
  };
}

function isMacNodePlatform(platform: string | undefined): boolean {
  const normalized = platform?.trim().toLowerCase() ?? "";
  return normalized === "darwin" || normalized.startsWith("macos") || normalized.startsWith("mac ");
}

export function pickDefaultScreenRecordNode(nodes: NodeListNode[]): NodeListNode | null {
  const capable = nodes.filter((node) => {
    if (node.connected === false) {
      return false;
    }
    return !Array.isArray(node.commands) || node.commands.includes("screen.record");
  });
  const localMacs = capable.filter((node) => isMacNodePlatform(node.platform));
  if (localMacs.length === 1) {
    return localMacs[0] ?? null;
  }
  return null;
}

export function resolveDefaultScreenRecordNodeOrThrow(nodes: NodeListNode[]): NodeListNode {
  const picked = pickDefaultScreenRecordNode(nodes);
  if (picked) {
    return picked;
  }

  const connectedMacs = nodes.filter(
    (node) => node.connected !== false && isMacNodePlatform(node.platform),
  );
  const eligibleMacs = connectedMacs.filter(
    (node) => !Array.isArray(node.commands) || node.commands.includes("screen.record"),
  );
  if (eligibleMacs.length > 1) {
    throw new Error("multiple macOS screen recording nodes available; pass --node");
  }
  if (connectedMacs.length > 0) {
    throw new Error(
      "no macOS screen recording node available: connected macOS node does not advertise screen.record. Enable Screen Recording for Jarvis/OpenClaw in System Settings, relaunch the app, then retry.",
    );
  }

  throw new Error("node required");
}

export async function resolveScreenRecordNodeId(opts: ScreenRecordCliOpts): Promise<string> {
  const query = trimmed(opts.node);
  if (query) {
    return resolveNodeId(opts, query);
  }
  const result = await callGatewayCli("node.list", opts, {});
  const nodes = parseNodeList(result);
  return resolveDefaultScreenRecordNodeOrThrow(nodes).nodeId;
}

export async function recordScreenFromNode(
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
): Promise<{ path: string; payload: ReturnType<typeof parseScreenRecordPayload> }> {
  const params = buildScreenRecordParams(opts, mode);
  const nodeId = await resolveScreenRecordNodeId(opts);
  const timeoutMs = opts.invokeTimeout
    ? Number.parseInt(String(opts.invokeTimeout), 10)
    : undefined;
  const raw = await callGatewayCli(
    "node.invoke",
    opts,
    buildNodeInvokeParams({
      nodeId,
      command: "screen.record",
      params,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    }),
    { transportTimeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined },
  );
  const res = typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
  const payload = parseScreenRecordPayload(res.payload);
  const filePath = opts.out ?? screenRecordTempPath({ ext: payload.format || "mp4" });
  const written = await writeScreenRecordToFile(filePath, payload.base64);
  return { path: written.path, payload };
}

export async function runScreenRecordCommand(
  label: string,
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
) {
  await runCommandWithRuntime(
    defaultRuntime,
    async () => {
      const { path, payload } = await recordScreenFromNode(opts, mode);
      if (opts.json) {
        defaultRuntime.log(
          JSON.stringify(
            {
              file: {
                path,
                durationMs: payload.durationMs,
                fps: payload.fps,
                screenIndex: payload.screenIndex,
                appName: payload.appName,
                bundleId: payload.bundleId,
                windowId: payload.windowId,
                hasAudio: payload.hasAudio,
              },
            },
            null,
            2,
          ),
        );
        return;
      }
      defaultRuntime.log(`MEDIA:${shortenHomePath(path)}`);
    },
    (err) => {
      defaultRuntime.error(`screen ${label} failed: ${String(err)}`);
      defaultRuntime.exit(1);
    },
  );
}
