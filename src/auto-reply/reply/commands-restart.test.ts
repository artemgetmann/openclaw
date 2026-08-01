import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { captureFullEnv } from "../../test-utils/env.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const scheduleGatewaySigusr1RestartMock = vi.hoisted(() => vi.fn());
const triggerOpenClawRestartMock = vi.hoisted(() => vi.fn());
const abortReplyWorkForCommandTargetMock = vi.hoisted(() => vi.fn());
const writeRestartSentinelMock = vi.hoisted(() => vi.fn());
const consumeRestartSentinelMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: (...args: unknown[]) => scheduleGatewaySigusr1RestartMock(...args),
  triggerOpenClawRestart: (...args: unknown[]) => triggerOpenClawRestartMock(...args),
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  consumeRestartSentinel: (...args: unknown[]) => consumeRestartSentinelMock(...args),
  writeRestartSentinel: (...args: unknown[]) => writeRestartSentinelMock(...args),
}));

vi.mock("./commands-session-abort.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./commands-session-abort.js")>();
  return {
    ...actual,
    abortReplyWorkForCommandTarget: (...args: unknown[]) =>
      abortReplyWorkForCommandTargetMock(...args),
  };
});

const { handleRestartCommand } = await import("./commands-session.js");

const envSnapshot = captureFullEnv();
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: string) {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

const restartEnabledCfg = {
  commands: { restart: true },
} as OpenClawConfig;

function buildParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildCommandTestParams(commandBody, restartEnabledCfg, overrides);
}

beforeEach(() => {
  scheduleGatewaySigusr1RestartMock.mockReset();
  triggerOpenClawRestartMock.mockReset();
  abortReplyWorkForCommandTargetMock.mockReset();
  writeRestartSentinelMock.mockReset();
  writeRestartSentinelMock.mockResolvedValue("/tmp/restart-sentinel.json");
  consumeRestartSentinelMock.mockReset();
  consumeRestartSentinelMock.mockResolvedValue(null);
});

afterEach(() => {
  envSnapshot.restore();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  vi.restoreAllMocks();
});

describe("handleRestartCommand", () => {
  it.each(["telegram", "whatsapp", "discord"])(
    "queues %s through the guarded run-loop handoff on macOS",
    async (surface) => {
      setPlatform("darwin");
      const callOrder: string[] = [];

      vi.spyOn(process, "listenerCount").mockImplementation((signal) =>
        signal === "SIGUSR1" ? 1 : 0,
      );
      abortReplyWorkForCommandTargetMock.mockImplementation(async () => {
        callOrder.push("abort");
      });

      scheduleGatewaySigusr1RestartMock.mockImplementation(() => {
        callOrder.push("schedule");
      });

      const result = await handleRestartCommand(
        buildParams("/restart", {
          Provider: surface,
          Surface: surface,
          OriginatingChannel: surface,
        }),
        true,
      );

      expect(callOrder).toEqual(["abort", "schedule"]);
      expect(writeRestartSentinelMock).toHaveBeenCalledTimes(1);
      expect(abortReplyWorkForCommandTargetMock).toHaveBeenCalledTimes(1);
      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({ reason: "/restart" });
      expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
      expect(result?.reply?.text).toContain("Restart queued");
    },
  );

  it("uses in-process SIGUSR1 scheduling for empty/unknown surfaces", async () => {
    setPlatform("darwin");
    const callOrder: string[] = [];

    vi.spyOn(process, "listenerCount").mockImplementation((signal) =>
      signal === "SIGUSR1" ? 1 : 0,
    );
    abortReplyWorkForCommandTargetMock.mockImplementation(async () => {
      callOrder.push("abort");
    });
    scheduleGatewaySigusr1RestartMock.mockImplementation(() => {
      callOrder.push("schedule");
    });

    const result = await handleRestartCommand(
      buildParams("/restart", {
        Provider: "",
        Surface: "",
        OriginatingChannel: "",
      }),
      true,
    );

    expect(callOrder).toEqual(["abort", "schedule"]);
    expect(writeRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "restart",
        status: "requested",
        sessionKey: "agent:main:main",
      }),
    );
    expect(abortReplyWorkForCommandTargetMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({ reason: "/restart" });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Restart queued");
  });

  it("persists the current Telegram route before scheduling restart", async () => {
    setPlatform("darwin");
    vi.spyOn(process, "listenerCount").mockImplementation((signal) =>
      signal === "SIGUSR1" ? 1 : 0,
    );

    const result = await handleRestartCommand(
      buildParams("/restart", {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "-100123",
        AccountId: "default",
        MessageThreadId: 77,
      }),
      true,
    );

    expect(writeRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "telegram",
          to: "-100123",
          accountId: "default",
        },
        threadId: "77",
        stats: expect.objectContaining({ mode: "command.restart" }),
      }),
    );
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(result?.reply?.text).toContain("Active work may finish first");
    expect(result?.reply?.text).toContain("confirm here");
  });

  it("does not restart when durable recovery state cannot be saved", async () => {
    writeRestartSentinelMock.mockRejectedValueOnce(new Error("disk full"));
    vi.spyOn(process, "listenerCount").mockReturnValue(1);

    const result = await handleRestartCommand(buildParams("/restart"), true);

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Restart not started");
  });

  it("removes the receipt sentinel when the fallback restart trigger fails", async () => {
    vi.spyOn(process, "listenerCount").mockReturnValue(0);
    triggerOpenClawRestartMock.mockReturnValue({
      ok: false,
      method: "launchctl",
      detail: "service unavailable",
    });

    const result = await handleRestartCommand(buildParams("/restart"), true);

    expect(writeRestartSentinelMock).toHaveBeenCalledTimes(1);
    expect(consumeRestartSentinelMock).toHaveBeenCalledTimes(1);
    expect(result?.reply?.text).toContain("Restart failed");
  });

  it("keeps SIGUSR1 path for Telegram when no local script is configured", async () => {
    setPlatform("darwin");
    const callOrder: string[] = [];
    vi.spyOn(process, "listenerCount").mockImplementation((signal) =>
      signal === "SIGUSR1" ? 1 : 0,
    );
    abortReplyWorkForCommandTargetMock.mockImplementation(async () => {
      callOrder.push("abort");
    });
    scheduleGatewaySigusr1RestartMock.mockImplementation(() => {
      callOrder.push("schedule");
    });

    const result = await handleRestartCommand(
      buildParams("/restart", {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
      }),
      true,
    );

    expect(callOrder).toEqual(["abort", "schedule"]);
    expect(abortReplyWorkForCommandTargetMock).toHaveBeenCalledTimes(1);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({ reason: "/restart" });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Restart queued");
  });

  it("ignores explicit natural-language restart approval phrases", async () => {
    setPlatform("darwin");

    const result = await handleRestartCommand(
      buildParams("Okay I approve. Restart now.", {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
      }),
      true,
    );

    expect(result).toBeNull();
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("ignores conversational restart mentions that are not explicit approvals", async () => {
    setPlatform("darwin");

    const result = await handleRestartCommand(
      buildParams("Can you explain how restart works here?", {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
      }),
      true,
    );

    expect(result).toBeNull();
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });
});
