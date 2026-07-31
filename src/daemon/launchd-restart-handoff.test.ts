import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const unrefMock = vi.hoisted(() => vi.fn());
const receiptDirs: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import {
  isCurrentProcessLaunchdServiceLabel,
  scheduleDetachedLaunchdRestartHandoff,
} from "./launchd-restart-handoff.js";

afterEach(() => {
  for (const receiptDir of receiptDirs.splice(0)) {
    fs.rmSync(receiptDir, { recursive: true, force: true });
  }
  spawnMock.mockReset();
  unrefMock.mockReset();
});

describe("scheduleDetachedLaunchdRestartHandoff", () => {
  it("waits for the caller pid before kickstarting launchd", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "default",
      OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN: "a".repeat(64),
    };
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      receiptDirs.push(args[6]);
      fs.writeFileSync(`${args[6]}/ready`, "admitted\n");
      return { pid: 4242, unref: unrefMock };
    });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "kickstart",
      waitForPid: process.pid,
    });

    expect(result).toEqual({ ok: true, pid: 4242, cancel: expect.any(Function) });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    const lifecycleCommand = fs.readFileSync(args[4], "utf8");
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("openclaw-launchd-restart-lease-owner");
    expect(args[7]).toBe("kickstart");
    expect(args[11]).toBe(String(process.pid));
    expect(args[14]).toBeTruthy();
    expect(args[15]).toMatch(/scripts\/lib\/heavy-local-slot\.sh$/);
    expect(lifecycleCommand).toContain(
      'openclaw_heavy_local_slot_owner_is_live "$wait_pid" "$wait_pid_start"',
    );
    expect(lifecycleCommand).toContain('launchctl kickstart -k "$service_target" >/dev/null 2>&1');
    expect(args[1]).toContain('"$wrapper" --policy gateway-lifecycle --label "$label"');
    expect(lifecycleCommand).toContain('[[ "$ack_wait_count" -lt 800 ]]');
    expect(args[3]).toMatch(/scripts\/with-heavy-local-slot\.sh$/);
    expect(args[4]).toMatch(/scripts\/gateway-lifecycle-command\.sh$/);
    expect(options.env.OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN).toBeUndefined();
    expect(fs.readFileSync(`${args[6]}/ack`, "utf8")).toBe("observed\n");
    expect(result.cancel?.()).toBe(true);
    expect(fs.readFileSync(`${args[6]}/cancel`, "utf8")).toBe("stop superseded restart\n");
    expect(args[1]).not.toContain("sleep 1");
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it("passes an optional delay before launchd handoff work", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
    };
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      receiptDirs.push(args[6]);
      fs.writeFileSync(`${args[6]}/ready`, "admitted\n");
      return { pid: 4243, unref: unrefMock };
    });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "kickstart",
      delayMs: 2500,
    });

    expect(result).toEqual({ ok: true, pid: 4243, cancel: expect.any(Function) });
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const lifecycleCommand = fs.readFileSync(args[4], "utf8");
    expect(args[11]).toBe("0");
    expect(args[12]).toBe("2500");
    expect(lifecycleCommand).toContain('local delay_ms="$6"');
    expect(lifecycleCommand).toContain('sleep "${delay_seconds}.$(printf');
    expect(lifecycleCommand).toContain('[[ ! -f "$cancel_path" ]]');
  });

  it("fails closed before reporting scheduled when the lease contender exits 75", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      receiptDirs.push(args[6]);
      fs.writeFileSync(`${args[6]}/failed`, "75\n");
      return { pid: 4244, unref: unrefMock };
    });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
      mode: "kickstart",
    });

    expect(result).toEqual({
      ok: false,
      detail: "machine-wide gateway lifecycle lease unavailable (exit 75)",
    });
    expect(unrefMock).not.toHaveBeenCalled();
  });

  it("fails closed when the caller PID/start identity cannot be proven", () => {
    const result = scheduleDetachedLaunchdRestartHandoff({
      env: { HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
      mode: "start-after-exit",
      waitForPid: 2_147_483_647,
    });

    expect(result).toEqual({
      ok: false,
      detail: "could not prove restart caller PID/start identity",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("isCurrentProcessLaunchdServiceLabel", () => {
  it("rejects a launchd-labeled subprocess when launchd owns a different pid", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel(
        "ai.jarvis.gateway",
        { XPC_SERVICE_NAME: "ai.jarvis.gateway" },
        () => `state = running\npid = ${process.pid + 1}\n`,
      ),
    ).toBe(false);
  });

  it("accepts only the exact launchd-owned gateway pid", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel(
        "ai.jarvis.gateway",
        { LAUNCH_JOB_LABEL: "ai.jarvis.gateway" },
        () => `state = running\npid = ${process.pid}\n`,
      ),
    ).toBe(true);
  });

  it("stays conservative when matching launchd ownership is unreadable", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel(
        "ai.jarvis.gateway",
        { OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway" },
        () => null,
      ),
    ).toBe(true);
  });
});
