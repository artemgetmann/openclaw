import {
  createConfigIO,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../../config/config.js";
import type {
  OpenClawConfig,
  GatewayBindMode,
  GatewayControlUiConfig,
} from "../../config/types.js";
import {
  PUBLIC_JARVIS_GATEWAY_LAUNCHD_LABEL,
  resolveConsumerRuntimeIdentity,
} from "../../consumer/runtime-identity.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../../daemon/constants.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import { findExtraGatewayServices } from "../../daemon/inspect.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import { auditGatewayServiceConfig } from "../../daemon/service-audit.js";
import { resolveGatewayRuntimeIdentityEnv } from "../../daemon/service-env.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { isGatewaySecretRefUnavailableError, trimToUndefined } from "../../gateway/credentials.js";
import { resolveGatewayBindHost } from "../../gateway/net.js";
import { resolveGatewayProbeAuthWithSecretInputs } from "../../gateway/probe-auth.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import {
  formatPortDiagnostics,
  inspectPortUsage,
  type PortListener,
  type PortUsageStatus,
} from "../../infra/ports.js";
import {
  resolveRuntimeFingerprint,
  type RuntimeFingerprint,
} from "../../infra/runtime-fingerprint.js";
import { pickPrimaryTailnetIPv4 } from "../../infra/tailnet.js";
import { loadGatewayTlsRuntime } from "../../infra/tls/gateway.js";
import { probeGatewayStatus } from "./probe.js";
import { inspectGatewayRestart } from "./restart-health.js";
import { normalizeListenerAddress, parsePortFromArgs, pickProbeHostForBind } from "./shared.js";
import type { GatewayRpcOpts } from "./types.js";

type ConfigSummary = {
  path: string;
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  controlUi?: GatewayControlUiConfig;
};

type GatewayStatusSummary = {
  bindMode: GatewayBindMode;
  bindHost: string;
  customBindHost?: string;
  port: number;
  portSource: "service args" | "env/config";
  probeUrl: string;
  probeNote?: string;
};

type PortStatusSummary = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
};

type GatewayPortMismatchSummary = {
  servicePort: number;
  servicePortSource: GatewayStatusSummary["portSource"];
  expectedPort: number;
  expectedPortStatus: PortUsageStatus;
  serviceStateDir: string;
  expectedStateDir: string;
  serviceConfigPath: string;
  expectedConfigPath: string;
  issues: string[];
};

type CanonicalDefaultGatewaySummary = {
  missing: boolean;
  label: string;
  reason: string;
  recoveryCommand: string;
};

type DaemonConfigContext = {
  mergedDaemonEnv: Record<string, string | undefined>;
  cliCfg: OpenClawConfig;
  daemonCfg: OpenClawConfig;
  cliStateDir: string;
  daemonStateDir: string;
  cliConfigSummary: ConfigSummary;
  daemonConfigSummary: ConfigSummary;
  configMismatch: boolean;
};

type ResolvedGatewayStatus = {
  gateway: GatewayStatusSummary;
  daemonPort: number;
  cliPort: number;
  probeUrlOverride: string | null;
};

const RUNTIME_SELECTOR_ENV_KEYS = [
  "OPENCLAW_CONSUMER_INSTANCE_ID",
  "OPENCLAW_HOME",
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_PROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
] as const;

export type DaemonStatus = {
  runtimeFingerprint?: RuntimeFingerprint;
  service: {
    label: string;
    loaded: boolean;
    loadedText: string;
    notLoadedText: string;
    command?: {
      programArguments: string[];
      workingDirectory?: string;
      environment?: Record<string, string>;
      sourcePath?: string;
    } | null;
    runtime?: GatewayServiceRuntime;
    configAudit?: ServiceConfigAudit;
  };
  config?: {
    cli: ConfigSummary;
    daemon?: ConfigSummary;
    mismatch?: boolean;
  };
  gateway?: GatewayStatusSummary;
  port?: {
    port: number;
    status: PortUsageStatus;
    listeners: PortListener[];
    hints: string[];
  };
  portCli?: {
    port: number;
    status: PortUsageStatus;
    listeners: PortListener[];
    hints: string[];
  };
  portMismatch?: GatewayPortMismatchSummary;
  lastError?: string;
  rpc?: {
    ok: boolean;
    error?: string;
    url?: string;
    authWarning?: string;
  };
  health?: {
    healthy: boolean;
    staleGatewayPids: number[];
  };
  canonicalDefaultGateway?: CanonicalDefaultGatewaySummary;
  extraServices: Array<{ label: string; detail: string; scope: string }>;
};

