import path from "node:path";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../../agents/auth-profiles.js";
import { resolveConfiguredModelRef } from "../../agents/model-selection.js";
import { createConfigIO, loadConfig, resolveStateDir } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { runAuthProbes, type AuthProbeResult, type AuthProbeStatus } from "./list.probe.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./shared.js";

export const CONSUMER_CANONICAL_SHARED_PROFILE_ID = "openai-codex:default";
const MANAGED_PROVIDER_ID = "openai-codex";
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_TOKENS = 8;

export type ModelsReadinessStatus = "ready" | "blocked" | "checking";
export type ModelsReadinessMode = "managed" | "byok";
export type ModelsReadinessReasonCode =
  | "wrong_state_dir"
  | "missing_auth"
  | "probe_auth_failed"
  | "probe_rate_limited"
  | "probe_billing_failed"
  | "probe_timeout"
  | "probe_no_model"
  | "probe_unknown";

export type ModelsReadinessProbe = {
  provider: string;
  model?: string;
  profileId?: string;
  label: string;
  source: "profile" | "env" | "models.json";
  mode?: string;
  status: AuthProbeStatus;
  reasonCode?: string;
  error?: string;
  latencyMs?: number;
};

export type ModelsReadinessResult = {
  status: ModelsReadinessStatus;
  mode: ModelsReadinessMode;
  defaultModel: string;
  configPath: string;
  stateDir: string;
  agentDir: string;
  authMode: "shared" | "byok";
  sharedProfileId?: string;
  reasonCodes: ModelsReadinessReasonCode[];
  summary: string;
  actions: string[];
  byokAvailable: boolean;
  lastProbeAt?: number;
  probeLatencyMs?: number;
  probe?: ModelsReadinessProbe;
};

function resolveDefaultModel(cfg: OpenClawConfig): { provider: string; model: string } {
  return resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
}

function inferExpectedStateDirFromConfigPath(configPath: string): string {
  // Consumer runtime config is expected to live directly inside the state dir.
  // When config and state diverge, auth can silently resolve from the wrong runtime.
  return path.dirname(configPath);
}

function inferMode(params: {
  cfg: OpenClawConfig;
  store: ReturnType<typeof ensureAuthProfileStore>;
  defaultProvider: string;
}): ModelsReadinessMode {
  if (params.defaultProvider !== MANAGED_PROVIDER_ID) {
    return "byok";
  }

  const orderedProfiles = resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.store,
    provider: MANAGED_PROVIDER_ID,
  });

  // Shared/founder auth is only the default tester path when the canonical
  // shared profile is still the profile the runtime would actually use. A
  // tester-owned Codex login should stay "byok" even though the provider id
  // remains openai-codex.
  if (orderedProfiles.length === 0) {
    return "managed";
  }
  return orderedProfiles[0] == CONSUMER_CANONICAL_SHARED_PROFILE_ID ? "managed" : "byok";
}

function buildBlockedResult(params: {
  mode: ModelsReadinessMode;
  defaultModel: string;
  configPath: string;
  stateDir: string;
  agentDir: string;
  reasonCodes: ModelsReadinessReasonCode[];
  summary: string;
  actions: string[];
  probe?: ModelsReadinessProbe;
}): ModelsReadinessResult {
  return {
    status: "blocked",
    mode: params.mode,
    defaultModel: params.defaultModel,
    configPath: params.configPath,
    stateDir: params.stateDir,
    agentDir: params.agentDir,
    authMode: params.mode === "managed" ? "shared" : "byok",
    sharedProfileId: params.mode === "managed" ? CONSUMER_CANONICAL_SHARED_PROFILE_ID : undefined,
    reasonCodes: params.reasonCodes,
    summary: params.summary,
    actions: params.actions,
    byokAvailable: true,
    lastProbeAt: Date.now(),
    probeLatencyMs: params.probe?.latencyMs,
    probe: params.probe,
  };
}

