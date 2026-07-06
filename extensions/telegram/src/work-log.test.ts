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
