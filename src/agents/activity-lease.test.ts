import { describe, expect, it, vi } from "vitest";
import { createAgentActivityLease } from "./activity-lease.js";

describe("agent activity lease", () => {
  it("expires at the original timeout when no activity is observed", () => {
    const lease = createAgentActivityLease({ timeoutMs: 1_000, nowMs: 10_000 });

    expect(lease.nextDelayMs(10_999)).toBe(1);
    expect(lease.nextDelayMs(11_000)).toBe(0);
  });

  it("renews the idle window when real activity is observed", () => {
    const lease = createAgentActivityLease({ timeoutMs: 1_000, nowMs: 10_000 });

    lease.touch(10_900);

    expect(lease.nextDelayMs(11_000)).toBe(900);
    expect(lease.nextDelayMs(11_900)).toBe(0);
  });

  it("keeps a hard wall-clock cap even with repeated activity", () => {
    const lease = createAgentActivityLease({
      timeoutMs: 1_000,
      maxWallClockMs: 2_500,
      nowMs: 10_000,
    });

    lease.touch(10_900);
    lease.touch(11_800);
    lease.touch(12_400);

    expect(lease.nextDelayMs(12_499)).toBe(1);
    expect(lease.nextDelayMs(12_500)).toBe(0);
  });

  it("uses monotonic activity timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const lease = createAgentActivityLease({ timeoutMs: 1_000 });

    lease.touch(10_900);
    lease.touch(10_100);

    expect(lease.nextDelayMs(11_000)).toBe(900);
    vi.useRealTimers();
  });
});