function buildManagedActions(): string[] {
  return [
    "Retry AI check after refreshing the shared OpenAI Codex auth.",
    "If the shared credential is still broken, switch this tester to BYOK in AI & Agents.",
  ];
}

function buildByokActions(): string[] {
  return [
    "Open AI & Agents and add a working model credential for the selected provider.",
    "Retry AI check after saving the credential.",
  ];
}

function mapProbeFailureCode(probe: AuthProbeResult): ModelsReadinessReasonCode {
  if (probe.reasonCode === "excluded_by_auth_order") {
    return "missing_auth";
  }
  if (probe.status === "auth") {
    return "probe_auth_failed";
  }
  if (probe.status === "rate_limit") {
    return "probe_rate_limited";
  }
  if (probe.status === "billing") {
    return "probe_billing_failed";
  }
  if (probe.status === "timeout") {
    return "probe_timeout";
  }
  if (probe.status === "no_model") {
    return "probe_no_model";
  }
  return "probe_unknown";
}

function formatFailureSummary(params: {
  mode: ModelsReadinessMode;
  probe: AuthProbeResult;
}): string {
  if (params.mode === "managed") {
    if (params.probe.reasonCode === "excluded_by_auth_order") {
      return "OpenClaw-managed AI is selected, but the canonical shared auth profile is not usable in this runtime.";
    }
    if (params.probe.status === "auth") {
      return "OpenClaw-managed AI is configured, but the shared auth is no longer usable.";
    }
    if (params.probe.status === "rate_limit") {
      return "OpenClaw-managed AI is blocked by a provider rate limit right now.";
    }
    if (params.probe.status === "billing") {
      return "OpenClaw-managed AI is blocked by a provider billing issue right now.";
    }
    if (params.probe.status === "timeout") {
      return "OpenClaw-managed AI did not answer the readiness probe in time.";
    }
    if (params.probe.status === "no_model") {
      return "The configured default model is not available for the shared auth path.";
    }
    return "OpenClaw-managed AI is not ready yet.";
  }
  if (params.probe.reasonCode === "excluded_by_auth_order") {
    return "Your selected AI credential is excluded by the current auth order.";
  }
  if (params.probe.status === "auth") {
    return "Your AI credential is configured, but it did not pass a live readiness check.";
  }
  if (params.probe.status === "rate_limit") {
    return "Your AI provider is rate limiting this credential right now.";
  }
  if (params.probe.status === "billing") {
    return "Your AI provider rejected this credential because of billing or quota.";
  }
  if (params.probe.status === "timeout") {
    return "Your AI provider did not answer the readiness probe in time.";
  }
  if (params.probe.status === "no_model") {
    return "The configured default model is not available for this credential.";
  }
  return "Your AI setup is not ready yet.";
}

function toProbePayload(result: AuthProbeResult): ModelsReadinessProbe {
  return {
    provider: result.provider,
    model: result.model,
    profileId: result.profileId,
    label: result.label,
    source: result.source,
    mode: result.mode,
    status: result.status,
    reasonCode: result.reasonCode,
    error: result.error,
    latencyMs: result.latencyMs,
  };
}

function cloneConfigWithCanonicalManagedOrder(cfg: OpenClawConfig): OpenClawConfig {
  const nextAuthOrder = {
    ...cfg.auth?.order,
    [MANAGED_PROVIDER_ID]: [CONSUMER_CANONICAL_SHARED_PROFILE_ID],
  };
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      order: nextAuthOrder,
    },
  };
}

