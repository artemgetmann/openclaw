import { describe, expect, it } from "vitest";
import { buildReminderCronJob, extractReminderIntent } from "./reminder-intent.js";

describe("extractReminderIntent", () => {
  it("parses explicit remind-me phrasing", () => {
    expect(extractReminderIntent("remind me in 1 min to check the deploy")).toEqual({
      delayMs: 60_000,
      task: "check the deploy",
    });
  });

  it("parses free-form leading-duration agentTurn reminders", () => {
    expect(extractReminderIntent("in 1 min check Telegram and report back")).toEqual({
      delayMs: 60_000,
      task: "check Telegram and report back",
    });
  });

  it("parses one-minute natural wording for complex agent-turn reminders", () => {
    expect(
      extractReminderIntent(
        "in one minute go to my Twitter profile, click on the first post, and check the first comment",
      ),
    ).toEqual({
      delayMs: 60_000,
      task: "go to my Twitter profile, click on the first post, and check the first comment",
    });
  });

  it("parses product timestamp-prefixed complex reminders", () => {
    expect(
      extractReminderIntent(
        "[Sat 2026-05-16 13:17 GMT+8] in one minute go to my Twitter profile, click on the first post, and check the first comment",
      ),
    ).toEqual({
      delayMs: 60_000,
      task: "go to my Twitter profile, click on the first post, and check the first comment",
    });
  });

  it("does not treat duration-free text as a reminder", () => {
    expect(extractReminderIntent("in summary check Telegram and report back")).toBeNull();
  });
});

describe("buildReminderCronJob", () => {
  it("creates an explicit isolated agentTurn with announce delivery", () => {
    const job = buildReminderCronJob(
      {
        delayMs: 60_000,
        task: "check Telegram and report back",
      },
      Date.parse("2026-05-14T10:00:00Z"),
    );

    expect(job).toMatchObject({
      name: "Reminder: check Telegram and report back",
      schedule: {
        kind: "at",
        at: "2026-05-14T10:01:00.000Z",
      },
      sessionTarget: "isolated",
      delivery: {
        mode: "announce",
      },
      payload: {
        kind: "agentTurn",
        message:
          "Scheduled task due now. Perform this task and report the result: check Telegram and report back",
      },
    });
  });
});
