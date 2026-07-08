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

  it("keeps normal long plan snapshots readable in expanded progress entries", () => {
    const planSnapshot = [
      "Plan updated",
      "I'm tracing the Telegram work-log and progress-streaming path first, then I'll write a temporary analysis file, delete it, and finish with a short memory recap.",
      "- [x] Inspect how Telegram progress messages become a retained work log",
      "- [x] Verify the final answer is sent durably instead of disappearing with progress",
      "- [~] Confirm the retained work log keeps enough detail for the user to understand what happened",
      "- [ ] Summarize the memory documents briefly after the local file cleanup",
    ].join("\n");

    const entry = registerTelegramWorkLog({
      progressEntries: [planSnapshot],
      now: 1000,
    });

    const expanded = renderTelegramWorkLog(entry!, true).text;

    expect(expanded).toContain("Summarize the memory documents briefly");
    expect(expanded).not.toContain("...");
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