export async function resolveModelsReadiness(): Promise<ModelsReadinessResult> {
  const cfg = loadConfig();
  const configPath = createConfigIO().configPath;
  const stateDir = resolveStateDir();
  const agentDir = resolveOpenClawAgentDir();
  const defaultModelRef = resolveDefaultModel(cfg);
  const defaultModel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const store = ensureAuthProfileStore(agentDir);
  const mode = inferMode({
    cfg,
    store,
    defaultProvider: defaultModelRef.provider,
  });

  const expectedStateDir = inferExpectedStateDirFromConfigPath(configPath);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const expectedAgentDir = path.join(expectedStateDir, "agents", defaultAgentId, "agent");

  if (
    path.resolve(stateDir) !== path.resolve(expectedStateDir) ||
    path.resolve(agentDir) !== path.resolve(expectedAgentDir)
  ) {
    return buildBlockedResult({
      mode,
      defaultModel,
      configPath,
      stateDir,
      agentDir,
      reasonCodes: ["wrong_state_dir"],
      summary:
        "This app runtime is reading config and auth from different locations, so AI readiness is not trustworthy.",
      actions: [
        `Set OPENCLAW_STATE_DIR to ${expectedStateDir} when OPENCLAW_CONFIG_PATH points there.`,
        "Restart the consumer runtime after updating the environment so config and auth resolve from the same state root.",
      ],
    });
  }

  let probeConfig = cfg;
  let probeProfileIds: string[] | undefined;
  if (mode === "managed") {
    if (!store.profiles[CONSUMER_CANONICAL_SHARED_PROFILE_ID]) {
      return buildBlockedResult({
        mode,
        defaultModel,
        configPath,
        stateDir,
        agentDir,
        reasonCodes: ["missing_auth"],
        summary:
          "OpenClaw-managed AI is selected, but the canonical shared auth profile is missing from this consumer runtime.",
        actions: buildManagedActions(),
      });
    }
    probeConfig = cloneConfigWithCanonicalManagedOrder(cfg);
    probeProfileIds = [CONSUMER_CANONICAL_SHARED_PROFILE_ID];
  } else {
    const orderedProfiles = resolveAuthProfileOrder({
      cfg,
      store,
      provider: defaultModelRef.provider,
    });
    if (orderedProfiles.length > 0) {
      probeProfileIds = [orderedProfiles[0]];
    }
  }

  const probeSummary = await runAuthProbes({
    cfg: probeConfig,
    providers: [defaultModelRef.provider],
    modelCandidates: [defaultModel],
    options: {
      provider: defaultModelRef.provider,
      profileIds: probeProfileIds,
      timeoutMs: PROBE_TIMEOUT_MS,
      concurrency: 1,
      maxTokens: PROBE_MAX_TOKENS,
    },
  });

  const probe =
    probeSummary.results.find((entry) => entry.model === defaultModel) ?? probeSummary.results[0];

  if (!probe) {
    return buildBlockedResult({
      mode,
      defaultModel,
      configPath,
      stateDir,
      agentDir,
      reasonCodes: ["missing_auth"],
      summary:
        mode === "managed"
          ? "OpenClaw-managed AI is selected, but no usable shared credential was found for the default model."
          : "No usable AI credential was found for the default model.",
      actions: mode === "managed" ? buildManagedActions() : buildByokActions(),
    });
  }

  if (probe.status !== "ok") {
    return buildBlockedResult({
      mode,
      defaultModel,
      configPath,
      stateDir,
      agentDir,
      reasonCodes: [mapProbeFailureCode(probe)],
      summary: formatFailureSummary({ mode, probe }),
      actions: mode === "managed" ? buildManagedActions() : buildByokActions(),
      probe: toProbePayload(probe),
    });
  }

  return {
    status: "ready",
    mode,
    defaultModel,
    configPath,
    stateDir,
    agentDir,
    authMode: mode === "managed" ? "shared" : "byok",
    sharedProfileId: mode === "managed" ? CONSUMER_CANONICAL_SHARED_PROFILE_ID : undefined,
    reasonCodes: [],
    summary:
      mode === "managed"
        ? "OpenClaw-managed AI passed a live readiness check for the default model."
        : "Your AI credential passed a live readiness check for the default model.",
    actions:
      mode === "managed"
        ? ["If this shared auth is rotated, run AI readiness again before the next demo."]
        : ["If you rotate your key or token, run AI readiness again before the next session."],
    byokAvailable: true,
    lastProbeAt: probeSummary.finishedAt,
    probeLatencyMs: probe.latencyMs,
    probe: toProbePayload(probe),
  };
}
