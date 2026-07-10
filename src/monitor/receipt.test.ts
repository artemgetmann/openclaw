import { describe, expect, it } from "vitest";
import { formatMonitorReceipt } from "./receipt.js";
import type { MonitorDisclosure } from "./types.js";

function disclosure(overrides: Partial<MonitorDisclosure> = {}): MonitorDisclosure {
  return {
    purpose: "Watch support replies for a resolution.",
    source: { type: "gmail", target: { threadId: "thread-1" } },
    checkCadence: { kind: "every", everyMs: 5 * 60_000 },
    noChangeCadence: { noticeAfterChecks: 3, reminderIntervalMs: 43_200_000 },
    expiryAt: "2026-07-11T00:00:00.000Z",
    stopCondition: "support confirms resolution",
    autonomy: { level: "observe_only" },
    actionPolicy: "notify_draft",
    ...overrides,
  };
}

describe("monitor receipts", () => {
  it("formats a compact receipt from the normalized disclosure", () => {
    expect(formatMonitorReceipt(disclosure())).toBe(
      "Monitoring support replies for a resolution\n" +
        "Every 5 minutes · until Jul 11, 2026, 12:00 AM UTC; stop when support confirms resolution\n" +
        "I'll message when something changes. If not, after 3 checks, then every 12 hours.",
    );
  });

  it("uses complete consumer cadence phrases and never exposes cron job wording", () => {
    const receipt = formatMonitorReceipt(
      disclosure({
        purpose: "Watch the cron job status",
        checkCadence: { kind: "cron", expr: "*/15 * * * *", tz: "UTC" },
        expiryAt: null,
        stopCondition: null,
      }),
    );

    expect(receipt).toContain("Monitoring the scheduled task status");
    expect(receipt).toContain("Every 15 minutes (UTC) · until you stop it");
    expect(receipt.toLowerCase()).not.toContain("cron job");
  });

  it.each(["monitor the inbox", "check support replies", "track new messages"])(
    "removes the leading imperative from %s",
    (purpose) => {
      expect(formatMonitorReceipt(disclosure({ purpose }))).toContain(
        `Monitoring ${purpose.replace(/^(?:monitor|check|track)\s+/i, "")}`,
      );
    },
  );

  it.each([
    [{ kind: "every", everyMs: 30_000 }, "Every 30 seconds"],
    [{ kind: "every", everyMs: 5 * 60_000 }, "Every 5 minutes"],
    [{ kind: "at", at: "2026-07-11T00:00:00.000Z" }, "Once at Jul 11, 2026, 12:00 AM UTC"],
    [{ kind: "cron", expr: "0 9 * * *", tz: "UTC" }, "Daily at 9:00 AM (UTC)"],
    [{ kind: "cron", expr: "0 9 1 * 1", tz: "UTC" }, "On its configured schedule (UTC)"],
  ] as const)("formats cadence %j as %s", (cadence, expected) => {
    expect(formatMonitorReceipt(disclosure({ checkCadence: cadence }))).toContain(expected);
  });

  it.each([
    ["*/30 * * * * *", "Every 30 seconds"],
    ["*/60 * * * * *", "Every 60 seconds"],
  ])("keeps six-field second cadence accurate for %s", (expr, expected) => {
    expect(
      formatMonitorReceipt(disclosure({ checkCadence: { kind: "cron", expr, tz: "UTC" } })),
    ).toContain(`${expected} (UTC)`);
  });

  it("preserves the exact minute and second for daily schedules", () => {
    expect(
      formatMonitorReceipt(
        disclosure({ checkCadence: { kind: "cron", expr: "30 9 * * *", tz: "UTC" } }),
      ),
    ).toContain("Daily at 9:30 AM (UTC)");
    expect(
      formatMonitorReceipt(
        disclosure({ checkCadence: { kind: "cron", expr: "15 30 9 * * *", tz: "UTC" } }),
      ),
    ).toContain("Daily at 9:30:15 AM (UTC)");
  });

  it.each([
    ["Monitoring support replies", "Monitoring support replies"],
    ["Look for a support reply", "Monitoring a support reply"],
  ])("normalizes purpose %s", (purpose, expected) => {
    expect(formatMonitorReceipt(disclosure({ purpose }))).toContain(expected);
  });
});
