import { beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  buildTelegramWorkLogReplyMarkup,
  getTelegramWorkLog,
  parseTelegramWorkLogCallbackData,
  registerTelegramWorkLog,
  renderTelegramWorkLog,
} from "./work-log.js";

describe("telegram work log", () => {
  beforeEach(() => {
    __testing.resetTelegramWorkLogsForTests();
  });

  it("renders collapsed and expanded progress without internal counts or tool labels", () => {
    const entry = registerTelegramWorkLog({
      progressEntries: ["Opening browser", "Reading docs"],
      toolNames: ["browser.open", "exec"],
      now: 1000,
    });

    expect(entry?.id).toBe("1");
    expect(renderTelegramWorkLog(entry!, false)).toEqual({
      text: "Work log",
      buttons: [[{ text: "Show", callback_data: "wl:1:show" }]],
    });
    expect(renderTelegramWorkLog(entry!, true)).toEqual({
      text: "Work log\n\nOpening browser\n\nReading docs",
      buttons: [[{ text: "Hide", callback_data: "wl:1:hide" }]],
    });
  });

  it("preserves meaningful internal newlines in expanded progress entries", () => {
    const entry = registerTelegramWorkLog({
      progressEntries: [
        ["Plan updated", "- [x] Inspect files", "- [~] Render checklist", "- [ ] Run tests"].join(
          "\n",
        ),
      ],
      now: 1000,
    });

    expect(renderTelegramWorkLog(entry!, true)).toEqual({
      text: [
        "Work log",
        "",
        "Plan updated",
        "- [x] Inspect files",
        "- [~] Render checklist",
        "- [ ] Run tests",
      ].join("\n"),
      buttons: [[{ text: "Hide", callback_data: "wl:1:hide" }]],
    });
  });

  it("pins acknowledgment and plan when long histories trim middle progress", () => {
    const acknowledgment = "I’ll inspect the package first, then run the checks.";
    const plan = "Plan updated\n- [~] Inspect package\n- [ ] Run checks";
    const updates = Array.from({ length: 14 }, (_, index) => `Progress ${index + 1}`);
    const entry = registerTelegramWorkLog({
      progressEntries: [acknowledgment, plan, ...updates],
      now: 1000,
    });

    expect(entry?.progressEntries).toHaveLength(12);
    expect(entry?.progressEntries.slice(0, 2)).toEqual([acknowledgment, plan]);
    expect(entry?.progressEntries.at(-1)).toBe("Progress 14");
    expect(entry?.progressEntries).not.toContain("Progress 1");
  });

  it("expires old entries and builds mutable Telegram reply markup", () => {
    const entry = registerTelegramWorkLog({
      progressEntries: ["Checking state"],
      now: 1000,
    });
    const collapsed = renderTelegramWorkLog(entry!, false);

    expect(parseTelegramWorkLogCallbackData("wl:1:show")).toEqual({ id: "1", action: "show" });
    expect(buildTelegramWorkLogReplyMarkup(collapsed)).toEqual({
      inline_keyboard: [[{ text: "Show", callback_data: "wl:1:show" }]],
    });
    expect(getTelegramWorkLog("1", 1000 + 24 * 60 * 60 * 1000 + 1)).toBeUndefined();
  });
});
