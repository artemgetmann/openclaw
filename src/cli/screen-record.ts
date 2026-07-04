import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
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

type ScreenRecordResult = {
  path: string;
  payload: ReturnType<typeof parseScreenRecordPayload>;
  source: "node" | "native-screencapture";
  preflightPath?: string;
  inspected: boolean;
};

type NativeScreencapturePlan = {
  args: string[];
  outPath: string;
  preflightArgs: string[];
  preflightPath: string;
  durationMs: number;
  screenIndex: number;
  hasAudio: boolean;
  format: string;
};

type NativeScreencaptureFallbackContext = {
  env?: NodeJS.ProcessEnv;
  config?: Pick<OpenClawConfig, "gateway">;
};

class ScreenRecordNoLocalNodeError extends Error {
  constructor(nodes: NodeListNode[]) {
    super(formatNoScreenRecordNodeMessage(nodes));
    this.name = "ScreenRecordNoLocalNodeError";
  }
}

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

function formatOperatorCommands(): string {
  return [
    "Run:",
    "  openclaw nodes status --json",
    "  bash -lc 'source scripts/lib/consumer-instance.sh; consumer_instance_apply_runtime_env screen-record-proof; pnpm openclaw:local nodes status --json'",
    "If this is Jarvis macOS proof, relaunch the stable proof fixture:",
    "  OPENCLAW_CONSUMER_STABLE_TCC_IDENTITY=1 npx -y pnpm@10.23.0 exec bash scripts/open-consumer-mac-app.sh --instance screen-record-proof --replace --refresh-gateway",
    "Then grant Screen Recording to the Jarvis/OpenClaw app in System Settings, relaunch it, and retry.",
  ].join("\n");
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

function describeMacScreenPermissionTarget(node: NodeListNode): string {
  const parts = [
    node.bundleIdentifier ? `bundle ${node.bundleIdentifier}` : undefined,
    node.bundlePath ? `app ${node.bundlePath}` : undefined,
    node.executablePath && node.executablePath !== node.bundlePath
      ? `executable ${node.executablePath}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(", ") : node.displayName || node.nodeId;
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

export function formatNoScreenRecordNodeMessage(nodes: NodeListNode[]): string {
  const connectedMacs = nodes.filter(
    (node) => node.connected !== false && isMacNodePlatform(node.platform),
  );
  const eligibleMacs = connectedMacs.filter(
    (node) => !Array.isArray(node.commands) || node.commands.includes("screen.record"),
  );
  if (eligibleMacs.length > 1) {
    return [
      "multiple macOS screen recording nodes available; pass --node",
      formatOperatorCommands(),
    ].join("\n\n");
  }
  if (connectedMacs.length > 0) {
    const targets = connectedMacs.map(describeMacScreenPermissionTarget).join("; ");
    return [
      `no macOS screen recording node available: connected macOS node does not advertise screen.record for ${targets}. This usually means Screen Recording permission is missing, the app was not relaunched after permission changed, or gateway.nodes.allowCommands does not include screen.record.`,
      formatOperatorCommands(),
    ].join("\n\n");
  }

  return [
    "no macOS screen recording node connected. Target-aware app/window recording needs a connected Jarvis/OpenClaw macOS node that advertises screen.record.",
    formatOperatorCommands(),
    'For an explicitly full-display local fallback, rerun with --display <index> --reason "<why full-display capture is acceptable>".',
  ].join("\n\n");
}

export function resolveDefaultScreenRecordNodeOrThrow(nodes: NodeListNode[]): NodeListNode {
  const picked = pickDefaultScreenRecordNode(nodes);
  if (picked) {
    return picked;
  }

  const connectedMacs = nodes.filter(
    (node) => node.connected !== false && isMacNodePlatform(node.platform),
  );
  if (connectedMacs.length === 0) {
    throw new ScreenRecordNoLocalNodeError(nodes);
  }

  throw new Error(formatNoScreenRecordNodeMessage(nodes));
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

function isRemoteGatewaySelectedForCli(
  opts: ScreenRecordCliOpts,
  context: NativeScreencaptureFallbackContext = {},
): boolean {
  if (trimmed(opts.url)) {
    return true;
  }
  const env = context.env ?? process.env;
  if (trimmed(env.OPENCLAW_GATEWAY_URL) || trimmed(env.CLAWDBOT_GATEWAY_URL)) {
    return true;
  }
  const config = context.config ?? loadConfig();
  return config.gateway?.mode === "remote";
}

export function canUseNativeMacScreencaptureFallback(
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
  platform: NodeJS.Platform = process.platform,
  context: NativeScreencaptureFallbackContext = {},
): boolean {
  if (platform !== "darwin" || trimmed(opts.node) || trimmed(opts.url) || trimmed(opts.token)) {
    return false;
  }
  try {
    if (isRemoteGatewaySelectedForCli(opts, context)) {
      return false;
    }
  } catch {
    return false;
  }
  if (trimmed(opts.app) || trimmed(opts.bundle) || trimmed(opts.windowId)) {
    return false;
  }
  if (opts.display === undefined || !trimmed(opts.reason)) {
    return false;
  }
  buildScreenRecordParams(opts, mode);
  return true;
}

export function shouldUseNativeMacScreencaptureFallback(
  err: unknown,
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
  platform: NodeJS.Platform = process.platform,
  context: NativeScreencaptureFallbackContext = {},
): boolean {
  return (
    err instanceof ScreenRecordNoLocalNodeError &&
    canUseNativeMacScreencaptureFallback(opts, mode, platform, context)
  );
}

function fileFormatFromPath(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return ext || "mov";
}

function withPathSuffix(filePath: string, suffix: string): string {
  const ext = path.extname(filePath);
  return path.join(path.dirname(filePath), `${path.basename(filePath, ext)}${suffix}`);
}

export function buildNativeMacScreencapturePlan(
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
): NativeScreencapturePlan {
  const params = buildScreenRecordParams(opts, mode);
  const screenIndex = typeof params.screenIndex === "number" ? params.screenIndex : undefined;
  if (screenIndex === undefined) {
    throw new Error("native screencapture fallback requires --display");
  }
  const durationMs = typeof params.durationMs === "number" ? params.durationMs : 30_000;
  const durationSeconds = Math.max(1, Math.ceil(durationMs / 1000));
  const nativeDisplay = screenIndex + 1;
  const outPath = opts.out ?? screenRecordTempPath({ ext: "mp4" });
  const preflightPath = withPathSuffix(outPath, ".preflight.png");
  const hasAudio = opts.audio === true;
  const args = ["-v", `-V${durationSeconds}`, `-D${nativeDisplay}`, "-C", "-x"];
  if (hasAudio) {
    args.push("-g");
  }
  args.push(outPath);

  return {
    args,
    outPath,
    preflightArgs: ["-x", `-D${nativeDisplay}`, preflightPath],
    preflightPath,
    durationMs,
    screenIndex,
    hasAudio,
    format: fileFormatFromPath(outPath),
  };
}

async function execScreencapture(args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("screencapture", args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(new Error(`screencapture failed${detail}`));
        return;
      }
      resolve();
    });
  });
}

async function assertNonEmptyFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new Error(`${label} was not created or is empty: ${filePath}`);
  }
}

export async function recordNativeMacScreencapture(
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
): Promise<ScreenRecordResult> {
  const plan = buildNativeMacScreencapturePlan(opts, mode);
  await fs.mkdir(path.dirname(plan.outPath), { recursive: true });

  // The still preflight catches missing files/permissions before the longer video
  // capture. It cannot prove the pixels are meaningful, so callers must inspect
  // the final clip before using it as user-facing proof.
  await execScreencapture(plan.preflightArgs, 30_000);
  await assertNonEmptyFile(plan.preflightPath, "screen recording preflight screenshot");

  await execScreencapture(plan.args, plan.durationMs + 30_000);
  await assertNonEmptyFile(plan.outPath, "native screen recording");

  return {
    path: plan.outPath,
    source: "native-screencapture",
    preflightPath: plan.preflightPath,
    inspected: false,
    payload: {
      format: plan.format,
      base64: "",
      durationMs: plan.durationMs,
      screenIndex: plan.screenIndex,
      hasAudio: plan.hasAudio,
    },
  };
}

function explainNodeResolutionFailure(err: unknown): Error {
  const message = String(err instanceof Error ? err.message : err);
  const remediation = message.includes("openclaw nodes status --json")
    ? []
    : ["", formatOperatorCommands()];
  return new Error(
    [
      message,
      "",
      "Screen recorder backend was unavailable. The CLI did not create a proof video.",
      ...remediation,
    ].join("\n"),
  );
}

export async function recordScreenFromNode(
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
): Promise<ScreenRecordResult> {
  const params = buildScreenRecordParams(opts, mode);
  let nodeId: string;
  try {
    nodeId = await resolveScreenRecordNodeId(opts);
  } catch (err) {
    if (shouldUseNativeMacScreencaptureFallback(err, opts, mode)) {
      return await recordNativeMacScreencapture(opts, mode);
    }
    throw explainNodeResolutionFailure(err);
  }
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
  return { path: written.path, payload, source: "node", inspected: false };
}

export async function runScreenRecordCommand(
  label: string,
  opts: ScreenRecordCliOpts,
  mode: ScreenRecordBuildMode,
) {
  await runCommandWithRuntime(
    defaultRuntime,
    async () => {
      const { path, payload, source, preflightPath, inspected } = await recordScreenFromNode(
        opts,
        mode,
      );
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
                source,
                preflightPath,
                inspected,
              },
            },
            null,
            2,
          ),
        );
        return;
      }
      defaultRuntime.log(`MEDIA:${shortenHomePath(path)}`);
      if (source === "native-screencapture") {
        defaultRuntime.log(
          `NOTE:native screencapture fallback used; inspect ${shortenHomePath(
            path,
          )} before calling it proof.`,
        );
      }
    },
    (err) => {
      defaultRuntime.error(`screen ${label} failed: ${String(err)}`);
      defaultRuntime.exit(1);
    },
  );
}
