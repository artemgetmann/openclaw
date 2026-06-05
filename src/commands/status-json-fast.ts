import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL } from "../agents/defaults.js";
import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.js";
import { probeGateway } from "../gateway/probe.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import type { MemoryProviderStatus } from "../memory/types.js";
import { runExec } from "../process/exec.js";
import { getAgentLocalStatuses } from "./status.agent-local.js";
import {
  pickGatewaySelfPresence,
  resolveGatewayProbeAuthResolution,
} from "./status.gateway-probe.js";
import type {
  buildChannelsTable as buildChannelsTableFn,
  collectChannelStatusIssues as collectChannelStatusIssuesFn,
} from "./status.scan.runtime.js";
import type { StatusSummary } from "./status.types.js";
import { getUpdateCheckResult } from "./status.update.js";

type MemoryStatusSnapshot = MemoryProviderStatus & {
  agentId: string;
};

type MemoryPluginStatus = {
  enabled: boolean;
  slot: string | null;
  reason?: string;
};

type GatewayProbeSnapshot = {
  gatewayConnection: GatewayConnectionDetailsSnapshot;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  gatewayProbeAuthWarning?: string;
  gatewayProbe: Awaited<ReturnType<typeof probeGateway>> | null;
};

type GatewayConnectionDetailsSnapshot = {
  url: string;
  urlSource: string;
  bindDetail?: string;
  remoteFallbackNote?: string;
  message: string;
};

export type StatusJsonFastScanResult = {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  secretDiagnostics: string[];
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: Awaited<ReturnType<typeof getUpdateCheckResult>>;
  gatewayConnection: GatewayConnectionDetailsSnapshot;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  gatewayProbeAuthWarning?: string;
  gatewayProbe: Awaited<ReturnType<typeof probeGateway>> | null;
  gatewayReachable: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatuses>>;
  channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
  summary: StatusSummary;
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
};

let configIoModulePromise: Promise<typeof import("../config/io.js")> | undefined;
let gatewayConnectionDetailsModulePromise:
  | Promise<typeof import("../gateway/connection-details.js")>
  | undefined;
let pluginRegistryModulePromise: Promise<typeof import("../cli/plugin-registry.js")> | undefined;
let statusSummaryModulePromise: Promise<typeof import("./status.summary.js")> | undefined;
let statusScanDepsRuntimeModulePromise:
  | Promise<typeof import("./status.scan.deps.runtime.js")>
  | undefined;

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("../cli/plugin-registry.js");
  return pluginRegistryModulePromise;
}

function loadStatusSummaryModule() {
  statusSummaryModulePromise ??= import("./status.summary.js");
  return statusSummaryModulePromise;
}

function loadStatusScanDepsRuntimeModule() {
  statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime.js");
  return statusScanDepsRuntimeModulePromise;
}

function loadConfigIoModule() {
  configIoModulePromise ??= import("../config/io.js");
  return configIoModulePromise;
}

