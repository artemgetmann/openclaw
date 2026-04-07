import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildTelegramSmokeArtifactPath,
  parseTelegramScriptOutput,
  telegramCommandDeps,
  telegramDoctorCommand,
  telegramSmokeDmReplyCommand,
} from "./telegram.js";

const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

const originalDeps = { ...telegramCommandDeps };

function resetDeps() {
  Object.assign(telegramCommandDeps, originalDeps);
}

describe("telegram commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDeps();
  });

  afterEach(() => {
    resetDeps();
  });

  it("parses repeated proof keys and error lines", () => {
    const parsed = parseTelegramScriptOutput(
      [
        "branch=feature/test",
        "token_claim_path=/tmp/one",
        "token_claim_path=/tmp/two",
        "error=runtime_health_check_failed",
        "error=token_claim_conflict",
      ].join("\n"),
    );

    expect(parsed.fields.branch).toBe("feature/test");
    expect(parsed.fields.token_claim_path).toEqual(["/tmp/one", "/tmp/two"]);
    expect(parsed.errors).toEqual(["runtime_health_check_failed", "token_claim_conflict"]);
  });

  it("builds the smoke artifact path under .artifacts/telegram-smoke", () => {
    const artifactPath = buildTelegramSmokeArtifactPath(
      "/tmp/openclaw",
      "dm-reply",
      "run1234",
      new Date("2026-04-06T10:11:12.999Z"),
    );

    expect(artifactPath).toBe(
      "/tmp/openclaw/.artifacts/telegram-smoke/20260406T101112Z-dm-reply-run1234.json",
    );
  });

  it("fails doctor with exact reasons and passes env/session overrides to precheck", async () => {
    const runTelegramUserPrecheck = vi
      .fn()
      .mockRejectedValueOnce(new Error("E_MISSING_CREDS: user session missing"))
      .mockRejectedValueOnce(new Error("chat_not_found"));

    Object.assign(telegramCommandDeps, {
      now: () => 100,
      probeGateway: vi.fn(async () => ({ ok: false, failureReason: "gateway_unreachable" })),
      readTelegramBotToken: vi.fn(async () => null),
      resolveBotIdentity: vi.fn(async () => null),
      resolveHelperProfile: vi.fn(async () => ({
        profileId: "tg-live-test",
        runtimePort: 24567,
        runtimeStateDir: "/tmp/state",
        worktreePath: "/tmp/repo",
      })),
      resolveRepoContext: vi.fn(async () => ({
        branch: "HEAD",
        commit: "abc123",
        repoRoot: "/tmp/repo",
        worktree: "/tmp/repo",
      })),
      resolveRuntimeCommit: vi.fn(async () => "abc123"),
      resolveRuntimeOwnership: vi.fn(async () => ({
        pid: null,
        worktree: null,
        command: null,
        ownershipOk: false,
        failureReason: "runtime_not_running",
      })),
      resolveTokenClaimPaths: vi.fn(async () => []),
      runTelegramUserPrecheck,
    });

    await expect(
      telegramDoctorCommand(
        {
          chat: "@jarvis_tester_1_bot",
          envFile: "/tmp/tg.env",
          json: true,
          session: "/tmp/userbot.session",
          topicId: "9",
        },
        runtime,
      ),
    ).rejects.toThrow("branch_detached_head");

    expect(runTelegramUserPrecheck).toHaveBeenNthCalledWith(1, {
      envFile: "/tmp/tg.env",
      session: "/tmp/userbot.session",
    });
    expect(runTelegramUserPrecheck).toHaveBeenNthCalledWith(2, {
      chat: "@jarvis_tester_1_bot",
      envFile: "/tmp/tg.env",
      session: "/tmp/userbot.session",
    });

    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.ok).toBe(false);
    expect(payload.failure_reason).toBe("branch_detached_head");
    expect(payload.failure_reasons).toEqual(
      expect.arrayContaining([
        "branch_detached_head",
        "tester_bot_token_missing",
        "runtime_not_running",
        "gateway_unreachable",
        "E_MISSING_CREDS: user session missing",
        "chat_not_found",
      ]),
    );
  });

  it("writes a smoke artifact and reuses env/session overrides end-to-end", async () => {
    const writeFile = vi.fn(async () => undefined);
    const runTelegramUserPrecheck = vi
      .fn()
      .mockResolvedValueOnce({
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      })
      .mockResolvedValueOnce({
        backend_meta: {},
        chat: { chat_id: 777, peer_type: "User", username: "jarvis_tester_1_bot" },
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      });
    const runTelegramUserSend = vi.fn(async () => ({
      message: {
        message_id: 101,
      },
    }));
    const runTelegramUserWait = vi.fn(async () => ({
      matched: {
        direct_messages_topic: null,
        direct_messages_topic_id: null,
        message_id: 202,
        reply_to_msg_id: 101,
        reply_to_top_id: 101,
        sender_id: 777,
        text: "hello from bot",
      },
      matched_by: "reply_to_msg_id",
    }));

    Object.assign(telegramCommandDeps, {
      newRunId: () => "run12345",
      now: () => 1_000,
      probeGateway: vi.fn(async () => ({ ok: true, failureReason: null })),
      readTelegramBotToken: vi.fn(async () => "123456:token"),
      resolveBotIdentity: vi.fn(async () => ({
        id: 123456,
        username: "jarvis_tester_1_bot",
        name: "Jarvis",
      })),
      resolveHelperProfile: vi.fn(async () => ({
        profileId: "tg-live-test",
        runtimePort: 24567,
        runtimeStateDir: "/tmp/state",
        worktreePath: "/tmp/repo",
      })),
      resolveRepoContext: vi.fn(async () => ({
        branch: "feature/test",
        commit: "abc123",
        repoRoot: "/tmp/repo",
        worktree: "/tmp/repo",
      })),
      resolveRuntimeCommit: vi.fn(async () => "abc123"),
      resolveRuntimeOwnership: vi.fn(async () => ({
        pid: 31337,
        worktree: "/tmp/repo",
        command: "openclaw gateway run",
        ownershipOk: true,
        failureReason: null,
      })),
      resolveTokenClaimPaths: vi.fn(async () => ["/tmp/repo"]),
      runTelegramUserPrecheck,
      runTelegramUserSend,
      runTelegramUserWait,
      writeFile,
    });

    await telegramSmokeDmReplyCommand(
      {
        chat: "@jarvis_tester_1_bot",
        envFile: "/tmp/tg.env",
        json: true,
        message: "ping",
        session: "/tmp/userbot.session",
        timeout: "45",
      },
      runtime,
    );

    expect(runTelegramUserSend).toHaveBeenCalledWith({
      chat: "@jarvis_tester_1_bot",
      envFile: "/tmp/tg.env",
      message: "ping",
      session: "/tmp/userbot.session",
    });
    expect(runTelegramUserWait).toHaveBeenCalledWith({
      afterId: 101,
      chat: "@jarvis_tester_1_bot",
      contains: "",
      envFile: "/tmp/tg.env",
      senderId: 777,
      session: "/tmp/userbot.session",
      threadAnchor: undefined,
      timeoutMs: 45_000,
    });
    expect(writeFile).toHaveBeenCalledOnce();

    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.ok).toBe(true);
    expect(payload.sent_message_id).toBe(101);
    expect(payload.reply_message_id).toBe(202);
    expect(payload.matched_by).toBe("reply_to_msg_id");
    expect(payload.current_lane_bot).toBe("@jarvis_tester_1_bot");
    expect(payload.artifact_path).toContain("/tmp/repo/.artifacts/telegram-smoke/");
  });

  it("accepts the active home-clone runtime from launchd without a worktree token claim file", async () => {
    const previousEnv = {
      OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
      OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    };
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.TELEGRAM_BOT_TOKEN;

    const runTelegramUserPrecheck = vi
      .fn()
      .mockResolvedValueOnce({
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      })
      .mockResolvedValueOnce({
        backend_meta: {},
        chat: { chat_id: 777, peer_type: "User", username: "jarvis_tester_1_bot" },
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      });

    const runtimeConfigPath =
      "/Users/user/Library/Application Support/OpenClaw Consumer/.openclaw/openclaw.json";
    const launchdOutput = [
      "gui/501/ai.openclaw.consumer.gateway = {",
      "  arguments = {",
      "    /opt/homebrew/opt/node@22/bin/node",
      "    /Users/user/Programming_Projects/openclaw-consumer/dist/index.js",
      "    gateway",
      "    --port",
      "    19001",
      "  }",
      "  environment = {",
      "    OPENCLAW_PROFILE => consumer",
      "    OPENCLAW_GATEWAY_PORT => 19001",
      "    OPENCLAW_STATE_DIR => /Users/user/Library/Application Support/OpenClaw Consumer/.openclaw",
      `    OPENCLAW_CONFIG_PATH => ${runtimeConfigPath}`,
      "  }",
      "}",
    ].join("\n");

    Object.assign(telegramCommandDeps, {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === "launchctl" && args[1] === "print") {
          return { stdout: launchdOutput, stderr: "" };
        }
        if (args[0] === "lsof" && args.includes("-tiTCP:19001")) {
          return { stdout: "65735\n", stderr: "" };
        }
        if (args[0] === "lsof" && args.includes("-Fn")) {
          return { stdout: "p65735\nn/\n", stderr: "" };
        }
        if (args[0] === "ps" && args[1] === "-o" && args[2] === "command=") {
          return {
            stdout:
              "node /Users/user/Programming_Projects/openclaw-consumer/dist/index.js gateway --port 19001\n",
            stderr: "",
          };
        }
        if (args[0] === "git" && args[1] === "worktree" && args[2] === "list") {
          return {
            stdout: "worktree /Users/user/Programming_Projects/openclaw-consumer\n",
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      }),
      now: () => 1_000,
      probeGateway: vi.fn(async () => ({ ok: true, failureReason: null })),
      resolveBotIdentity: vi.fn(async () => ({
        id: 123456,
        username: "jarvis_tester_1_bot",
        name: "Jarvis",
      })),
      resolveRepoContext: vi.fn(async () => ({
        branch: "codex/consumer-openclaw-project",
        commit: "abc123",
        repoRoot: "/Users/user/Programming_Projects/openclaw-consumer",
        worktree: "/Users/user/Programming_Projects/openclaw-consumer",
      })),
      resolveRuntimeCommit: vi.fn(async () => "abc123"),
      fileExists: vi.fn((filePath: string) => filePath === runtimeConfigPath),
      readFile: vi.fn(async (filePath: string) => {
        if (filePath === runtimeConfigPath) {
          return JSON.stringify({
            channels: {
              telegram: {
                botToken: "123456:token",
              },
            },
          });
        }
        throw new Error(`unexpected readFile: ${filePath}`);
      }),
      runTelegramUserPrecheck,
    });

    await telegramDoctorCommand(
      {
        chat: "@jarvis_tester_1_bot",
        json: true,
      },
      runtime,
    );

    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.ok).toBe(true);
    expect(payload.runtime_port).toBe(19001);
    expect(payload.runtime_worktree).toBe("/Users/user/Programming_Projects/openclaw-consumer");
    expect(payload.current_lane_bot).toBe("@jarvis_tester_1_bot");

    process.env.OPENCLAW_GATEWAY_PORT = previousEnv.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_STATE_DIR = previousEnv.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_PROFILE = previousEnv.OPENCLAW_PROFILE;
    process.env.OPENCLAW_CONFIG_PATH = previousEnv.OPENCLAW_CONFIG_PATH;
    process.env.TELEGRAM_BOT_TOKEN = previousEnv.TELEGRAM_BOT_TOKEN;
  });

  it("marks pairing-gated replies as failed smoke output", async () => {
    const writeFile = vi.fn(async () => undefined);
    const runTelegramUserPrecheck = vi
      .fn()
      .mockResolvedValueOnce({
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      })
      .mockResolvedValueOnce({
        backend_meta: {},
        chat: { chat_id: 777, peer_type: "User", username: "jarvis_tester_1_bot" },
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      });

    Object.assign(telegramCommandDeps, {
      newRunId: () => "runpair01",
      now: vi.fn(() => 1_500),
      probeGateway: vi.fn(async () => ({ ok: true, failureReason: null })),
      readTelegramBotToken: vi.fn(async () => "123456:token"),
      resolveBotIdentity: vi.fn(async () => ({
        id: 123456,
        username: "jarvis_tester_1_bot",
        name: "Jarvis",
      })),
      resolveHelperProfile: vi.fn(async () => ({
        profileId: "tg-live-test",
        runtimePort: 24567,
        runtimeStateDir: "/tmp/state",
        worktreePath: "/tmp/repo",
      })),
      resolveRepoContext: vi.fn(async () => ({
        branch: "feature/test",
        commit: "abc123",
        repoRoot: "/tmp/repo",
        worktree: "/tmp/repo",
      })),
      resolveRuntimeCommit: vi.fn(async () => "abc123"),
      resolveRuntimeOwnership: vi.fn(async () => ({
        pid: 31337,
        worktree: "/tmp/repo",
        command: "openclaw gateway run",
        ownershipOk: true,
        failureReason: null,
      })),
      resolveTokenClaimPaths: vi.fn(async () => ["/tmp/repo"]),
      runTelegramUserPrecheck,
      runTelegramUserSend: vi.fn(async () => ({
        message: {
          message_id: 101,
        },
      })),
      runTelegramUserWait: vi.fn(async () => ({
        matched: {
          direct_messages_topic: null,
          direct_messages_topic_id: null,
          message_id: 202,
          reply_to_msg_id: 101,
          reply_to_top_id: 101,
          sender_id: 777,
          text: "OpenClaw: access not configured.\n\nPairing code:\n\nQZC3VHYA\n\nAsk the bot owner to approve with:\nopenclaw pairing approve telegram QZC3VHYA",
        },
        matched_by: "reply_to_msg_id",
      })),
      writeFile,
    });

    await expect(
      telegramSmokeDmReplyCommand(
        {
          chat: "@jarvis_tester_1_bot",
          json: true,
        },
        runtime,
      ),
    ).rejects.toThrow("pairing_required");

    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.ok).toBe(false);
    expect(payload.failure_reason).toBe("pairing_required");
    expect(payload.reply_text).toContain("Pairing code");
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("marks quota replies as failed smoke output", async () => {
    const writeFile = vi.fn(async () => undefined);
    const runTelegramUserPrecheck = vi
      .fn()
      .mockResolvedValueOnce({
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      })
      .mockResolvedValueOnce({
        backend_meta: {},
        chat: { chat_id: 777, peer_type: "User", username: "jarvis_tester_1_bot" },
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      });

    Object.assign(telegramCommandDeps, {
      newRunId: () => "runquota1",
      now: vi.fn(() => 1_800),
      probeGateway: vi.fn(async () => ({ ok: true, failureReason: null })),
      readTelegramBotToken: vi.fn(async () => "123456:token"),
      resolveBotIdentity: vi.fn(async () => ({
        id: 123456,
        username: "jarvis_tester_1_bot",
        name: "Jarvis",
      })),
      resolveHelperProfile: vi.fn(async () => ({
        profileId: "tg-live-test",
        runtimePort: 24567,
        runtimeStateDir: "/tmp/state",
        worktreePath: "/tmp/repo",
      })),
      resolveRepoContext: vi.fn(async () => ({
        branch: "feature/test",
        commit: "abc123",
        repoRoot: "/tmp/repo",
        worktree: "/tmp/repo",
      })),
      resolveRuntimeCommit: vi.fn(async () => "abc123"),
      resolveRuntimeOwnership: vi.fn(async () => ({
        pid: 31337,
        worktree: "/tmp/repo",
        command: "openclaw gateway run",
        ownershipOk: true,
        failureReason: null,
      })),
      resolveTokenClaimPaths: vi.fn(async () => ["/tmp/repo"]),
      runTelegramUserPrecheck,
      runTelegramUserSend: vi.fn(async () => ({
        message: {
          message_id: 101,
        },
      })),
      runTelegramUserWait: vi.fn(async () => ({
        matched: {
          direct_messages_topic: null,
          direct_messages_topic_id: null,
          message_id: 202,
          reply_to_msg_id: 101,
          reply_to_top_id: 101,
          sender_id: 777,
          text: "⚠️ ChatGPT usage limit reached. Try again in ~137 min.",
        },
        matched_by: "reply_to_msg_id",
      })),
      writeFile,
    });

    await expect(
      telegramSmokeDmReplyCommand(
        {
          chat: "@jarvis_tester_1_bot",
          json: true,
        },
        runtime,
      ),
    ).rejects.toThrow("model_quota_exhausted");

    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.ok).toBe(false);
    expect(payload.failure_reason).toBe("model_quota_exhausted");
    expect(payload.reply_text).toContain("usage limit reached");
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("marks credential-auth replies as failed smoke output", async () => {
    const writeFile = vi.fn(async () => undefined);
    const runTelegramUserPrecheck = vi
      .fn()
      .mockResolvedValueOnce({
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      })
      .mockResolvedValueOnce({
        backend_meta: {},
        chat: { chat_id: 777, peer_type: "User", username: "jarvis_tester_1_bot" },
        session_path: "/tmp/userbot.session",
        user: { user_id: 99, username: "artem" },
      });

    Object.assign(telegramCommandDeps, {
      newRunId: () => "runauth01",
      now: vi.fn(() => 1_600),
      probeGateway: vi.fn(async () => ({ ok: true, failureReason: null })),
      readTelegramBotToken: vi.fn(async () => "123456:token"),
      resolveBotIdentity: vi.fn(async () => ({
        id: 123456,
        username: "jarvis_tester_1_bot",
        name: "Jarvis",
      })),
      resolveHelperProfile: vi.fn(async () => ({
        profileId: "tg-live-test",
        runtimePort: 24567,
        runtimeStateDir: "/tmp/state",
        worktreePath: "/tmp/repo",
      })),
      resolveRepoContext: vi.fn(async () => ({
        branch: "feature/test",
        commit: "abc123",
        repoRoot: "/tmp/repo",
        worktree: "/tmp/repo",
      })),
      resolveRuntimeCommit: vi.fn(async () => "abc123"),
      resolveRuntimeOwnership: vi.fn(async () => ({
        pid: 31337,
        worktree: "/tmp/repo",
        command: "openclaw gateway run",
        ownershipOk: true,
        failureReason: null,
      })),
      resolveTokenClaimPaths: vi.fn(async () => ["/tmp/repo"]),
      runTelegramUserPrecheck,
      runTelegramUserSend: vi.fn(async () => ({
        message: {
          message_id: 101,
        },
      })),
      runTelegramUserWait: vi.fn(async () => ({
        matched: {
          direct_messages_topic: null,
          direct_messages_topic_id: null,
          message_id: 202,
          reply_to_msg_id: 101,
          reply_to_top_id: 101,
          sender_id: 777,
          text: "OpenClaw's AI access is unavailable right now. Reconnect the credential and try again.",
        },
        matched_by: "reply_to_msg_id",
      })),
      writeFile,
    });

    await expect(
      telegramSmokeDmReplyCommand(
        {
          chat: "@jarvis_tester_1_bot",
          json: true,
        },
        runtime,
      ),
    ).rejects.toThrow("ai_access_unavailable");

    const payload = JSON.parse(
      String((runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    );
    expect(payload.ok).toBe(false);
    expect(payload.failure_reason).toBe("ai_access_unavailable");
    expect(payload.reply_text).toContain("Reconnect the credential");
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
