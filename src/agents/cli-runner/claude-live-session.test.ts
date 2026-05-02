import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import { buildClaudeLiveArgs, shouldUseClaudeLiveSession } from "./claude-live-session.js";

const backend = {
  command: "claude",
  args: [],
  output: "jsonl",
  input: "stdin",
  sessionArg: "--session-id",
  systemPromptArg: "--append-system-prompt",
  systemPromptFileArg: "--append-system-prompt-file",
  liveSession: "claude-stdio",
} satisfies CliBackendConfig;

describe("Claude CLI live session helpers", () => {
  it("adds stdio live-process flags without removing first-turn prompt args", () => {
    const args = buildClaudeLiveArgs({
      backend,
      useResume: false,
      args: [
        "-p",
        "--append-system-prompt",
        "safe prompt",
        "--session-id",
        "new-session",
        "--input-format",
        "text",
      ],
    });

    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("safe prompt");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("new-session");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
    expect(args).toContain("--replay-user-messages");
  });

  it("strips system prompt args on resumed live-process starts", () => {
    const args = buildClaudeLiveArgs({
      backend,
      useResume: true,
      args: [
        "-p",
        "--append-system-prompt",
        "safe prompt",
        "--append-system-prompt-file",
        "/tmp/prompt.txt",
        "--resume",
        "old-session",
      ],
    });

    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("safe prompt");
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain("/tmp/prompt.txt");
    expect(args).toContain("--resume");
    expect(args).toContain("old-session");
  });

  it("selects live sessions only for claude-cli stdin jsonl backends", () => {
    expect(
      shouldUseClaudeLiveSession({
        backendId: "claude-cli",
        backend,
        sessionId: "s1",
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "opus",
        normalizedModel: "opus",
        timeoutMs: 1_000,
        systemPrompt: "safe prompt",
      }),
    ).toBe(true);
    expect(
      shouldUseClaudeLiveSession({
        backendId: "claude-cli",
        backend: { ...backend, liveSession: undefined },
        sessionId: "s1",
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "opus",
        normalizedModel: "opus",
        timeoutMs: 1_000,
        systemPrompt: "safe prompt",
      }),
    ).toBe(false);
  });
});
