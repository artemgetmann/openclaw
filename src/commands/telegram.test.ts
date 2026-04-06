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
});
