import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_DELETE_ENABLE_ENV,
  areTelegramDeletesEnabled,
  buildTelegramDeleteAuditFields,
  guardedTelegramDeleteMessage,
} from "./delete-guard.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("guardedTelegramDeleteMessage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("suppresses operator deletes by default and logs redacted audit metadata", async () => {
    const api = { deleteMessage: vi.fn().mockResolvedValue(true) };
    const logger = createLogger();

    const result = await guardedTelegramDeleteMessage({
      api,
      chatId: "-1001234567890",
      messageId: 42,
      audit: {
        callsite: "test-cleanup",
        reason: "preview_cleanup",
        safetyMode: "operator_opt_in",
        accountId: "personal",
        lane: "answer",
        classification: "preview",
        sessionId: "agent:main:telegram:group:-1001234567890:topic:99",
        topicId: 99,
      },
      logger,
    });

    expect(result).toEqual({ ok: true, deleted: false, suppressed: true });
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "telegram delete audit: delete_suppressed",
      expect.objectContaining({
        event: "delete_suppressed",
        callsite: "test-cleanup",
        reason: "preview_cleanup",
        safetyMode: "operator_opt_in",
        chatIdHash: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        accountIdHash: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        messageId: 42,
        lane: "answer",
        classification: "preview",
        sessionIdHash: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
        threadId: "99",
      }),
    );
    const meta = logger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(meta)).not.toContain("-1001234567890");
    expect(JSON.stringify(meta)).not.toContain("personal");
    expect(JSON.stringify(meta)).not.toContain("agent:main:telegram");
  });

  it("allows deterministic cleanup deletes by default and logs attempt/success", async () => {
    const api = { deleteMessage: vi.fn().mockResolvedValue(true) };
    const logger = createLogger();

    const result = await guardedTelegramDeleteMessage({
      api,
      chatId: 123,
      messageId: 456,
      audit: {
        callsite: "progress-clear",
        reason: "progress_cleanup",
        safetyMode: "deterministic_cleanup",
        lane: "answer",
        classification: "progress",
      },
      logger,
    });

    expect(result).toEqual({ ok: true, deleted: true });
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 456);
    expect(logger.info).toHaveBeenCalledWith(
      "telegram delete audit: delete_attempt",
      expect.objectContaining({
        event: "delete_attempt",
        callsite: "progress-clear",
        safetyMode: "deterministic_cleanup",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "telegram delete audit: delete_success",
      expect.objectContaining({
        event: "delete_success",
        callsite: "progress-clear",
        safetyMode: "deterministic_cleanup",
      }),
    );
  });

  it("allows deletes only after explicit env opt-in and logs attempt/success", async () => {
    vi.stubEnv(TELEGRAM_DELETE_ENABLE_ENV, "1");
    const api = { deleteMessage: vi.fn().mockResolvedValue(true) };
    const logger = createLogger();

    const result = await guardedTelegramDeleteMessage({
      api,
      chatId: 123,
      messageId: 456,
      audit: {
        callsite: "admin-tool",
        reason: "action_delete_message",
      },
      logger,
    });

    expect(result).toEqual({ ok: true, deleted: true });
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 456);
    expect(logger.info).toHaveBeenCalledWith(
      "telegram delete audit: delete_attempt",
      expect.objectContaining({ event: "delete_attempt", callsite: "admin-tool" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "telegram delete audit: delete_success",
      expect.objectContaining({ event: "delete_success", callsite: "admin-tool" }),
    );
  });

  it("logs and rethrows delete failures when explicitly enabled", async () => {
    vi.stubEnv(TELEGRAM_DELETE_ENABLE_ENV, "true");
    const api = { deleteMessage: vi.fn().mockRejectedValue(new Error("telegram rejected delete")) };
    const logger = createLogger();

    await expect(
      guardedTelegramDeleteMessage({
        api,
        chatId: 123,
        messageId: 456,
        audit: {
          callsite: "admin-tool",
          reason: "action_delete_message",
        },
        logger,
      }),
    ).rejects.toThrow("telegram rejected delete");

    expect(logger.warn).toHaveBeenCalledWith(
      "telegram delete audit: delete_failure",
      expect.objectContaining({
        event: "delete_failure",
        callsite: "admin-tool",
        error: "telegram rejected delete",
      }),
    );
  });

  it("treats unset or non-opt-in env values as disabled", () => {
    expect(areTelegramDeletesEnabled({})).toBe(false);
    expect(areTelegramDeletesEnabled({ [TELEGRAM_DELETE_ENABLE_ENV]: "0" })).toBe(false);
    expect(areTelegramDeletesEnabled({ [TELEGRAM_DELETE_ENABLE_ENV]: "1" })).toBe(true);
  });

  it("builds audit fields without raw chat or account ids", () => {
    const fields = buildTelegramDeleteAuditFields("delete_attempt", {
      callsite: "test",
      reason: "cleanup",
      chatId: "-100123",
      messageId: 7,
      accountId: "owner",
    });

    expect(fields.chatIdHash).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(fields.accountIdHash).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(Object.values(fields)).not.toContain("-100123");
    expect(Object.values(fields)).not.toContain("owner");
  });
});
