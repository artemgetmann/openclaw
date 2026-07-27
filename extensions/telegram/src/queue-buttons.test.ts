import { describe, expect, it } from "vitest";
import {
  buildTelegramQueuedButtons,
  buildTelegramSteeredButtons,
  parseTelegramQueueCallback,
} from "./queue-buttons.js";

const DURABLE_ID = "12345678-1234-4234-8234-123456789abc";

describe("Telegram queue buttons", () => {
  it("renders Queue as the selected default and exposes explicit Steer", () => {
    expect(buildTelegramQueuedButtons(DURABLE_ID)).toEqual([
      [
        {
          text: "✓ Queue",
          callback_data: `oqk:${DURABLE_ID}`,
          style: "success",
        },
        { text: "Steer", callback_data: `oqs:${DURABLE_ID}` },
      ],
    ]);
  });

  it("renders the irreversible settled steering state honestly", () => {
    expect(buildTelegramSteeredButtons(DURABLE_ID)).toEqual([
      [
        {
          text: "✓ Steer",
          callback_data: `oqd:${DURABLE_ID}`,
          style: "success",
        },
      ],
    ]);
  });

  it("parses only bounded ASCII durable ids", () => {
    expect(parseTelegramQueueCallback(`oqs:${DURABLE_ID}`)).toEqual({
      action: "steer",
      durableId: DURABLE_ID,
    });
    expect(parseTelegramQueueCallback("oqs:short")).toBeUndefined();
    expect(parseTelegramQueueCallback(`oqs:${"é".repeat(20)}`)).toBeUndefined();
    expect(parseTelegramQueueCallback(`oqs:${"a".repeat(49)}`)).toBeUndefined();
  });
});
