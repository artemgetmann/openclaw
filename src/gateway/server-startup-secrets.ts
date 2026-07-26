import { isDeepStrictEqual } from "node:util";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import type { GatewayAuthConfig, OpenClawConfig } from "../config/config.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";

type SecretsReloaderStateCode = "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED";
type SecretsActivationReason = "startup" | "reload" | "restart-check";

type GatewaySecretsActivationControllerDeps = {
  prepareSecretsRuntimeSnapshot: (params: {
    config: OpenClawConfig;
    loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  }) => Promise<PreparedSecretsRuntimeSnapshot>;
  activateRuntimeSnapshot: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
  onAuthSurfaceDiagnostics: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  emitStateEvent: (code: SecretsReloaderStateCode, message: string, config: OpenClawConfig) => void;
};

function stripGeneratedGatewayAuth(config: OpenClawConfig): OpenClawConfig {
  const normalized = structuredClone(config);
  if (!normalized.gateway?.auth) {
    return normalized;
  }
  delete normalized.gateway.auth.mode;
  delete normalized.gateway.auth.token;
  return normalized;
}

function rebasePreparedSnapshotForAuthBootstrap(
  snapshot: PreparedSecretsRuntimeSnapshot,
  config: OpenClawConfig,
): PreparedSecretsRuntimeSnapshot | null {
  if (isDeepStrictEqual(snapshot.sourceConfig, config)) {
    return snapshot;
  }
  const nextAuth = config.gateway?.auth;
  if (
    nextAuth?.mode !== "token" ||
    typeof nextAuth.token !== "string" ||
    nextAuth.token.trim().length === 0 ||
    !isDeepStrictEqual(
      stripGeneratedGatewayAuth(snapshot.sourceConfig),
      stripGeneratedGatewayAuth(config),
    )
  ) {
    return null;
  }

  // Auth bootstrap is allowed to add only a generated mode/token pair. Rebase
  // those fields onto the already-resolved snapshot so persistence semantics
  // are preserved without rerunning external secret resolution after cutover.
  const resolvedConfig = structuredClone(snapshot.config);
  resolvedConfig.gateway = {
    ...resolvedConfig.gateway,
    auth: {
      ...resolvedConfig.gateway?.auth,
      mode: nextAuth.mode,
      token: nextAuth.token,
    },
  };
  return {
    ...snapshot,
    sourceConfig: structuredClone(config),
    config: resolvedConfig,
  };
}

export function createGatewayStartupSecretsActivator(params: {
  preparedSnapshot?: PreparedSecretsRuntimeSnapshot;
  activatePrepared: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
  activateFresh: (config: OpenClawConfig) => Promise<PreparedSecretsRuntimeSnapshot>;
}): (config: OpenClawConfig) => Promise<PreparedSecretsRuntimeSnapshot> {
  let preparedSnapshot = params.preparedSnapshot;
  return async (config) => {
    if (preparedSnapshot) {
      const candidate = rebasePreparedSnapshotForAuthBootstrap(preparedSnapshot, config);
      // A prepared snapshot is a one-shot capability. Unexpected auth config
      // changes fall back to the normal resolver instead of reusing stale data.
      preparedSnapshot = undefined;
      if (candidate) {
        params.activatePrepared(candidate);
        return candidate;
      }
    }
    return await params.activateFresh(config);
  };
}

export function resolvePreparedGatewayAuthOverride(params: {
  snapshot?: PreparedSecretsRuntimeSnapshot;
  authOverride?: GatewayAuthConfig;
}): GatewayAuthConfig | undefined {
  if (!params.snapshot) {
    return params.authOverride;
  }
  const sourceAuth = params.snapshot.sourceConfig.gateway?.auth;
  const resolvedAuth = params.snapshot.config.gateway?.auth;
  const resolvedToken =
    params.authOverride?.token === undefined &&
    typeof sourceAuth?.token !== "string" &&
    typeof resolvedAuth?.token === "string"
      ? resolvedAuth.token
      : undefined;
  const resolvedPassword =
    params.authOverride?.password === undefined &&
    typeof sourceAuth?.password !== "string" &&
    typeof resolvedAuth?.password === "string"
      ? resolvedAuth.password
      : undefined;
  if (!resolvedToken && !resolvedPassword) {
    return params.authOverride;
  }
  // Feeding already-resolved gateway credentials back through the auth
  // override seam prevents auth bootstrap from contacting the secret backend
  // again. The source config remains untouched for safe token persistence.
  return {
    ...params.authOverride,
    ...(resolvedToken ? { token: resolvedToken } : {}),
    ...(resolvedPassword ? { password: resolvedPassword } : {}),
  };
}

export function createGatewaySecretsActivationController(
  deps: GatewaySecretsActivationControllerDeps,
): {
  activateRuntimeSecrets: (
    config: OpenClawConfig,
    params: { reason: SecretsActivationReason; activate: boolean },
  ) => Promise<PreparedSecretsRuntimeSnapshot>;
} {
  let secretsDegraded = false;
  let activationTail: Promise<void> = Promise.resolve();

  const runWithActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = activationTail.then(operation, operation);
    activationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };

  const activateRuntimeSecrets = async (
    config: OpenClawConfig,
    params: { reason: SecretsActivationReason; activate: boolean },
  ): Promise<PreparedSecretsRuntimeSnapshot> =>
    await runWithActivationLock(async () => {
      try {
        // Startup and restart-check preflight should stay off the slow overlay path so
        // readiness reflects persisted state instead of waiting for external CLI sync.
        // Actual activation paths, including startup auth bootstrap, keep overlay sync.
        const startupPreflight =
          !params.activate && (params.reason === "startup" || params.reason === "restart-check");
        const prepared = await deps.prepareSecretsRuntimeSnapshot({
          config,
          ...(startupPreflight
            ? { loadAuthStore: loadAuthProfileStoreWithoutExternalProfiles }
            : {}),
        });
        if (params.activate) {
          deps.activateRuntimeSnapshot(prepared);
          deps.onAuthSurfaceDiagnostics(prepared);
        }
        for (const warning of prepared.warnings) {
          deps.log.warn(`[${warning.code}] ${warning.message}`);
        }
        if (secretsDegraded) {
          const recoveredMessage =
            "Secret resolution recovered; runtime remained on last-known-good during the outage.";
          deps.log.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
          deps.emitStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
        }
        secretsDegraded = false;
        return prepared;
      } catch (err) {
        const details = String(err);
        if (!secretsDegraded) {
          deps.log.error(`[SECRETS_RELOADER_DEGRADED] ${details}`);
          if (params.reason !== "startup") {
            deps.emitStateEvent(
              "SECRETS_RELOADER_DEGRADED",
              `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`,
              config,
            );
          }
        } else {
          deps.log.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
        }
        secretsDegraded = true;
        if (params.reason === "startup") {
          throw new Error(`Startup failed: required secrets are unavailable. ${details}`, {
            cause: err,
          });
        }
        throw err;
      }
    });

  return { activateRuntimeSecrets };
}
