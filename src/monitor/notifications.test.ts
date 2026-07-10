import { describe, expect, it } from "vitest";
import { applyMonitorNotificationEvent } from "./notifications.js";
import type { MonitorNotificationState } from "./types.js";

describe("monitor notification quiet ticks", () => {
  it("suppresses unchanged checks 1-2, notifies on 3, then throttles for 12 hours", () => {
    let state: MonitorNotificationState | undefined;
    const decisions = [1, 2, 3, 4].map((hour) => {
      const decision = applyMonitorNotificationEvent({
        state,
        event: "unchanged",
        nowMs: hour * 60 * 60 * 1000,
      });
      state = decision.state;
      return decision;
    });

    expect(decisions.map((entry) => entry.shouldNotify)).toEqual([false, false, true, false]);
    const reminder = applyMonitorNotificationEvent({
      state,
      event: "unchanged",
      nowMs: 15 * 60 * 60 * 1000,
    });
    expect(reminder.shouldNotify).toBe(true);
    expect(reminder.state.consecutiveUnchangedChecks).toBe(4);

    const bounded = applyMonitorNotificationEvent({
      state: { ...reminder.state, consecutiveUnchangedChecks: Number.MAX_SAFE_INTEGER },
      event: "unchanged",
      nowMs: 28 * 60 * 60 * 1000,
    });
    expect(bounded.state.consecutiveUnchangedChecks).toBe(4);
  });

  it("notifies immediately and resets unchanged state on material change", () => {
    const decision = applyMonitorNotificationEvent({
      state: { consecutiveUnchangedChecks: 8, lastNotificationAtMs: 100 },
      event: "material_change",
      nowMs: 200,
    });

    expect(decision).toMatchObject({
      shouldNotify: true,
      reason: "immediate_event",
      state: {
        consecutiveUnchangedChecks: 0,
        lastEvent: "material_change",
        lastMaterialChangeAtMs: 200,
        lastNotificationAtMs: 200,
      },
    });
  });

  it.each(["completion", "user_input", "approval_required", "degraded"] as const)(
    "notifies immediately for %s",
    (event) => {
      expect(
        applyMonitorNotificationEvent({
          state: { consecutiveUnchangedChecks: 1 },
          event,
          nowMs: 200,
        }).shouldNotify,
      ).toBe(true);
    },
  );

  it("turns a passed deadline into a typed autonomy-aware escalation decision", () => {
    expect(
      applyMonitorNotificationEvent({
        state: { consecutiveUnchangedChecks: 2 },
        event: "deadline_passed",
        actionCapability: "act_within_scope",
        nowMs: 200,
      }),
    ).toMatchObject({
      shouldNotify: true,
      reason: "deadline_escalation",
      nextAction: "escalate_within_scope",
      state: { consecutiveUnchangedChecks: 2, lastEvent: "deadline_passed" },
    });
    expect(
      applyMonitorNotificationEvent({
        event: "deadline_passed",
        actionCapability: "observe_only",
        nowMs: 200,
      }).nextAction,
    ).toBe("request_approval");
  });
});
