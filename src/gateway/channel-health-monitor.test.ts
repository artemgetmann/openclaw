import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../channels/plugins/types.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "./server-channels.js";
import type {
  TelegramRecoveryIncident,
  TelegramRecoveryStateStore,
} from "./telegram-recovery-state.js";

function createMemoryRecoveryStore(): TelegramRecoveryStateStore {
  const incidents = new Map<string, TelegramRecoveryIncident>();
  return {
    load: vi.fn(async () => ({
      incidents: new Map(incidents),
      hasUnattributedCorruption: false,
    })),
    set: vi.fn(async (accountId, incident) => {
      incidents.set(accountId, { ...incident });
    }),
    clear: vi.fn(async (accountId) => {
      incidents.delete(accountId);
    }),
  };
}

function createMockChannelManager(overrides?: Partial<ChannelManager>): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => ({ channels: {}, channelAccounts: {} })),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    markChannelLoggedOut: vi.fn(),
    patchChannelStatus: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
    ...overrides,
  };
}

function snapshotWith(
  accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
  for (const [channelId, accts] of Object.entries(accounts)) {
    const resolved: Record<string, ChannelAccountSnapshot> = {};
    for (const [accountId, partial] of Object.entries(accts)) {
      resolved[accountId] = { accountId, ...partial };
    }
    channelAccounts[channelId as ChannelId] = resolved;
    const firstId = Object.keys(accts)[0];
    if (firstId) {
      channels[channelId as ChannelId] = resolved[firstId];
    }
  }
  return { channels, channelAccounts };
}

const DEFAULT_CHECK_INTERVAL_MS = 5_000;

function createSnapshotManager(
  accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>>,
  overrides?: Partial<ChannelManager>,
): ChannelManager {
  const patchChannelStatus = vi.fn(
    (channelId: ChannelId, accountId: string, patch: Partial<ChannelAccountSnapshot>) => {
      const account = accounts[channelId]?.[accountId];
      if (account) {
        Object.assign(account, patch);
      }
    },
  );
  return createMockChannelManager({
    getRuntimeSnapshot: vi.fn(() => snapshotWith(accounts)),
    patchChannelStatus,
    ...overrides,
  });
}

function startDefaultMonitor(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  return startChannelHealthMonitor({
    channelManager: manager,
    checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
    startupGraceMs: 0,
    telegramRecoveryStore: createMemoryRecoveryStore(),
    ...overrides,
  });
}

async function startAndRunCheck(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  const monitor = startDefaultMonitor(manager, overrides);
  const startupGraceMs = overrides.timing?.monitorStartupGraceMs ?? overrides.startupGraceMs ?? 0;
  const checkIntervalMs = overrides.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  await vi.advanceTimersByTimeAsync(startupGraceMs + checkIntervalMs + 1);
  return monitor;
}

function managedStoppedAccount(lastError: string): Partial<ChannelAccountSnapshot> {
  return {
    running: false,
    enabled: true,
    configured: true,
    lastError,
  };
}

function runningConnectedSlackAccount(
  overrides: Partial<ChannelAccountSnapshot>,
): Partial<ChannelAccountSnapshot> {
  return {
    running: true,
    connected: true,
    enabled: true,
    configured: true,
    ...overrides,
  };
}

function createSlackSnapshotManager(
  account: Partial<ChannelAccountSnapshot>,
  overrides?: Partial<ChannelManager>,
): ChannelManager {
  return createSnapshotManager(
    {
      slack: {
        default: account,
      },
    },
    overrides,
  );
}

function createBusyDisconnectedManager(lastRunActivityAt: number): ChannelManager {
  const now = Date.now();
  return createSnapshotManager({
    discord: {
      default: {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: now - 300_000,
        activeRuns: 1,
        busy: true,
        lastRunActivityAt,
      },
    },
  });
}

async function expectRestartedChannel(
  manager: ChannelManager,
  channel: ChannelId,
  accountId = "default",
) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.stopChannel).toHaveBeenCalledWith(channel, accountId);
  expect(manager.startChannel).toHaveBeenCalledWith(channel, accountId);
  monitor.stop();
}

