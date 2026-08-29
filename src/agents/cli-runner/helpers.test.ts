import { describe, expect, it, vi } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import { createCliJsonlStreamingParser } from "./helpers.js";

const claudeStreamJsonBackend = {
  output: "jsonl",
  jsonlDialect: "claude-stream-json",
} as CliBackendConfig & { jsonlDialect: "claude-stream-json" };

function claudeStreamEvent(event: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "stream_event", event })}\n`;
}

function claudeAssistantMessageStart(): string {
  return claudeStreamEvent({ type: "message_start", message: { role: "assistant" } });
}

function claudeTextDelta(text: string): string {
  return claudeStreamEvent({
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  });
}

describe("createCliJsonlStreamingParser", () => {
  it("separates distinct Claude assistant progress messages in cumulative previews", () => {
    const onAssistantDelta = vi.fn();
    const parser = createCliJsonlStreamingParser({
      backend: claudeStreamJsonBackend,
      providerId: "claude-cli",
      onAssistantDelta,
    });

    parser.push(claudeAssistantMessageStart());
    parser.push(claudeTextDelta("Let me check both."));
    parser.push(claudeAssistantMessageStart());
    parser.push(claudeTextDelta("No memory files exist yet..."));
    parser.push(claudeAssistantMessageStart());
    parser.push(claudeTextDelta("Let me check what skills actually exist..."));

    expect(onAssistantDelta).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "Let me check both." }),
    );
    expect(onAssistantDelta).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "Let me check both.\n\nNo memory files exist yet..." }),
    );
    expect(onAssistantDelta).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        text: [
          "Let me check both.",
          "",
          "No memory files exist yet...",
          "",
          "Let me check what skills actually exist...",
        ].join("\n"),
      }),
    );
  });

  it("does not add an extra separator when Claude already starts the next chunk on a new line", () => {
    const onAssistantDelta = vi.fn();
    const parser = createCliJsonlStreamingParser({
      backend: claudeStreamJsonBackend,
      providerId: "claude-cli",
      onAssistantDelta,
    });

    parser.push(claudeAssistantMessageStart());
    parser.push(claudeTextDelta("Progress one.\n"));
    parser.push(claudeAssistantMessageStart());
    parser.push(claudeTextDelta("\nProgress two."));

    expect(onAssistantDelta).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Progress one.\n\nProgress two." }),
    );
  });
});
