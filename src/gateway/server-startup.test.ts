import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveGatewaySidecarStartupPolicy, startGatewaySidecars } from "./server-startup.js";

const { restoreDurableFollowupRunsMock } = vi.hoisted(() => ({
  restoreDurableFollowupRunsMock: vi.fn(),
}));

vi.mock("../auto-reply/reply/queue.js", () => ({
  restoreDurableFollowupRuns: restoreDurableFollowupRunsMock,
}));

afterEach(() => {
  restoreDurableFollowupRunsMock.mockReset();
});

function createStartupHarness() {
  const startChannels = vi.fn(async () => {});

  return {
    params: {
      cfg: {} as Parameters<typeof startGatewaySidecars>[0]["cfg"],
      pluginRegistry: {} as Parameters<typeof startGatewaySidecars>[0]["pluginRegistry"],
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as Parameters<typeof startGatewaySidecars>[0]["deps"],
      startChannels,
      log: { warn: vi.fn() },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logBrowser: { error: vi.fn() },
    },
    startChannels,
  };
}

function withStartupSkipEnv<T>(fn: () => Promise<T>) {
  return withEnvAsync(
    {
      VITEST: "1",
      NODE_ENV: "test",
      OPENCLAW_DEBUG_SKIP_SESSION_LOCK_CLEANUP: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DEBUG_SKIP_GMAIL_WATCHER_PHASE: "1",
      OPENCLAW_DEBUG_SKIP_INTERNAL_HOOK_LOADING: "1",
      OPENCLAW_DEBUG_SKIP_PLUGIN_SERVICES: "1",
      OPENCLAW_DEBUG_SKIP_MEMORY_BACKEND_STARTUP: "1",
      OPENCLAW_DEBUG_SKIP_STARTUP_RECONCILER: "1",
    },
    fn,
  );
}

describe("resolveGatewaySidecarStartupPolicy", () => {
  it("keeps browser control enabled for consumer minimal startup", () => {
    const policy = resolveGatewaySidecarStartupPolicy({
      OPENCLAW_CONSUMER_MINIMAL_STARTUP: "1",
    });

    expect(policy.consumerMinimalStartup).toBe(true);
    expect(policy.skipBrowserControl).toBe(false);
    expect(policy.skipSessionLockCleanup).toBe(true);
    expect(policy.skipGmailWatcher).toBe(true);
    expect(policy.skipInternalHookLoading).toBe(true);
    expect(policy.skipPluginServices).toBe(true);
    expect(policy.skipMemoryBackendStartup).toBe(true);
    expect(policy.skipStartupReconciler).toBe(false);
  });

  it("still respects an explicit browser-control skip override", () => {
    const policy = resolveGatewaySidecarStartupPolicy({
      OPENCLAW_CONSUMER_MINIMAL_STARTUP: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    });

    expect(policy.skipBrowserControl).toBe(true);
  });

  it("respects an explicit startup reconciler skip override", () => {
    const policy = resolveGatewaySidecarStartupPolicy({
      OPENCLAW_DEBUG_SKIP_STARTUP_RECONCILER: "1",
    });

    expect(policy.skipStartupReconciler).toBe(true);
  });
});

describe("startGatewaySidecars", () => {
  it("fails closed before channels open when durable restoration is unreadable", async () => {
    const { params, startChannels } = createStartupHarness();
    restoreDurableFollowupRunsMock.mockRejectedValueOnce(new Error("durable queue unreadable"));

    await expect(withStartupSkipEnv(() => startGatewaySidecars(params))).rejects.toThrow(
      "durable queue unreadable",
    );

    expect(startChannels).not.toHaveBeenCalled();
  });

  it("still launches channels after durable restoration succeeds", async () => {
    const { params, startChannels } = createStartupHarness();
    restoreDurableFollowupRunsMock.mockResolvedValueOnce(1);

    await expect(withStartupSkipEnv(() => startGatewaySidecars(params))).resolves.toEqual({
      browserControl: null,
      pluginServices: null,
    });

    expect(restoreDurableFollowupRunsMock).toHaveBeenCalledTimes(1);
    expect(startChannels).toHaveBeenCalledTimes(1);
  });
});
