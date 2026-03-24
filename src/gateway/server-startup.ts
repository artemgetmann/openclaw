import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { ACP_SESSION_IDENTITY_RENDERER_VERSION } from "../acp/runtime/session-identifiers.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles } from "../agents/session-write-lock.js";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

export function resolveGatewaySidecarStartupPolicy(env: NodeJS.ProcessEnv) {
  const consumerMinimalStartup = isTruthyEnvValue(env.OPENCLAW_CONSUMER_MINIMAL_STARTUP);
  return {
    consumerMinimalStartup,
    skipSessionLockCleanup:
      consumerMinimalStartup || isTruthyEnvValue(env.OPENCLAW_DEBUG_SKIP_SESSION_LOCK_CLEANUP),
    // Consumer onboarding depends on browser readiness. Keep the browser control server
    // available even in "minimal startup" mode so the first-run path can actually verify
    // the selected Chrome profile instead of failing every browser.request as UNAVAILABLE.
    skipBrowserControl: isTruthyEnvValue(env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER),
    skipGmailWatcher:
      consumerMinimalStartup || isTruthyEnvValue(env.OPENCLAW_DEBUG_SKIP_GMAIL_WATCHER_PHASE),
    skipInternalHookLoading:
      consumerMinimalStartup || isTruthyEnvValue(env.OPENCLAW_DEBUG_SKIP_INTERNAL_HOOK_LOADING),
    skipPluginServices:
      consumerMinimalStartup || isTruthyEnvValue(env.OPENCLAW_DEBUG_SKIP_PLUGIN_SERVICES),
    skipMemoryBackendStartup:
      consumerMinimalStartup || isTruthyEnvValue(env.OPENCLAW_DEBUG_SKIP_MEMORY_BACKEND_STARTUP),
  };
}

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
}) {
  const debugStartupPhases = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_STARTUP_PHASES);
  const debugStartupPhasesRaw = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_STARTUP_PHASES_RAW);
  const policy = resolveGatewaySidecarStartupPolicy(process.env);
  const consumerMinimalStartup = policy.consumerMinimalStartup;
  const skipSessionLockCleanup = policy.skipSessionLockCleanup;
  const skipBrowserControl = policy.skipBrowserControl;
  const skipGmailWatcher = policy.skipGmailWatcher;
  const skipInternalHookLoading = policy.skipInternalHookLoading;
  const skipPluginServices = policy.skipPluginServices;
  const skipMemoryBackendStartup = policy.skipMemoryBackendStartup;
  const logPhase = (message: string) => {
    if (debugStartupPhasesRaw) {
      process.stderr.write(`[startup/sidecars/raw] ${message}\n`);
    }
    if (!debugStartupPhases) {
      return;
    }
    params.log.warn(`[startup/sidecars] ${message}`);
  };

  logPhase("begin");
  try {
    if (!skipSessionLockCleanup) {
      const stateDir = resolveStateDir(process.env);
      const sessionDirs = await resolveAgentSessionDirs(stateDir);
      logPhase(`session cleanup scanning ${sessionDirs.length} session dir(s)`);
      for (const sessionsDir of sessionDirs) {
        await cleanStaleLockFiles({
          sessionsDir,
          staleMs: SESSION_LOCK_STALE_MS,
          removeStale: true,
          log: { warn: (message) => params.log.warn(message) },
        });
      }
    }
    logPhase("session cleanup complete");
  } catch (err) {
    params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
  }

  // Start OpenClaw browser control server (unless disabled via config).
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  if (skipBrowserControl) {
    logPhase("browser control startup skipped");
  } else {
    try {
      browserControl = await startBrowserControlServerIfEnabled();
      logPhase("browser control startup complete");
    } catch (err) {
      params.logBrowser.error(`server failed to start: ${String(err)}`);
    }
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  if (!skipGmailWatcher) {
    await startGmailWatcherWithLogs({
      cfg: params.cfg,
      log: params.logHooks,
    });
  }
  logPhase("gmail watcher startup complete");

  // Validate hooks.gmail.model if configured.
  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }
  logPhase("hooks.gmail model validation complete");

  // Load internal hook handlers from configuration and directory discovery.
  if (!skipInternalHookLoading) {
    try {
      // Clear any previously registered hooks to ensure fresh loading
      clearInternalHooks();
      const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
      if (loadedCount > 0) {
        params.logHooks.info(
          `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
        );
      }
      logPhase(`internal hook loading complete (${loadedCount})`);
    } catch (err) {
      params.logHooks.error(`failed to load hooks: ${String(err)}`);
    }
  } else {
    logPhase("internal hook loading skipped");
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via OPENCLAW_SKIP_CHANNELS (or legacy OPENCLAW_SKIP_PROVIDERS).
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels) {
    if (consumerMinimalStartup) {
      setTimeout(() => {
        void params
          .startChannels()
          .then(() => {
            logPhase("channel startup complete");
          })
          .catch((err) => {
            params.logChannels.error(`channel startup failed: ${String(err)}`);
          });
      }, 0);
      logPhase("channel startup scheduled (background)");
    } else {
      try {
        await params.startChannels();
        logPhase("channel startup complete");
      } catch (err) {
        params.logChannels.error(`channel startup failed: ${String(err)}`);
      }
    }
  } else {
    params.logChannels.info(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
    logPhase("channel startup skipped");
  }

  if (params.cfg.hooks?.internal?.enabled) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  if (!skipPluginServices) {
    try {
      pluginServices = await startPluginServices({
        registry: params.pluginRegistry,
        config: params.cfg,
        workspaceDir: params.defaultWorkspaceDir,
      });
      logPhase("plugin services startup complete");
    } catch (err) {
      params.log.warn(`plugin services failed to start: ${String(err)}`);
    }
  } else {
    logPhase("plugin services startup skipped");
  }

  if (params.cfg.acp?.enabled) {
    void getAcpSessionManager()
      .reconcilePendingSessionIdentities({ cfg: params.cfg })
      .then((result) => {
        if (result.checked === 0) {
          return;
        }
        params.log.warn(
          `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
        );
      })
      .catch((err) => {
        params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
      });
  }

  if (!skipMemoryBackendStartup) {
    void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
      params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
    });
    logPhase("memory backend startup scheduled");
  } else {
    logPhase("memory backend startup skipped");
  }

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }
  logPhase("complete");

  return { browserControl, pluginServices };
}