async function expectNoRestart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.stopChannel).not.toHaveBeenCalled();
  expect(manager.startChannel).not.toHaveBeenCalled();
  monitor.stop();
}

async function expectNoStart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.startChannel).not.toHaveBeenCalled();
  monitor.stop();
}

describe("channel-health-monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run before the grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager, { startupGraceMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("runs health check after grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = await startAndRunCheck(manager, { startupGraceMs: 1_000 });
    expect(manager.getRuntimeSnapshot).toHaveBeenCalled();
    monitor.stop();
  });

  it("accepts timing.monitorStartupGraceMs", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager, { timing: { monitorStartupGraceMs: 60_000 } });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips healthy channels (running + connected)", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: { running: true, connected: true, enabled: true, configured: true },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips disabled channels", async () => {
    const manager = createSnapshotManager({
      imessage: {
        default: {
          running: false,
          enabled: false,
          configured: true,
          lastError: "disabled",
        },
      },
    });
    await expectNoStart(manager);
  });

  it("skips unconfigured channels", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: { running: false, enabled: true, configured: false },
      },
    });
    await expectNoStart(manager);
  });

  it("skips manually stopped channels", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: { running: false, enabled: true, configured: true },
        },
      },
      { isManuallyStopped: vi.fn(() => true) },
    );
    await expectNoStart(manager);
  });

  it("skips channels with health monitor disabled globally for that account", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: { running: false, enabled: true, configured: true },
        },
      },
      { isHealthMonitorEnabled: vi.fn(() => false) },
    );
    await expectNoStart(manager);
  });

  it("still restarts enabled accounts when another account on the same channel is disabled", async () => {
    const now = Date.now();
    const manager = createSnapshotManager(
      {
        discord: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: now - 300_000,
          },
          quiet: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: now - 300_000,
          },
        },
      },
      {
        isHealthMonitorEnabled: vi.fn((channelId: ChannelId, accountId: string) => {
          return !(channelId === "discord" && accountId === "quiet");
        }),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    expect(manager.stopChannel).not.toHaveBeenCalledWith("discord", "quiet");
    expect(manager.startChannel).not.toHaveBeenCalledWith("discord", "quiet");
    monitor.stop();
  });

  it("restarts a stuck channel (running but not connected)", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      whatsapp: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          linked: true,
          lastStartAt: now - 300_000,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("whatsapp", "default");
    monitor.stop();
  });

  it("skips restart when channel is busy with active runs", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: now - 300_000,
          activeRuns: 2,
          busy: true,
          lastRunActivityAt: now - 30_000,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("restarts busy channels when run activity is stale", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 26 * 60_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("restarts disconnected channels when busy flags are inherited from a prior lifecycle", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 301_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("skips recently-started channels while they are still connecting", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: now - 5_000,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("respects custom per-channel startup grace", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: now - 30_000,
        },
      },
    });
    const monitor = await startAndRunCheck(manager, { channelStartupGraceMs: 60_000 });
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("restarts a stopped channel that gave up (reconnectAttempts >= 10)", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: {
          ...managedStoppedAccount("Failed to resolve Discord application id"),
          reconnectAttempts: 10,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    monitor.stop();
  });

  it("restarts a channel that stopped unexpectedly (not running, not manual)", async () => {
    const manager = createSnapshotManager({
      telegram: {
        default: managedStoppedAccount("polling stopped unexpectedly"),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("telegram", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("treats missing enabled/configured flags as managed accounts", async () => {
    const manager = createSnapshotManager({
      telegram: {
        default: {
          running: false,
          lastError: "polling stopped unexpectedly",
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("applies cooldown — skips recently restarted channels for 2 cycles", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: managedStoppedAccount("crashed"),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("caps at 3 health-monitor restarts per channel per hour", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: managedStoppedAccount("keeps crashing"),
      },
    });
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 1_000,
      cooldownCycles: 1,
      maxRestartsPerHour: 3,
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it("runs checks single-flight when restart work is still in progress", async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = () => resolve();
    });
    const manager = createSnapshotManager(
      {
        telegram: {
          default: managedStoppedAccount("stopped"),
        },
      },
      {
        startChannel: vi.fn(async () => {
          await startGate;
        }),
      },
    );
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });
    await vi.advanceTimersByTimeAsync(120);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    releaseStart?.();
    await Promise.resolve();
    monitor.stop();
  });

  it("stops cleanly", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("stops via abort signal", async () => {
    const manager = createMockChannelManager();
    const abort = new AbortController();
    const monitor = startDefaultMonitor(manager, { abortSignal: abort.signal });
    abort.abort();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("treats running channels without a connected field as healthy", async () => {
    const manager = createSnapshotManager({
      slack: {
        default: { running: true, enabled: true, configured: true },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  describe("stale socket detection", () => {
    const STALE_THRESHOLD = 30 * 60_000;

    it("restarts a channel with no events past the stale threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastEventAt: now - STALE_THRESHOLD - 30_000,
        }),
      );
      await expectRestartedChannel(manager, "slack");
    });

    it("skips channels with recent events", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastEventAt: now - 5_000,
        }),
      );
      await expectNoRestart(manager);
    });

    it("skips channels still within the startup grace window for stale detection", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - 5_000,
          lastEventAt: null,
        }),
      );
      await expectNoRestart(manager);
    });

    it("restarts a channel that has seen no events since connect past the stale threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastEventAt: now - STALE_THRESHOLD - 60_000,
        }),
      );
      await expectRestartedChannel(manager, "slack");
    });

    it("skips connected channels that do not report event liveness", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: now - STALE_THRESHOLD - 60_000,
            lastEventAt: null,
          },
        },
      });
      await expectNoRestart(manager);
    });

    it("does not restart quiet healthy Telegram polling accounts with old chat events", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - STALE_THRESHOLD - 60_000,
            lastEventAt: now - STALE_THRESHOLD - 30_000,
            transportActivity: {
              mode: "polling",
              active: false,
              inFlight: 0,
              lastCompletedAt: now - 5_000,
              lastOutcome: "completed",
              lastError: null,
            },
          },
        },
      });
      await expectNoRestart(manager);
    });

    it("restarts unhealthy Telegram polling accounts reported by the watchdog", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastError: "Telegram polling unhealthy: repeated polling stalls",
            transportActivity: {
              mode: "polling",
              watchdog: {
                escalation: "Telegram polling unhealthy: repeated polling stalls",
              },
            },
          },
        },
      });
      await expectRestartedChannel(manager, "telegram");
    });

    it("restarts a stalled Telegram poller despite refreshed grace without duplicate starts", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            // The internal polling cycle refreshes this lifecycle marker. It
            // must not turn an already-observed stall back into startup state.
            lastStartAt: now - 1_000,
            lastPollSuccessAt: null,
            lastPollOutcome: "stalled",
            transportActivity: {
              mode: "polling",
              restartAttempts: 1,
            },
          },
        },
      });
      const monitor = await startAndRunCheck(manager);

      expect(manager.stopChannel).toHaveBeenCalledTimes(1);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS * 2);
      expect(manager.stopChannel).toHaveBeenCalledTimes(1);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it("requests a gateway restart instead of starting a duplicate channel when stop hangs", async () => {
      const now = Date.now();
      // Legacy callbacks returned void. They remain accepted while new callers
      // can return `{ok:false}` to make rejection observable.
      const requestGatewayRestart = vi.fn();
      const manager = createSnapshotManager(
        {
          telegram: {
            default: {
              running: true,
              connected: false,
              enabled: true,
              configured: true,
              mode: "polling",
              lastStartAt: now - 300_000,
              lastPollOutcome: "unhealthy",
              lastError: "Telegram polling unhealthy: repeated polling stop timeouts",
            },
          },
          discord: {
            default: {
              running: false,
              connected: false,
              enabled: true,
              configured: true,
              lastError: "stopped after Telegram polling wedged",
            },
          },
        },
        {
          stopChannel: vi.fn(() => new Promise<void>(() => undefined)),
        },
      );

      const monitor = startDefaultMonitor(manager, {
        requestGatewayRestart,
        restartStopTimeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(manager.stopChannel).toHaveBeenCalledWith("telegram", "default");
      expect(manager.startChannel).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(51);
      expect(requestGatewayRestart).toHaveBeenCalledWith(
        "telegram:default health-monitor stop timed out",
      );
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      expect(manager.startChannel).not.toHaveBeenCalled();
      expect(manager.patchChannelStatus).toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: expect.objectContaining({
          phase: "gateway-restart-requested",
          reason: "telegram:default health-monitor stop timed out",
        }),
      });

      vi.mocked(manager.getRuntimeSnapshot).mockReturnValue(
        snapshotWith({
          telegram: {
            default: {
              running: false,
              connected: false,
              enabled: true,
              configured: true,
              mode: "polling",
              lastPollOutcome: "unhealthy",
              lastError: "Telegram polling unhealthy: repeated polling stop timeouts",
            },
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      expect(manager.startChannel).not.toHaveBeenCalled();
      monitor.stop();
    });

    it("escalates repeatedly unhealthy Telegram polling to one bounded gateway restart", async () => {
      const now = Date.now();
      const requestGatewayRestart = vi.fn(() => ({ ok: true }));
      const telegramRecoveryStore = createMemoryRecoveryStore();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "unhealthy",
          },
        },
      });
      const monitor = startDefaultMonitor(manager, {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
        requestGatewayRestart,
        telegramRecoveryStore,
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(manager.stopChannel).toHaveBeenCalledTimes(1);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);
      expect(manager.patchChannelStatus).toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: expect.objectContaining({
          phase: "provider-restart",
          providerRestartAttempts: 1,
        }),
      });
      expect(vi.mocked(telegramRecoveryStore.set).mock.invocationCallOrder[0] ?? 0).toBeLessThan(
        vi.mocked(manager.stopChannel).mock.invocationCallOrder[0] ?? 0,
      );

      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      const gatewayStateWrite = vi
        .mocked(telegramRecoveryStore.set)
        .mock.invocationCallOrder.at(-1);
      expect(gatewayStateWrite ?? 0).toBeLessThan(
        requestGatewayRestart.mock.invocationCallOrder[0] ?? 0,
      );
      expect(manager.stopChannel).toHaveBeenCalledTimes(1);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS * 3);
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it("marks Telegram recovery exhausted when a gateway restart request is rejected", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "unhealthy",
            telegramRecovery: {
              phase: "provider-restart",
              providerRestartAttempts: 1,
              updatedAt: now - 10_000,
            },
          },
        },
      });
      const requestGatewayRestart = vi.fn(() => ({ ok: false }));
      const monitor = await startAndRunCheck(manager, {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
        requestGatewayRestart,
      });

      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      expect(manager.patchChannelStatus).toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: expect.objectContaining({
          phase: "exhausted",
          providerRestartAttempts: 1,
        }),
      });
      monitor.stop();
    });

    it("marks an accepted gateway restart exhausted when the old process survives verification", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "unhealthy",
            telegramRecovery: {
              phase: "provider-restart",
              providerRestartAttempts: 1,
              updatedAt: now - 10_000,
            },
          },
        },
      });
      const requestGatewayRestart = vi.fn(() => ({ ok: true }));
      const monitor = await startAndRunCheck(manager, {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
        requestGatewayRestart,
        gatewayRestartVerificationTimeoutMs: 50,
      });

      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      expect(manager.patchChannelStatus).toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: expect.objectContaining({ phase: "gateway-restart-requested" }),
      });

      await vi.advanceTimersByTimeAsync(51);
      expect(manager.patchChannelStatus).toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: expect.objectContaining({
          phase: "exhausted",
          reason: expect.stringContaining("could not be verified"),
        }),
      });
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it("resumes persisted gateway restart verification after a monitor hot reload", async () => {
      const now = Date.now();
      const accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>> = {
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "unhealthy",
            telegramRecovery: {
              phase: "provider-restart" as const,
              providerRestartAttempts: 1,
              updatedAt: now - 10_000,
            },
          },
        },
      };
      const requestGatewayRestart = vi.fn(() => ({ ok: true }));
      const manager = createSnapshotManager(accounts);
      const oldMonitor = startDefaultMonitor(manager, {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
        requestGatewayRestart,
        gatewayRestartVerificationTimeoutMs: 10_000,
      });

      // The original instance accepts one restart request, then a config reload
      // stops it and clears only its in-memory verification timer.
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      oldMonitor.stop();

      const replacementMonitor = startDefaultMonitor(manager, {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
        requestGatewayRestart,
        gatewayRestartVerificationTimeoutMs: 10_000,
      });

      // The replacement sees the durable incident but must not ask to restart
      // again. It reuses the original deadline rather than waiting forever.
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(accounts.telegram.default.telegramRecovery).toMatchObject({
        phase: "exhausted",
        reason: expect.stringContaining("could not be verified"),
      });
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      replacementMonitor.stop();
    });

    it("restores gateway restart authority into a replacement ChannelManager without a duplicate request", async () => {
      const now = Date.now();
      const telegramRecoveryStore = createMemoryRecoveryStore();
      const requestGatewayRestart = vi.fn(() => ({ ok: true }));
      const originalAccounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>> = {
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "unhealthy",
            telegramRecovery: {
              phase: "provider-restart",
              providerRestartAttempts: 1,
              updatedAt: now - 10_000,
            },
          },
        },
      };
      const original = startDefaultMonitor(createSnapshotManager(originalAccounts), {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
        requestGatewayRestart,
        gatewayRestartVerificationTimeoutMs: 10_000,
        telegramRecoveryStore,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      original.stop();

      // SIGUSR1 server recreation constructs a new manager with no runtime
      // overlay. The durable store is the only bridge across that lifecycle.
      const replacementAccounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>> = {
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: Date.now() - 300_000,
            lastPollOutcome: "unhealthy",
          },
        },
      };
      const replacement = startDefaultMonitor(createSnapshotManager(replacementAccounts), {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
        requestGatewayRestart,
        gatewayRestartVerificationTimeoutMs: 10_000,
        telegramRecoveryStore,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);

      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      expect(replacementAccounts.telegram.default.telegramRecovery).toMatchObject({
        phase: "gateway-restart-requested",
        providerRestartAttempts: 1,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(replacementAccounts.telegram.default.telegramRecovery).toMatchObject({
        phase: "exhausted",
        providerRestartAttempts: 1,
      });
      expect(requestGatewayRestart).toHaveBeenCalledTimes(1);
      replacement.stop();
    });

    it("clears restored durable authority only after post-incident polling proof", async () => {
      const now = Date.now();
      const telegramRecoveryStore = createMemoryRecoveryStore();
      await telegramRecoveryStore.set("default", {
        phase: "exhausted",
        providerRestartAttempts: 2,
        updatedAt: now - 1_000,
      });
      const accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>> = {
        telegram: {
          default: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            mode: "polling",
            lastPollOutcome: "in-flight",
            lastPollSuccessAt: now,
          },
        },
      };

      const monitor = await startAndRunCheck(createSnapshotManager(accounts), {
        telegramRecoveryStore,
      });

      expect(accounts.telegram.default.telegramRecovery).toBeUndefined();
      expect((await telegramRecoveryStore.load()).incidents.size).toBe(0);
      monitor.stop();
    });

    it("clears accepted gateway restart recovery when fresh polling proof arrives during verification", async () => {
      const now = Date.now();
      const accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>> = {
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "unhealthy",
            telegramRecovery: {
              phase: "provider-restart" as const,
              providerRestartAttempts: 1,
              updatedAt: now - 10_000,
            },
          },
        },
      };
      const manager = createSnapshotManager(accounts);
      const monitor = await startAndRunCheck(manager, {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
        requestGatewayRestart: vi.fn(() => ({ ok: true })),
        gatewayRestartVerificationTimeoutMs: 50,
      });

      // This timestamp is after the durable restart request and within the
      // freshness window, so it is stronger evidence than PID survival.
      accounts.telegram.default.lastPollSuccessAt = Date.now();
      await vi.advanceTimersByTimeAsync(51);

      expect(accounts.telegram.default.telegramRecovery).toBeUndefined();
      expect(manager.patchChannelStatus).not.toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: expect.objectContaining({ phase: "exhausted" }),
      });
      monitor.stop();
    });

    it("marks Telegram recovery exhausted when gateway restart is unavailable", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "unhealthy",
            telegramRecovery: {
              phase: "provider-restart",
              providerRestartAttempts: 1,
              updatedAt: now - 10_000,
            },
          },
        },
      });
      const monitor = await startAndRunCheck(manager, {
        cooldownCycles: 0,
        maxTelegramProviderRestarts: 1,
      });

      expect(manager.patchChannelStatus).toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: expect.objectContaining({ phase: "exhausted" }),
      });
      monitor.stop();
    });

    it("marks Telegram recovery exhausted when the provider restart rate limit is spent", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "unhealthy",
          },
        },
      });
      const monitor = await startAndRunCheck(manager, { maxRestartsPerHour: 0 });

      expect(manager.stopChannel).not.toHaveBeenCalled();
      expect(manager.startChannel).not.toHaveBeenCalled();
      expect(manager.patchChannelStatus).toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: expect.objectContaining({
          phase: "exhausted",
          providerRestartAttempts: 0,
        }),
      });
      monitor.stop();
    });

    it("clears Telegram recovery only after a recent completed getUpdates poll", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            mode: "polling",
            lastPollOutcome: "in-flight",
            lastPollCompletedAt: now - 1_000,
            lastPollSuccessAt: now - 1_000,
            telegramRecovery: {
              phase: "provider-restart",
              providerRestartAttempts: 1,
              updatedAt: now - 5_000,
            },
          },
        },
      });
      const monitor = await startAndRunCheck(manager);

      expect(manager.patchChannelStatus).toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: undefined,
      });
      expect(manager.stopChannel).not.toHaveBeenCalled();
      monitor.stop();
    });

    it("does not clear recovery from connected state without recent completed polling proof", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - 300_000,
            lastPollOutcome: "completed",
            lastPollCompletedAt: now - 180_001,
            lastPollSuccessAt: now - 180_001,
            telegramRecovery: {
              phase: "provider-restart",
              providerRestartAttempts: 1,
              updatedAt: now - 5_000,
            },
          },
        },
      });
      const monitor = await startAndRunCheck(manager, { maxTelegramProviderRestarts: 2 });

      expect(manager.patchChannelStatus).not.toHaveBeenCalledWith("telegram", "default", {
        telegramRecovery: undefined,
      });
      expect(manager.stopChannel).toHaveBeenCalledWith("telegram", "default");
      monitor.stop();
    });

    it("restarts polling Telegram accounts that report unhealthy transport state", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            mode: "polling",
            lastStartAt: now - STALE_THRESHOLD - 60_000,
            lastEventAt: null,
            lastPollOutcome: "unhealthy",
            lastError: "Telegram polling unhealthy: repeated polling stalls",
          },
        },
      });
      await expectRestartedChannel(manager, "telegram");
    });

    it("respects custom staleEventThresholdMs", async () => {
      const customThreshold = 10 * 60_000;
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - customThreshold - 60_000,
          lastEventAt: now - customThreshold - 30_000,
        }),
      );
      const monitor = await startAndRunCheck(manager, {
        staleEventThresholdMs: customThreshold,
      });
      expect(manager.stopChannel).toHaveBeenCalledWith("slack", "default");
      expect(manager.startChannel).toHaveBeenCalledWith("slack", "default");
      monitor.stop();
    });
  });
});
