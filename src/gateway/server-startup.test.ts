import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGatewaySidecarStartupPolicy } from "./server-startup.js";

const {
  getAcpSessionManagerMock,
  cleanStaleLockFilesMock,
  getModelRefStatusMock,
  loadModelCatalogMock,
  resolveAgentSessionDirsMock,
  resolveStateDirMock,
  resolveConfiguredModelRefMock,
  resolveHooksGmailModelMock,
  shouldWakeFromRestartSentinelMock,
  startBrowserControlServerIfEnabledMock,
  startChannelsMock,
} = vi.hoisted(() => ({
  getAcpSessionManagerMock: vi.fn(),
  cleanStaleLockFilesMock: vi.fn(),
  getModelRefStatusMock: vi.fn(),
  loadModelCatalogMock: vi.fn(),
  resolveAgentSessionDirsMock: vi.fn(),
  resolveStateDirMock: vi.fn(),
  resolveConfiguredModelRefMock: vi.fn(),
  resolveHooksGmailModelMock: vi.fn(),
  shouldWakeFromRestartSentinelMock: vi.fn(),
  startBrowserControlServerIfEnabledMock: vi.fn(),
  startChannelsMock: vi.fn(),
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: getAcpSessionManagerMock,
}));

vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: resolveAgentSessionDirsMock,
}));

vi.mock("../agents/session-write-lock.js", () => ({
  cleanStaleLockFiles: cleanStaleLockFilesMock,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: loadModelCatalogMock,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: getModelRefStatusMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
}));

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  resolveStateDir: resolveStateDirMock,
}));

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: vi.fn(),
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  clearInternalHooks: vi.fn(),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(),
}));

vi.mock("../hooks/loader.js", () => ({
  loadInternalHooks: vi.fn(),
}));

vi.mock("../plugins/services.js", () => ({
  startPluginServices: vi.fn(),
}));

vi.mock("./server-browser.js", () => ({
  startBrowserControlServerIfEnabled: startBrowserControlServerIfEnabledMock,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  scheduleRestartSentinelWake: vi.fn(),
  shouldWakeFromRestartSentinel: shouldWakeFromRestartSentinelMock,
}));

vi.mock("./server-startup-memory.js", () => ({
  startGatewayMemoryBackend: vi.fn(),
}));

describe("resolveGatewaySidecarStartupPolicy", () => {
  it("keeps lock cleanup enabled for consumer minimal startup", () => {
    const policy = resolveGatewaySidecarStartupPolicy({
      OPENCLAW_CONSUMER_MINIMAL_STARTUP: "1",
    });

    expect(policy.consumerMinimalStartup).toBe(true);
    expect(policy.skipBrowserControl).toBe(false);
    expect(policy.skipSessionLockCleanup).toBe(false);
    expect(policy.skipGmailWatcher).toBe(true);
    expect(policy.skipInternalHookLoading).toBe(true);
    expect(policy.skipPluginServices).toBe(true);
    expect(policy.skipMemoryBackendStartup).toBe(true);
  });

  it("still respects an explicit browser-control skip override", () => {
    const policy = resolveGatewaySidecarStartupPolicy({
      OPENCLAW_CONSUMER_MINIMAL_STARTUP: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    });

    expect(policy.skipBrowserControl).toBe(true);
  });
});

describe("startGatewaySidecars", () => {
  beforeEach(() => {
    cleanStaleLockFilesMock.mockReset();
    resolveAgentSessionDirsMock.mockReset();
    resolveStateDirMock.mockReset();
    shouldWakeFromRestartSentinelMock.mockReset();
    startBrowserControlServerIfEnabledMock.mockReset();
    startChannelsMock.mockReset();

    vi.stubEnv("OPENCLAW_CONSUMER_MINIMAL_STARTUP", "1");
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "1");

    resolveStateDirMock.mockReturnValue("/tmp/openclaw-state");
    resolveAgentSessionDirsMock.mockResolvedValue(["/tmp/openclaw-state/session-a"]);
    cleanStaleLockFilesMock.mockResolvedValue(undefined);
    startBrowserControlServerIfEnabledMock.mockResolvedValue(null);
    shouldWakeFromRestartSentinelMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs stale session-lock cleanup during consumer minimal startup", async () => {
    const { startGatewaySidecars } = await import("./server-startup.js");

    await startGatewaySidecars({
      cfg: {},
      pluginRegistry: {},
      defaultWorkspaceDir: "/tmp/workspace",
      deps: {},
      startChannels: startChannelsMock,
      log: { warn: vi.fn() },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logBrowser: { error: vi.fn() },
    });

    expect(resolveStateDirMock).toHaveBeenCalledWith(process.env);
    expect(resolveAgentSessionDirsMock).toHaveBeenCalledWith("/tmp/openclaw-state");
    expect(cleanStaleLockFilesMock).toHaveBeenCalledWith({
      sessionsDir: "/tmp/openclaw-state/session-a",
      staleMs: 30 * 60 * 1000,
      removeStale: true,
      log: { warn: expect.any(Function) },
    });
  });
});
