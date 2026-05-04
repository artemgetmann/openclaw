import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCliBackendConfig } from "./cli-backends.js";

describe("resolveCliBackendConfig reliability merge", () => {
  it("defaults codex-cli to workspace-write for fresh and resume runs", () => {
    const resolved = resolveCliBackendConfig("codex-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
    ]);
  });

  it("deep-merges reliability watchdog overrides for codex", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": {
              command: "codex",
              reliability: {
                watchdog: {
                  resume: {
                    noOutputTimeoutMs: 42_000,
                  },
                },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("codex-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutMs).toBe(42_000);
    // Ensure defaults are retained when only one field is overridden.
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutRatio).toBe(0.3);
    expect(resolved?.config.reliability?.watchdog?.resume?.minMs).toBe(60_000);
    expect(resolved?.config.reliability?.watchdog?.resume?.maxMs).toBe(180_000);
    expect(resolved?.config.reliability?.watchdog?.fresh?.noOutputTimeoutRatio).toBe(0.8);
  });
});

describe("resolveCliBackendConfig claude-cli defaults", () => {
  it("uses upstream-style stream-json MCP defaults for fresh and resume args", () => {
    const resolved = resolveCliBackendConfig("claude-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.config.output).toBe("jsonl");
    expect(resolved?.config.input).toBe("stdin");
    expect(resolved?.config.liveSession).toBe("claude-stdio");
    expect(resolved?.config.systemPromptFileArg).toBe("--append-system-prompt-file");
    expect(resolved?.config.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      "user",
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "mcp__openclaw__*",
    ]);
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      "user",
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "mcp__openclaw__*",
      "--resume",
      "{sessionId}",
    ]);
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("retains default claude stream and MCP args when only command is overridden", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "/usr/local/bin/claude",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.command).toBe("/usr/local/bin/claude");
    expect(resolved?.config.args).toContain("--include-partial-messages");
    expect(resolved?.config.args).toContain("--allowedTools");
    expect(resolved?.config.args).toContain("mcp__openclaw__*");
    expect(resolved?.config.resumeArgs).toContain("--include-partial-messages");
    expect(resolved?.config.resumeArgs).toContain("--allowedTools");
    expect(resolved?.config.resumeArgs).toContain("mcp__openclaw__*");
  });

  it("normalizes legacy skip-permissions overrides to permission-mode bypassPermissions", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--dangerously-skip-permissions", "--output-format", "json"],
              resumeArgs: [
                "-p",
                "--dangerously-skip-permissions",
                "--output-format",
                "json",
                "--resume",
                "{sessionId}",
              ],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.args).toContain("--permission-mode");
    expect(resolved?.config.args).toContain("bypassPermissions");
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.resumeArgs).toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).toContain("bypassPermissions");
  });

  it("keeps explicit permission-mode overrides while removing legacy skip flag", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--dangerously-skip-permissions", "--permission-mode", "acceptEdits"],
              resumeArgs: [
                "-p",
                "--dangerously-skip-permissions",
                "--permission-mode=acceptEdits",
                "--resume",
                "{sessionId}",
              ],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.args).toEqual(["-p", "--permission-mode", "acceptEdits"]);
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--permission-mode=acceptEdits",
      "--resume",
      "{sessionId}",
    ]);
    expect(resolved?.config.args).not.toContain("bypassPermissions");
    expect(resolved?.config.resumeArgs).not.toContain("bypassPermissions");
  });
});

describe("resolveCliBackendConfig claude-bridge defaults", () => {
  it("uses a minimal isolated bridge command and clears Anthropic API keys", () => {
    const resolved = resolveCliBackendConfig("claude-bridge");

    expect(resolved).not.toBeNull();
    expect(resolved?.config.command).toBe("claude");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_API_KEY");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_API_KEY_OLD");
    expect(resolved?.config.modelAliases?.opus).toBe("opus");
  });
});
