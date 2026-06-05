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
      sessionId: "context-pressure-1",
      updatedAt: Date.now(),
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
      sessionId: "context-pressure-2",
      updatedAt: Date.now(),
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

  it("stays quiet when system prompt overhead dominates a fresh session", () => {
    const entry = {
      sessionId: "context-pressure-3",
      updatedAt: Date.now(),
      totalTokens: 150_000,
      totalTokensFresh: true,
      compactionCount: 0,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 520_000,
          projectContextChars: 400_000,
          nonProjectContextChars: 120_000,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 0,
          entries: [],
        },
        tools: {
          listChars: 0,
          schemaChars: 40_000,
          entries: [],
        },
      },
    } as SessionEntry;

    expect(
      resolveContextPressureNotice({
        sessionEntry: entry,
        totalTokens: 150_000,
        contextTokens: 200_000,
      }),
    ).toBeUndefined();
  });

  it("still warns after compaction even if current system prompt overhead is large", () => {
    const entry = {
      sessionId: "context-pressure-4",
      updatedAt: Date.now(),
      totalTokens: 150_000,
      totalTokensFresh: true,
      compactionCount: 1,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 520_000,
          projectContextChars: 400_000,
          nonProjectContextChars: 120_000,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 0,
          entries: [],
        },
        tools: {
          listChars: 0,
          schemaChars: 40_000,
          entries: [],
        },
      },
    } as SessionEntry;

    expect(
      resolveContextPressureNotice({
        sessionEntry: entry,
        totalTokens: 150_000,
        contextTokens: 200_000,
      }),
    ).toBe(CONTEXT_PRESSURE_NOTICE_TEXT);
  });
});
