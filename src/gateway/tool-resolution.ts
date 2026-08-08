import fs from "node:fs";
import JSON5 from "json5";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "../agents/pi-tools.policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath } from "../cron/store.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import { resolvePermissionDefaults } from "../infra/permissions-mode.js";
import { logWarn } from "../logger.js";
import { resolveMonitorStorePath } from "../monitor/store.js";
import type { MonitorStoreFile } from "../monitor/types.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";
import { resolveSessionStoreKey } from "./session-utils.js";

export type GatewayScopedToolSurface = "http" | "loopback";

export function resolveGatewayGuiPermissionDefaults(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): { execSecurity: ExecSecurity; execAsk: ExecAsk } {
  // Loopback tool objects are cached, but /permissions mutates the session
  // store. Read the entry on each GUI execution so a mode change takes effect
  // immediately and cannot inherit stale approval authority from the cache.
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const store = loadSessionStore(
    resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
  );
  const matchedKey = Object.keys(store).find(
    (key) => key.toLowerCase() === canonicalKey.toLowerCase(),
  );
  const sessionEntry = matchedKey ? store[matchedKey] : undefined;
  const globalExec = params.cfg.tools?.exec;
  const agentExec = resolveAgentConfig(params.cfg, params.agentId)?.tools?.exec;
  const defaults = resolvePermissionDefaults({
    config: params.cfg,
    agentId: params.agentId,
  });
  return {
    execSecurity:
      (sessionEntry?.execSecurity as ExecSecurity | undefined) ??
      agentExec?.security ??
      globalExec?.security ??
      defaults.execSecurity,
    execAsk:
      (sessionEntry?.execAsk as ExecAsk | undefined) ??
      agentExec?.ask ??
      globalExec?.ask ??
      defaults.execAsk,
  };
}

function shouldLogToolResolution(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT) ||
    isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG)
  );
}

function logToolResolution(step: string, details: Record<string, unknown>): void {
  if (!shouldLogToolResolution()) {
    return;
  }
  console.error(`[mcp-loopback] ${step} ${JSON.stringify(details)}`);
}

function isUnboundMonitorSession(params: { cfg: OpenClawConfig; sessionKey: string }): boolean {
  const monitorStorePath = resolveMonitorStorePath({
    cronStorePath: resolveCronStorePath(params.cfg.cron?.store),
  });
  try {
    const parsed = JSON5.parse(fs.readFileSync(monitorStorePath, "utf-8"));
    const monitors: MonitorStoreFile["monitors"] = Array.isArray(parsed?.monitors)
      ? parsed.monitors
      : [];
    const monitor = monitors.find((entry) => entry?.monitorSessionKey === params.sessionKey);
    return Boolean(monitor && !monitor.goal);
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return false;
    }
    logWarn(`tool-resolution: failed to inspect monitor store: ${String(err)}`);
    return false;
  }
}

export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider?: string;
  accountId?: string;
  surface?: GatewayScopedToolSurface;
  excludeToolNames?: Iterable<string>;
  senderIsOwner?: boolean;
}) {
  logToolResolution("tool-resolution-policy-start", {
    sessionKey: params.sessionKey,
    surface: params.surface ?? "http",
  });
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({ config: params.cfg, sessionKey: params.sessionKey });
  logToolResolution("tool-resolution-policy-end", {
    sessionKey: params.sessionKey,
    agentId,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    accountId: params.accountId,
  });
  const subagentPolicy = isSubagentSessionKey(params.sessionKey)
    ? resolveSubagentToolPolicyForSession(params.cfg, params.sessionKey)
    : undefined;
  const workspaceDir = resolveAgentWorkspaceDir(
    params.cfg,
    agentId ?? resolveDefaultAgentId(params.cfg),
  );

  logToolResolution("tool-resolution-create-tools-start", {
    sessionKey: params.sessionKey,
    workspaceDir,
  });
  const allTools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: params.messageProvider ?? undefined,
    agentAccountId: params.accountId,
    senderIsOwner: params.senderIsOwner,
    config: params.cfg,
    disableGoalTools: isUnboundMonitorSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    }),
    workspaceDir,
    enableGuiControlTool: params.surface === "loopback",
    resolvePermissionDefaults: () =>
      resolveGatewayGuiPermissionDefaults({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: agentId ?? resolveDefaultAgentId(params.cfg),
      }),
    pluginToolGlobalRegistryOnly: params.surface === "loopback",
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
    ]),
  });
  logToolResolution("tool-resolution-create-tools-end", {
    sessionKey: params.sessionKey,
    toolCount: allTools.length,
  });

  logToolResolution("tool-resolution-policy-filter-start", {
    sessionKey: params.sessionKey,
    toolCount: allTools.length,
  });
  const policyFiltered = applyToolPolicyPipeline({
    tools: allTools,
    toolMeta: (tool: AnyAgentTool) => getPluginToolMeta(tool),
    warn: logWarn,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy: profilePolicyWithAlsoAllow,
        profile,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfile,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        agentId,
      }),
      { policy: subagentPolicy, label: "subagent tools.allow" },
    ],
  });
  logToolResolution("tool-resolution-policy-filter-end", {
    sessionKey: params.sessionKey,
    toolCount: policyFiltered.length,
  });

  const surface = params.surface ?? "http";
  const gatewayToolsCfg = params.cfg.gateway?.tools;
  const defaultGatewayDeny =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name))
      : [];
  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
    ...(params.excludeToolNames ? Array.from(params.excludeToolNames) : []),
  ]);

  return {
    agentId,
    tools: policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name)),
  };
}
