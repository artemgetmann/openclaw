import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readCompletedTelegramSafeReuseFence,
  readTelegramSafeReuseFenceState,
  resolveTelegramSafeReuseFenceRequest,
  writeCompletedTelegramSafeReuseFence,
  writePendingTelegramSafeReuseFence,
  writeReadingTelegramSafeReuseFence,
} from "./safe-reuse-fence-store.js";

describe("Telegram safe-reuse fence receipt", () => {
  it("requires a valid reservation generation when enabled", () => {
    expect(
      resolveTelegramSafeReuseFenceRequest({
        botToken: "12345:first",
        env: {},
      }),
    ).toBeNull();
    expect(() =>
      resolveTelegramSafeReuseFenceRequest({
        botToken: "12345:first",
        env: {
          OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION: "../../bad",
        },
      }),
    ).toThrow(/malformed/);
  });

  it("enables the fence only for its exact reserved bot and account", () => {
    const tokenHash = crypto.createHash("sha256").update("12345:first").digest("hex");
    const env = {
      OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION: "generation-123",
      OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH: tokenHash,
      OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID: "default",
    };

    expect(
      resolveTelegramSafeReuseFenceRequest({
        botToken: "12345:first",
        accountId: "default",
        env,
      }),
    ).toEqual({ generation: "generation-123" });
    expect(
      resolveTelegramSafeReuseFenceRequest({
        botToken: "67890:named",
        accountId: "named",
        env,
      }),
    ).toBeNull();
  });

  it("scopes completion to reservation generation, token hash, and account", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-safe-reuse-receipt-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await writeCompletedTelegramSafeReuseFence({
      accountId: "default",
      botToken: "12345:first",
      generation: "generation-123",
      lastUpdateId: 900,
      env,
    });

    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: 900,
        env,
      }),
    ).resolves.toEqual({ lastUpdateId: 900 });
    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-456",
        persistedLastUpdateId: 900,
        env,
      }),
    ).resolves.toBeNull();
    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "67890:second",
        generation: "generation-123",
        persistedLastUpdateId: 900,
        env,
      }),
    ).resolves.toBeNull();
  });

  it("requires the receipt cutoff to remain active", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-safe-reuse-cutoff-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await writeCompletedTelegramSafeReuseFence({
      accountId: "default",
      botToken: "12345:first",
      generation: "generation-123",
      lastUpdateId: 900,
      env,
    });

    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        env,
      }),
    ).resolves.toBeNull();
    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: 899,
        env,
      }),
    ).resolves.toBeNull();
    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: 901,
        env,
      }),
    ).resolves.toEqual({ lastUpdateId: 900 });
  });

  it("returns a pending tail even when its cutoff was not persisted before the crash", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-safe-reuse-pending-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await writePendingTelegramSafeReuseFence({
      accountId: "default",
      botToken: "12345:first",
      generation: "generation-123",
      lastUpdateId: 900,
      env,
    });

    // Pending is a write-ahead record, not proof that the cutoff is active.
    // Recovery must receive its exact tail and make the cutoff durable before
    // replacing this record with a completion receipt.
    await expect(
      readTelegramSafeReuseFenceState({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        env,
      }),
    ).resolves.toEqual({ phase: "pending", lastUpdateId: 900 });
    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        env,
      }),
    ).resolves.toBeNull();
  });

  it("keeps an ambiguous tail read distinct from recoverable pending state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-safe-reuse-reading-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await writeReadingTelegramSafeReuseFence({
      accountId: "default",
      botToken: "12345:first",
      generation: "generation-123",
      env,
    });

    await expect(
      readTelegramSafeReuseFenceState({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        env,
      }),
    ).resolves.toEqual({ phase: "reading", lastUpdateId: null });
    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        env,
      }),
    ).resolves.toBeNull();
  });

  it("preserves a completed generation when ACP intentionally ignores the cursor", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tg-safe-reuse-acp-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await writeCompletedTelegramSafeReuseFence({
      accountId: "default",
      botToken: "12345:first",
      generation: "generation-123",
      lastUpdateId: 900,
      env,
    });

    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        persistedOffsetIgnored: true,
        env,
      }),
    ).resolves.toEqual({ lastUpdateId: 900 });
  });

  it("keeps default-root tester completion durable when ACP resets runtime state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tg-safe-reuse-durable-"));
    const originalStateDir = path.join(root, "runtime-before-reset");
    const resetStateDir = path.join(root, "runtime-after-reset");
    const baseEnv = {
      HOME: path.join(root, "home"),
      OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: "scenario-default-root",
    };
    await writeCompletedTelegramSafeReuseFence({
      accountId: "default",
      botToken: "12345:first",
      generation: "generation-123",
      lastUpdateId: 900,
      env: {
        ...baseEnv,
        OPENCLAW_STATE_DIR: originalStateDir,
      },
    });

    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        persistedOffsetIgnored: true,
        env: {
          ...baseEnv,
          OPENCLAW_STATE_DIR: resetStateDir,
        },
      }),
    ).resolves.toEqual({ lastUpdateId: 900 });

    // A second tester bot on the same default account gets a distinct receipt
    // instead of clobbering the first bot's restart proof.
    await expect(
      readCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "67890:second",
        generation: "generation-123",
        persistedLastUpdateId: null,
        persistedOffsetIgnored: true,
        env: baseEnv,
      }),
    ).resolves.toBeNull();
  });
});
