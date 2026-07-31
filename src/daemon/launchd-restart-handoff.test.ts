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
    };
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      receiptDirs.push(args[5]);
      fs.writeFileSync(`${args[5]}/ready`, "admitted\n");
      return { pid: 4242, unref: unrefMock };
    });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "kickstart",
      waitForPid: process.pid,
    });

    expect(result).toEqual({ ok: true, pid: 4242 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("openclaw-launchd-restart-lease-owner");
    expect(args[9]).toBe(String(process.pid));
    expect(args[12]).toMatch(/scripts\/lib\/heavy-local-slot\.sh$/);
    expect(args[1]).toContain(
      'openclaw_heavy_local_slot_owner_is_live "$wait_pid" "$wait_pid_start"',
    );
    expect(args[1]).toContain('launchctl kickstart -k "$service_target" >/dev/null 2>&1');
    expect(args[1]).toContain('"$wrapper" --policy gateway-lifecycle --label "$label"');
    expect(args[1]).toContain('if [ "$ack_wait_count" -ge 800 ]; then');
    expect(args[3]).toMatch(/scripts\/with-heavy-local-slot\.sh$/);
    expect(fs.readFileSync(`${args[5]}/ack`, "utf8")).toBe("observed\n");
    expect(args[1]).not.toContain("sleep 1");
    expect(unrefMock).toHaveBeenCalledTimes(1);
  });

  it("passes an optional delay before launchd handoff work", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
    };
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      receiptDirs.push(args[5]);
      fs.writeFileSync(`${args[5]}/ready`, "admitted\n");
      return { pid: 4243, unref: unrefMock };
    });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "kickstart",
      delayMs: 2500,
    });

    expect(result).toEqual({ ok: true, pid: 4243 });
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[9]).toBe("0");
    expect(args[10]).toBe("2500");
    expect(args[1]).toContain('delay_ms="$5"');
    expect(args[1]).toContain('sleep "${delay_seconds}.$(printf');
  });

  it("fails closed before reporting scheduled when the lease contender exits 75", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      receiptDirs.push(args[5]);
      fs.writeFileSync(`${args[5]}/failed`, "75\n");
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
