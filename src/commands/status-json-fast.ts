import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { readBestEffortConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.js";
import { buildGatewayConnectionDetails } from "../gateway/connection-details.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
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
  gatewayConnection: ReturnType<typeof buildGatewayConnectionDetails>;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  gatewayProbeAuthWarning?: string;
  gatewayProbe: Awaited<ReturnType<typeof probeGateway>> | null;
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
  gatewayConnection: ReturnType<typeof buildGatewayConnectionDetails>;
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

function traceStartupMemory(label: string): void {
  if (process.env.OPENCLAW_STARTUP_MEMORY_TRACE !== "1") {
    return;
  }
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  process.stderr.write(`[startup-memory-trace] ${label}: ${rssMb.toFixed(1)} MB RSS\n`);
}

function shouldTraceStartupMemory(): boolean {
  return process.env.OPENCLAW_STARTUP_MEMORY_TRACE === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  opts: { timeoutMs?: number; all?: boolean };
}): Promise<GatewayProbeSnapshot> {
  const gatewayConnection = buildGatewayConnectionDetails({ config: params.cfg });
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
  const loadedRaw = await readBestEffortConfig();
  traceStartupMemory("after config");
  const { resolvedConfig: cfg, diagnostics: secretDiagnostics } =
    await resolveStatusJsonSecrets(loadedRaw);
  traceStartupMemory("after secret resolution");
  if (hasPotentialConfiguredChannels(cfg)) {
    const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
    ensurePluginRegistryLoaded({ scope: "configured-channels" });
    traceStartupMemory("after plugin registry");
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
    loadStatusSummaryModule().then(({ getStatusSummary }) =>
      getStatusSummary({ config: cfg, sourceConfig: loadedRaw }),
    );
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
  const resolveGatewaySnapshot = () => resolveGatewayProbeSnapshot({ cfg, opts });

  const [tailscaleDns, update, agentStatus, gatewaySnapshot, summary] = shouldTraceStartupMemory()
    ? [
        await resolveTailscaleDns().then((value) => {
          traceStartupMemory("after tailscale");
          return value;
        }),
        await resolveUpdate().then((value) => {
          traceStartupMemory("after update");
          return value;
        }),
        await resolveAgentStatus().then((value) => {
          traceStartupMemory("after agent status");
          return value;
        }),
        await resolveGatewaySnapshot().then((value) => {
          traceStartupMemory("after gateway probe");
          return value;
        }),
        await resolveSummary().then((value) => {
          traceStartupMemory("after summary");
          return value;
        }),
      ]
    : await Promise.all([
        resolveTailscaleDns(),
        resolveUpdate(),
        resolveAgentStatus(),
        resolveGatewaySnapshot(),
        resolveSummary(),
      ]);
  traceStartupMemory("after parallel status probes");
  const tailscaleHttpsUrl =
    tailscaleMode !== "off" && tailscaleDns
      ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}`
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
  traceStartupMemory("after memory status");

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
    summary,
    memory,
    memoryPlugin,
  };
}
