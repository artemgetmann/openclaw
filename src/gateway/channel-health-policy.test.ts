import { describe, expect, it } from "vitest";
import { evaluateChannelHealth, resolveChannelRestartReason } from "./channel-health-policy.js";

function evaluateDiscordHealth(
  account: Record<string, unknown>,
  now = 100_000,
  channelId = "discord",
) {
  return evaluateChannelHealth(account, {
    channelId,
    now,
    channelConnectGraceMs: 10_000,
    staleEventThresholdMs: 30_000,
  });
}

describe("evaluateChannelHealth", () => {
  it("treats disabled accounts as healthy unmanaged", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: false,
        enabled: false,
        configured: true,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: 95_000,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("does not let a refreshed start time mask an explicit Telegram polling stall", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        mode: "polling",
        lastStartAt: 99_000,
        lastPollSuccessAt: null,
        lastPollOutcome: "stalled",
        transportActivity: {
          mode: "polling",
        },
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("preserves connect grace for a Telegram poller that is genuinely starting", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        mode: "polling",
        lastStartAt: 99_000,
        lastPollSuccessAt: null,
        lastPollOutcome: "in-flight",
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 30_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags stale busy channels as stuck when run activity is too old", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 26 * 60_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags stale sockets when no events arrive beyond threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("skips stale-socket detection for telegram long-polling channels", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: null,
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags Telegram polling watchdog escalation without using stale-event checks", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        mode: "polling",
        lastEventAt: null,
        transportActivity: {
          mode: "polling",
          watchdog: {
            escalation: "Telegram polling unhealthy: repeated polling stalls",
          },
        },
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("keeps recent successful polling proof while the next request is in flight", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        mode: "polling",
        // The next long poll starts immediately after the successful request.
        // Recovery must follow the sticky proof, not this latest-state field.
        lastPollOutcome: "in-flight",
        lastPollCompletedAt: 99_000,
        lastPollSuccessAt: 99_000,
        telegramRecovery: {
          phase: "provider-restart",
          providerRestartAttempts: 1,
          updatedAt: 90_000,
        },
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not treat connected Telegram polling as recovered when completed polling proof is stale", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        mode: "polling",
        lastPollOutcome: "in-flight",
        lastPollCompletedAt: 99_000,
        lastPollSuccessAt: 100_000 - 180_001,
        telegramRecovery: {
          phase: "provider-restart",
          providerRestartAttempts: 1,
          updatedAt: 90_000,
        },
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it.each([
    ["missing after an error", undefined],
    ["at the incident boundary", 90_000],
    ["before the incident", 89_999],
  ])("does not recover Telegram when success proof is %s", (_case, lastPollSuccessAt) => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        mode: "polling",
        lastPollOutcome: "error",
        lastPollCompletedAt: 99_000,
        lastPollSuccessAt,
        telegramRecovery: {
          phase: "provider-restart",
          providerRestartAttempts: 1,
          updatedAt: 90_000,
        },
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("skips stale-socket detection for channels in webhook mode", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lastStartAt: 0,
      lastEventAt: 0,
      mode: "webhook",
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets for channels without event tracking", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lastStartAt: 0,
      lastEventAt: null,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets without an active connected socket", () => {
    const evaluation = evaluateDiscordHealth(
      {
        running: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("ignores inherited event timestamps from a previous lifecycle", () => {
    const evaluation = evaluateDiscordHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastEventAt: 10_000,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags inherited event timestamps after the lifecycle exceeds the stale threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastEventAt: 10_000,
      },
      {
        channelId: "slack",
        now: 140_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });
});

describe("resolveChannelRestartReason", () => {
  it("maps not-running + high reconnect attempts to gave-up", () => {
    const reason = resolveChannelRestartReason(
      {
        running: false,
        reconnectAttempts: 10,
      },
      { healthy: false, reason: "not-running" },
    );
    expect(reason).toBe("gave-up");
  });

  it("maps disconnected to disconnected instead of stuck", () => {
    const reason = resolveChannelRestartReason(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
      },
      { healthy: false, reason: "disconnected" },
    );
    expect(reason).toBe("disconnected");
  });
});
