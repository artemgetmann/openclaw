import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  buildContextPressureNoticeMarker,
  CONTEXT_PRESSURE_NOTICE_TEXT,
  resolveContextPressureNotice,
} from "./context-pressure-notice.js";

describe("context pressure notice", () => {
  it("warns once the session reaches three quarters of the resolved window", () => {
    const entry = {
      totalTokens: 75_000,
      totalTokensFresh: true,
      compactionCount: 2,
    } as SessionEntry;

    expect(
      resolveContextPressureNotice({
        sessionEntry: entry,
        totalTokens: 75_000,
        contextTokens: 100_000,
      }),
    ).toBe(CONTEXT_PRESSURE_NOTICE_TEXT);
  });

  it("stays quiet below the threshold and after the notice is marked for the current compaction", () => {
    const entry = {
      totalTokens: 74_999,
      totalTokensFresh: true,
      compactionCount: 2,
    } as SessionEntry;

    expect(
      resolveContextPressureNotice({
        sessionEntry: entry,
        totalTokens: 74_999,
        contextTokens: 100_000,
      }),
    ).toBeUndefined();

    const markedEntry = {
      ...entry,
      ...buildContextPressureNoticeMarker({
        sessionEntry: entry,
        now: 123,
      }),
    } as SessionEntry;

    expect(
      resolveContextPressureNotice({
        sessionEntry: markedEntry,
        totalTokens: 75_000,
        contextTokens: 100_000,
      }),
    ).toBeUndefined();
  });
});