function loadGatewayConnectionDetailsModule() {
  gatewayConnectionDetailsModulePromise ??= import("../gateway/connection-details.js");
  return gatewayConnectionDetailsModulePromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expandHomePrefix(input: string, homeDir: string): string {
  if (input === "~") {
    return homeDir;
  }
  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function resolveHomeDirFast(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim();
  return explicit ? path.resolve(expandHomePrefix(explicit, os.homedir())) : os.homedir();
}

function resolveStateDirFast(env: NodeJS.ProcessEnv): string {
  const homeDir = resolveHomeDirFast(env);
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  return override
    ? path.resolve(expandHomePrefix(override, homeDir))
    : path.join(homeDir, ".openclaw");
}

function resolveConfigCandidatesFast(env: NodeJS.ProcessEnv): string[] {
  const homeDir = resolveHomeDirFast(env);
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return [path.resolve(expandHomePrefix(explicit, homeDir))];
  }
  const stateDir = resolveStateDirFast(env);
  const names = ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"];
  return [
    ...names.map((name) => path.join(stateDir, name)),
    ...[".openclaw", ".clawdbot", ".moldbot", ".moltbot"].flatMap((dir) =>
      names.map((name) => path.join(homeDir, dir, name)),
    ),
  ];
}

function hasConfigFileFast(env: NodeJS.ProcessEnv): boolean {
  return resolveConfigCandidatesFast(env).some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function resolveGatewayPortFast(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return typeof cfg.gateway?.port === "number" && cfg.gateway.port > 0 ? cfg.gateway.port : 18789;
}

function buildDefaultGatewayConnectionDetails(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): GatewayConnectionDetailsSnapshot {
  const port = resolveGatewayPortFast(cfg, env);
  const url = `ws://127.0.0.1:${port}`;
  const configPath = path.join(resolveStateDirFast(env), "openclaw.json");
  return {
    url,
    urlSource: "local loopback",
    bindDetail: "Bind: loopback",
    message: [
      `Gateway target: ${url}`,
      "Source: local loopback",
      `Config: ${configPath}`,
      "Bind: loopback",
    ].join("\n"),
  };
}

function normalizeControlUiBasePathFast(basePath?: string): string {
  if (!basePath) {
    return "";
  }
  let normalized = basePath.trim();
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized === "/") {
    return "";
  }
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function resolveDefaultAgentIdFast(cfg: OpenClawConfig): string {
  const defaultEntry = cfg.agents?.list?.find((entry) => entry?.default) ?? cfg.agents?.list?.[0];
  const id = typeof defaultEntry?.id === "string" ? defaultEntry.id.trim().toLowerCase() : "";
  return id || "main";
}

async function readStatusJsonConfigFast(): Promise<{
  loadedRaw: OpenClawConfig;
  hasConfigFile: boolean;
}> {
  if (!hasConfigFileFast(process.env)) {
    return { loadedRaw: { gateway: {}, session: {} } as OpenClawConfig, hasConfigFile: false };
  }
  const { readBestEffortConfig } = await loadConfigIoModule();
  return { loadedRaw: await readBestEffortConfig(), hasConfigFile: true };
}

function mightContainSecretRef(value: unknown, depth = 0): boolean {
  if (depth > 10) {
    return false;
  }
  if (typeof value === "string") {
    return /^\$\{[A-Z][A-Z0-9_]{0,127}\}$/.test(value.trim());
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    (value.source === "env" || value.source === "file" || value.source === "exec") &&
    typeof value.id === "string"
  ) {
    return true;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Ref") && (typeof child === "string" || isRecord(child))) {
      return true;
    }
    if (mightContainSecretRef(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

async function resolveStatusJsonSecrets(loadedRaw: OpenClawConfig): Promise<{
  resolvedConfig: OpenClawConfig;
  diagnostics: string[];
}> {
  // Most startup-memory checks use plain config with no secret refs. Avoid loading
  // the gateway secret-resolution path unless there is an actual ref to resolve.
  if (!mightContainSecretRef(loadedRaw)) {
    return { resolvedConfig: loadedRaw, diagnostics: [] };
  }
  const [{ resolveCommandSecretRefsViaGateway }, { getStatusCommandSecretTargetIds }] =
    await Promise.all([
      import("../cli/command-secret-gateway.js"),
      import("../cli/command-secret-targets.js"),
    ]);
  return await resolveCommandSecretRefsViaGateway({
    config: loadedRaw,
    commandName: "status --json",
    targetIds: getStatusCommandSecretTargetIds(),
    mode: "read_only_status",
  });
}

function resolveMemoryPluginStatus(cfg: OpenClawConfig): MemoryPluginStatus {
  const pluginsEnabled = cfg.plugins?.enabled !== false;
  if (!pluginsEnabled) {
    return { enabled: false, slot: null, reason: "plugins disabled" };
  }
  const raw = typeof cfg.plugins?.slots?.memory === "string" ? cfg.plugins.slots.memory.trim() : "";
  if (raw && raw.toLowerCase() === "none") {
    return { enabled: false, slot: null, reason: 'plugins.slots.memory="none"' };
  }
  return { enabled: true, slot: raw || "memory-core" };
}

async function resolveGatewayProbeSnapshot(params: {
  cfg: OpenClawConfig;
  hasConfigFile: boolean;
  opts: { timeoutMs?: number; all?: boolean };
}): Promise<GatewayProbeSnapshot> {
  const gatewayConnection = params.hasConfigFile
    ? await loadGatewayConnectionDetailsModule().then(({ buildGatewayConnectionDetails }) =>
        buildGatewayConnectionDetails({ config: params.cfg }),
      )
    : buildDefaultGatewayConnectionDetails(params.cfg, process.env);
  const isRemoteMode = params.cfg.gateway?.mode === "remote";
  const remoteUrlRaw =
    typeof params.cfg.gateway?.remote?.url === "string" ? params.cfg.gateway.remote.url : "";
  const remoteUrlMissing = isRemoteMode && !remoteUrlRaw.trim();
  const gatewayMode = isRemoteMode ? "remote" : "local";
  const gatewayProbeAuthResolution = resolveGatewayProbeAuthResolution(params.cfg);
  let gatewayProbeAuthWarning = gatewayProbeAuthResolution.warning;
  const gatewayProbe = remoteUrlMissing
    ? null
    : await probeGateway({
        url: gatewayConnection.url,
        auth: gatewayProbeAuthResolution.auth,
        timeoutMs: Math.min(params.opts.all ? 5000 : 2500, params.opts.timeoutMs ?? 10_000),
        detailLevel: "presence",
      }).catch(() => null);
  if (gatewayProbeAuthWarning && gatewayProbe?.ok === false) {
    gatewayProbe.error = gatewayProbe.error
      ? `${gatewayProbe.error}; ${gatewayProbeAuthWarning}`
      : gatewayProbeAuthWarning;
    gatewayProbeAuthWarning = undefined;
  }
  return {
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth: gatewayProbeAuthResolution.auth,
    gatewayProbeAuthWarning,
    gatewayProbe,
  };
}

async function resolveMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatuses>>;
  memoryPlugin: MemoryPluginStatus;
}): Promise<MemoryStatusSnapshot | null> {
  const { cfg, agentStatus, memoryPlugin } = params;
  if (!memoryPlugin.enabled) {
    return null;
  }
  if (memoryPlugin.slot !== "memory-core") {
    return null;
  }
  const agentId = agentStatus.defaultId ?? "main";
  const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
  const { manager } = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
  if (!manager) {
    return null;
  }
  try {
    await manager.probeVectorAvailability();
  } catch {}
  const status = manager.status();
  await manager.close?.().catch(() => {});
  return { agentId, ...status };
}

export async function scanStatusJsonFast(opts: {
  timeoutMs?: number;
  all?: boolean;
}): Promise<StatusJsonFastScanResult> {
  const { loadedRaw, hasConfigFile } = await readStatusJsonConfigFast();
  const { resolvedConfig: cfg, diagnostics: secretDiagnostics } =
    await resolveStatusJsonSecrets(loadedRaw);
  if (hasPotentialConfiguredChannels(cfg)) {
    const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
    ensurePluginRegistryLoaded({ scope: "configured-channels" });
  }
  const osSummary = resolveOsSummary();
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const updateTimeoutMs = opts.all ? 6500 : 2500;
  const resolveUpdate = () =>
    getUpdateCheckResult({
      timeoutMs: updateTimeoutMs,
      fetchGit: opts.all === true,
      includeRegistry: opts.all === true,
    });
  const resolveAgentStatus = () => getAgentLocalStatuses(cfg);
  const resolveSummary = () =>
    hasConfigFile || hasPotentialConfiguredChannels(cfg)
      ? loadStatusSummaryModule().then(({ getStatusSummary }) =>
          getStatusSummary({ config: cfg, sourceConfig: loadedRaw }),
        )
      : Promise.resolve({
          runtimeVersion: process.env.npm_package_version ?? null,
          heartbeat: {
            defaultAgentId: resolveDefaultAgentIdFast(cfg),
            agents: [
              {
                agentId: resolveDefaultAgentIdFast(cfg),
                enabled: true,
                every: "1d",
                everyMs: 86_400_000,
              },
            ],
          },
          channelSummary: [],
          queuedSystemEvents: [],
          sessions: {
            paths: [],
            count: 0,
            defaults: { model: DEFAULT_MODEL, contextTokens: DEFAULT_CONTEXT_TOKENS },
            recent: [],
            byAgent: [],
          },
        } satisfies StatusSummary);
  const resolveTailscaleDns = () =>
    tailscaleMode === "off"
      ? Promise.resolve<string | null>(null)
      : loadStatusScanDepsRuntimeModule()
          .then(({ getTailnetHostname }) =>
            getTailnetHostname((cmd, args) =>
              runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }),
            ),
          )
          .catch(() => null);
  const resolveGatewaySnapshot = () => resolveGatewayProbeSnapshot({ cfg, hasConfigFile, opts });

  const [tailscaleDns, update, agentStatus, gatewaySnapshot, summary] = await Promise.all([
    resolveTailscaleDns(),
    resolveUpdate(),
    resolveAgentStatus(),
    resolveGatewaySnapshot(),
    resolveSummary(),
  ]);
  const tailscaleHttpsUrl =
    tailscaleMode !== "off" && tailscaleDns
      ? `https://${tailscaleDns}${normalizeControlUiBasePathFast(cfg.gateway?.controlUi?.basePath)}`
      : null;

  const {
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth,
    gatewayProbeAuthWarning,
    gatewayProbe,
  } = gatewaySnapshot;
  const gatewayReachable = gatewayProbe?.ok === true;
  const gatewaySelf = gatewayProbe?.presence
    ? pickGatewaySelfPresence(gatewayProbe.presence)
    : null;
  const memoryPlugin = resolveMemoryPluginStatus(cfg);
  const memory = opts.all
    ? await resolveMemoryStatusSnapshot({ cfg, agentStatus, memoryPlugin })
    : null;

  return {
    cfg,
    sourceConfig: loadedRaw,
    secretDiagnostics,
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth,
    gatewayProbeAuthWarning,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    channelIssues: [],
    agentStatus,
    channels: { rows: [], details: [] },
    summary: {
      ...summary,
      heartbeat: {
        defaultAgentId: summary.heartbeat.defaultAgentId,
        agents:
          summary.heartbeat.agents.length > 0
            ? summary.heartbeat.agents
            : [{ agentId: agentStatus.defaultId, enabled: true, every: "1d", everyMs: 86_400_000 }],
      },
      sessions: {
        ...summary.sessions,
        paths:
          summary.sessions.paths.length > 0
            ? summary.sessions.paths
            : agentStatus.agents.map((agent) => agent.sessionsPath),
        byAgent:
          summary.sessions.byAgent.length > 0
            ? summary.sessions.byAgent
            : agentStatus.agents.map((agent) => ({
                agentId: agent.id,
                path: agent.sessionsPath,
                count: agent.sessionsCount,
                recent: [],
              })),
      },
    },
    memory,
    memoryPlugin,
  };
}