function shouldReportPortUsage(status: PortUsageStatus | undefined, rpcOk?: boolean) {
  if (status !== "busy") {
    return false;
  }
  if (rpcOk === true) {
    return false;
  }
  return true;
}

function hasExplicitRuntimeSelector(env: Record<string, string | undefined>): boolean {
  return RUNTIME_SELECTOR_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

function isCanonicalAppOwnedDefaultServiceEnv(serviceEnv: Record<string, string>): boolean {
  const launchdLabel = serviceEnv.OPENCLAW_LAUNCHD_LABEL?.trim();
  const home = serviceEnv.OPENCLAW_HOME?.trim();
  const stateDir = serviceEnv.OPENCLAW_STATE_DIR?.trim();
  const configPath = serviceEnv.OPENCLAW_CONFIG_PATH?.trim();
  if (!launchdLabel || !home || !stateDir || !configPath) {
    return false;
  }

  if (launchdLabel === PUBLIC_JARVIS_GATEWAY_LAUNCHD_LABEL) {
    return stateDir === `${home}/.jarvis` && configPath === `${stateDir}/openclaw.json`;
  }

  if (launchdLabel === GATEWAY_LAUNCH_AGENT_LABEL) {
    // The shared macOS runtime is app-owned even when it is backed by the
    // sacred main checkout. In that mode the LaunchAgent intentionally points at
    // ~/Library/Application Support/OpenClaw/.openclaw, so an unscoped status
    // command should inspect the loaded service env instead of inventing
    // ~/.openclaw as the expected config root.
    return stateDir === `${home}/.openclaw` && configPath === `${stateDir}/openclaw.json`;
  }

  return false;
}

function isDefaultGatewayStatusTarget(params: {
  cliEnv: Record<string, string | undefined>;
  serviceEnv?: Record<string, string>;
}): boolean {
  const label =
    params.serviceEnv?.OPENCLAW_LAUNCHD_LABEL?.trim() ||
    params.cliEnv.OPENCLAW_LAUNCHD_LABEL?.trim();
  const profile = params.serviceEnv?.OPENCLAW_PROFILE?.trim() || params.cliEnv.OPENCLAW_PROFILE;

  if (label) {
    return label === GATEWAY_LAUNCH_AGENT_LABEL || label === PUBLIC_JARVIS_GATEWAY_LAUNCHD_LABEL;
  }
  return !profile || profile === "default" || profile === "consumer";
}

function shouldAdoptCanonicalServiceEnv(params: {
  rawEnv: Record<string, string | undefined>;
  serviceEnv?: Record<string, string>;
}): boolean {
  if (hasExplicitRuntimeSelector(params.rawEnv)) {
    return false;
  }
  const serviceEnv = params.serviceEnv;
  if (!serviceEnv) {
    return false;
  }
  if (
    serviceEnv.OPENCLAW_PROFILE?.trim() === "consumer" &&
    serviceEnv.OPENCLAW_LAUNCHD_LABEL?.trim() ===
      resolveConsumerRuntimeIdentity().gatewayLaunchdLabel &&
    Boolean(serviceEnv.OPENCLAW_STATE_DIR?.trim()) &&
    Boolean(serviceEnv.OPENCLAW_CONFIG_PATH?.trim())
  ) {
    return true;
  }
  return isCanonicalAppOwnedDefaultServiceEnv(serviceEnv);
}

function parseGatewaySecretRefPathFromError(error: unknown): string | null {
  return isGatewaySecretRefUnavailableError(error) ? error.path : null;
}

async function loadDaemonConfigContext(
  cliEnvInput: Record<string, string | undefined>,
  serviceEnv?: Record<string, string>,
): Promise<DaemonConfigContext> {
  const cliEnv = cliEnvInput;
  const mergedDaemonEnv = {
    ...cliEnv,
    ...(serviceEnv ?? undefined),
  } satisfies Record<string, string | undefined>;

  const cliStateDir = resolveStateDir(cliEnv as NodeJS.ProcessEnv);
  const daemonStateDir = resolveStateDir(mergedDaemonEnv as NodeJS.ProcessEnv);
  const cliConfigPath = resolveConfigPath(cliEnv as NodeJS.ProcessEnv, cliStateDir);
  const daemonConfigPath = resolveConfigPath(mergedDaemonEnv as NodeJS.ProcessEnv, daemonStateDir);

  const cliIO = createConfigIO({ env: cliEnv, configPath: cliConfigPath });
  const daemonIO = createConfigIO({
    env: mergedDaemonEnv,
    configPath: daemonConfigPath,
  });

  const [cliSnapshot, daemonSnapshot] = await Promise.all([
    cliIO.readConfigFileSnapshot().catch(() => null),
    daemonIO.readConfigFileSnapshot().catch(() => null),
  ]);
  const cliCfg = cliIO.loadConfig();
  const daemonCfg = daemonIO.loadConfig();

  const cliConfigSummary: ConfigSummary = {
    path: cliSnapshot?.path ?? cliConfigPath,
    exists: cliSnapshot?.exists ?? false,
    valid: cliSnapshot?.valid ?? true,
    ...(cliSnapshot?.issues?.length ? { issues: cliSnapshot.issues } : {}),
    controlUi: cliCfg.gateway?.controlUi,
  };
  const daemonConfigSummary: ConfigSummary = {
    path: daemonSnapshot?.path ?? daemonConfigPath,
    exists: daemonSnapshot?.exists ?? false,
    valid: daemonSnapshot?.valid ?? true,
    ...(daemonSnapshot?.issues?.length ? { issues: daemonSnapshot.issues } : {}),
    controlUi: daemonCfg.gateway?.controlUi,
  };

  return {
    mergedDaemonEnv,
    cliCfg,
    daemonCfg,
    cliStateDir,
    daemonStateDir,
    cliConfigSummary,
    daemonConfigSummary,
    configMismatch: cliConfigSummary.path !== daemonConfigSummary.path,
  };
}

async function resolveGatewayStatusSummary(params: {
  daemonCfg: OpenClawConfig;
  cliCfg: OpenClawConfig;
  mergedDaemonEnv: Record<string, string | undefined>;
  commandProgramArguments?: string[];
  rpcUrlOverride?: string;
}): Promise<ResolvedGatewayStatus> {
  const portFromArgs = parsePortFromArgs(params.commandProgramArguments);
  const daemonPort = portFromArgs ?? resolveGatewayPort(params.daemonCfg, params.mergedDaemonEnv);
  const portSource: GatewayStatusSummary["portSource"] = portFromArgs
    ? "service args"
    : "env/config";
  const bindMode: GatewayBindMode = params.daemonCfg.gateway?.bind ?? "loopback";
  const customBindHost = params.daemonCfg.gateway?.customBindHost;
  const bindHost = await resolveGatewayBindHost(bindMode, customBindHost);
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  const probeHost = pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost);
  const probeUrlOverride = trimToUndefined(params.rpcUrlOverride) ?? null;
  const scheme = params.daemonCfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
  const probeNote =
    !probeUrlOverride && bindMode === "lan"
      ? `bind=lan listens on 0.0.0.0 (all interfaces); probing via ${probeHost}.`
      : !probeUrlOverride && bindMode === "loopback"
        ? "Loopback-only gateway; only local clients can connect."
        : undefined;

  return {
    gateway: {
      bindMode,
      bindHost,
      customBindHost,
      port: daemonPort,
      portSource,
      probeUrl,
      ...(probeNote ? { probeNote } : {}),
    },
    daemonPort,
    cliPort: resolveGatewayPort(
      params.cliCfg,
      resolveGatewayRuntimeIdentityEnv(process.env) as NodeJS.ProcessEnv,
    ),
    probeUrlOverride,
  };
}

