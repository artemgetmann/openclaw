import { normalizeUpdateChannel, resolveUpdateChannelDisplay } from "../infra/update-channels.js";
import type { RuntimeEnv } from "../runtime.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";
import { scanStatus } from "./status.scan.js";

let providerUsagePromise: Promise<typeof import("../infra/provider-usage.js")> | undefined;

function loadProviderUsage() {
  providerUsagePromise ??= import("../infra/provider-usage.js");
  return providerUsagePromise;
}

const SKIPPED_SECURITY_AUDIT = {
  skipped: true,
  reason: "status --json skips security audit unless --deep is set",
  summary: { critical: 0, warn: 0, info: 0 },
  findings: [],
};

export async function statusJsonCommand(
  opts: {
    usage?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const scan = await scanStatus({ json: true, timeoutMs: opts.timeoutMs, all: opts.all }, runtime);

  const usage = opts.usage
    ? await loadProviderUsage().then(({ loadProviderUsageSummary }) =>
        loadProviderUsageSummary({ timeoutMs: opts.timeoutMs }),
      )
    : undefined;

  const [daemon, nodeDaemon] = await Promise.all([
    getDaemonStatusSummary(),
    getNodeDaemonStatusSummary(),
  ]);
  const channelInfo = resolveUpdateChannelDisplay({
    configChannel: normalizeUpdateChannel(scan.cfg.update?.channel),
    installKind: scan.update.installKind,
    gitTag: scan.update.git?.tag ?? null,
    gitBranch: scan.update.git?.branch ?? null,
  });

  runtime.log(
    JSON.stringify(
      {
        ...scan.summary,
        os: scan.osSummary,
        update: scan.update,
        updateChannel: channelInfo.channel,
        updateChannelSource: channelInfo.source,
        memory: scan.memory,
        memoryPlugin: scan.memoryPlugin,
        gateway: {
          mode: scan.gatewayMode,
          url: scan.gatewayConnection.url,
          urlSource: scan.gatewayConnection.urlSource,
          misconfigured: scan.remoteUrlMissing,
          reachable: scan.gatewayReachable,
          connectLatencyMs: scan.gatewayProbe?.connectLatencyMs ?? null,
          self: scan.gatewaySelf,
          error: scan.gatewayProbe?.error ?? null,
          authWarning: scan.gatewayProbeAuthWarning ?? null,
        },
        gatewayService: daemon,
        nodeService: nodeDaemon,
        agents: scan.agentStatus,
        securityAudit: SKIPPED_SECURITY_AUDIT,
        secretDiagnostics: scan.secretDiagnostics,
        ...(usage ? { usage } : {}),
      },
      null,
      2,
    ),
  );
}