function toPortStatusSummary(
  diagnostics: Awaited<ReturnType<typeof inspectPortUsage>> | null,
): PortStatusSummary | undefined {
  if (!diagnostics) {
    return undefined;
  }
  return {
    port: diagnostics.port,
    status: diagnostics.status,
    listeners: diagnostics.listeners,
    hints: diagnostics.hints,
  };
}

async function inspectDaemonPortStatuses(params: {
  daemonPort: number;
  cliPort: number;
}): Promise<{ portStatus?: PortStatusSummary; portCliStatus?: PortStatusSummary }> {
  const [portDiagnostics, portCliDiagnostics] = await Promise.all([
    inspectPortUsage(params.daemonPort).catch(() => null),
    params.cliPort !== params.daemonPort
      ? inspectPortUsage(params.cliPort).catch(() => null)
      : null,
  ]);
  return {
    portStatus: toPortStatusSummary(portDiagnostics),
    portCliStatus: toPortStatusSummary(portCliDiagnostics),
  };
}

export async function gatherDaemonStatus(
  opts: {
    rpc: GatewayRpcOpts;
    probe: boolean;
    deep?: boolean;
  } & FindExtraGatewayServicesOptions,
): Promise<DaemonStatus> {
  const service = resolveGatewayService();
  const rawEnv = process.env as Record<string, string | undefined>;
  const shellCliEnv = resolveGatewayRuntimeIdentityEnv(rawEnv);
  const command = await service.readCommand(shellCliEnv as NodeJS.ProcessEnv).catch(() => null);
  const cliEnv = shouldAdoptCanonicalServiceEnv({
    rawEnv,
    serviceEnv: command?.environment,
  })
    ? ({
        ...shellCliEnv,
        ...command?.environment,
      } satisfies Record<string, string | undefined>)
    : shellCliEnv;
  const serviceEnv = command?.environment
    ? ({
        ...cliEnv,
        ...command.environment,
      } satisfies NodeJS.ProcessEnv)
    : (cliEnv as NodeJS.ProcessEnv);
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env: serviceEnv }).catch(() => false),
    service.readRuntime(serviceEnv).catch((err) => ({ status: "unknown", detail: String(err) })),
  ]);
  const configAudit = await auditGatewayServiceConfig({
    env: cliEnv as NodeJS.ProcessEnv,
    command,
  });
  const {
    mergedDaemonEnv,
    cliCfg,
    daemonCfg,
    cliStateDir,
    daemonStateDir,
    cliConfigSummary,
    daemonConfigSummary,
    configMismatch,
  } = await loadDaemonConfigContext(cliEnv, command?.environment);
  const { gateway, daemonPort, cliPort, probeUrlOverride } = await resolveGatewayStatusSummary({
    cliCfg,
    daemonCfg,
    mergedDaemonEnv,
    commandProgramArguments: command?.programArguments,
    rpcUrlOverride: opts.rpc.url,
  });
  const { portStatus, portCliStatus } = await inspectDaemonPortStatuses({
    daemonPort,
    cliPort,
  });
  const portMismatchIssues: string[] = [];
  if (cliPort !== daemonPort) {
    portMismatchIssues.push(`service port=${daemonPort}, cli port=${cliPort}`);
  }
  if (daemonStateDir !== cliStateDir) {
    portMismatchIssues.push(`service state dir=${daemonStateDir}, cli state dir=${cliStateDir}`);
  }
  if (daemonConfigSummary.path !== cliConfigSummary.path) {
    portMismatchIssues.push(
      `service config=${daemonConfigSummary.path}, cli config=${cliConfigSummary.path}`,
    );
  }
  const portMismatch =
    portMismatchIssues.length > 0
      ? {
          servicePort: daemonPort,
          servicePortSource: gateway.portSource,
          expectedPort: cliPort,
          expectedPortStatus: portCliStatus?.status ?? portStatus?.status ?? "unknown",
          serviceStateDir: daemonStateDir,
          expectedStateDir: cliStateDir,
          serviceConfigPath: daemonConfigSummary.path,
          expectedConfigPath: cliConfigSummary.path,
          issues: portMismatchIssues,
        }
      : undefined;

  const extraServices = await findExtraGatewayServices(
    process.env as Record<string, string | undefined>,
    { deep: Boolean(opts.deep) },
  ).catch(() => []);

  const timeoutMs = parseStrictPositiveInteger(opts.rpc.timeout ?? "10000") ?? 10_000;

  const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
  const shouldUseLocalTlsRuntime = opts.probe && !probeUrlOverride && tlsEnabled;
  const tlsRuntime = shouldUseLocalTlsRuntime
    ? await loadGatewayTlsRuntime(daemonCfg.gateway?.tls)
    : undefined;
  let daemonProbeAuth: { token?: string; password?: string } | undefined;
  let rpcAuthWarning: string | undefined;
  if (opts.probe) {
    try {
      daemonProbeAuth = await resolveGatewayProbeAuthWithSecretInputs({
        cfg: daemonCfg,
        mode: daemonCfg.gateway?.mode === "remote" ? "remote" : "local",
        env: mergedDaemonEnv as NodeJS.ProcessEnv,
        explicitAuth: {
          token: opts.rpc.token,
          password: opts.rpc.password,
        },
      });
    } catch (error) {
      const refPath = parseGatewaySecretRefPathFromError(error);
      if (!refPath) {
        throw error;
      }
      daemonProbeAuth = undefined;
      rpcAuthWarning = `${refPath} SecretRef is unavailable in this command path; probing without configured auth credentials.`;
    }
  }

  const rpc = opts.probe
    ? await probeGatewayStatus({
        url: gateway.probeUrl,
        token: daemonProbeAuth?.token,
        password: daemonProbeAuth?.password,
        tlsFingerprint:
          shouldUseLocalTlsRuntime && tlsRuntime?.enabled
            ? tlsRuntime.fingerprintSha256
            : undefined,
        timeoutMs,
        json: opts.rpc.json,
        configPath: daemonConfigSummary.path,
      })
    : undefined;
  if (rpc?.ok) {
    rpcAuthWarning = undefined;
  }
  const health =
    opts.probe && loaded
      ? await inspectGatewayRestart({
          service,
          port: daemonPort,
          env: serviceEnv,
        }).catch(() => undefined)
      : undefined;

  let lastError: string | undefined;
  if (loaded && runtime?.status === "running" && portStatus && portStatus.status !== "busy") {
    lastError = (await readLastGatewayErrorLine(mergedDaemonEnv as NodeJS.ProcessEnv)) ?? undefined;
  }

  const isDefaultTarget = isDefaultGatewayStatusTarget({
    cliEnv,
    serviceEnv: command?.environment,
  });
  const canonicalDefaultGateway =
    isDefaultTarget && !loaded
      ? {
          missing: true,
          label: GATEWAY_LAUNCH_AGENT_LABEL,
          reason:
            runtime && "missingUnit" in runtime && runtime.missingUnit === true
              ? "canonical shared gateway LaunchAgent is missing or not registered"
              : "canonical shared gateway LaunchAgent is not loaded",
          recoveryCommand: "bash scripts/gateway-recover-main.sh",
        }
      : undefined;

  return {
    runtimeFingerprint: resolveRuntimeFingerprint({
      cwd: command?.workingDirectory,
      env: serviceEnv,
      serviceLabel: serviceEnv.OPENCLAW_LAUNCHD_LABEL ?? service.label,
    }),
    service: {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      notLoadedText: service.notLoadedText,
      command,
      runtime,
      configAudit,
    },
    config: {
      cli: cliConfigSummary,
      daemon: daemonConfigSummary,
      ...(configMismatch ? { mismatch: true } : {}),
    },
    gateway,
    port: portStatus,
    ...(portCliStatus ? { portCli: portCliStatus } : {}),
    ...(portMismatch ? { portMismatch } : {}),
    lastError,
    ...(rpc
      ? {
          rpc: {
            ...rpc,
            url: gateway.probeUrl,
            ...(rpcAuthWarning ? { authWarning: rpcAuthWarning } : {}),
          },
        }
      : {}),
    ...(health
      ? {
          health: {
            healthy: health.healthy,
            staleGatewayPids: health.staleGatewayPids,
          },
        }
      : {}),
    ...(canonicalDefaultGateway ? { canonicalDefaultGateway } : {}),
    extraServices,
  };
}

export function renderPortDiagnosticsForCli(status: DaemonStatus, rpcOk?: boolean): string[] {
  if (!status.port || !shouldReportPortUsage(status.port.status, rpcOk)) {
    return [];
  }
  return formatPortDiagnostics({
    port: status.port.port,
    status: status.port.status,
    listeners: status.port.listeners,
    hints: status.port.hints,
  });
}

export function resolvePortListeningAddresses(status: DaemonStatus): string[] {
  const addrs = Array.from(
    new Set(
      status.port?.listeners
        ?.map((l) => (l.address ? normalizeListenerAddress(l.address) : ""))
        .filter((v): v is string => Boolean(v)) ?? [],
    ),
  );
  return addrs;
}
