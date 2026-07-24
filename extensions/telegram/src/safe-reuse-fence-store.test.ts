import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasCompletedTelegramSafeReuseFence,
  resolveTelegramSafeReuseFenceRequest,
  writeCompletedTelegramSafeReuseFence,
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
      hasCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: 900,
        env,
      }),
    ).resolves.toBe(true);
    await expect(
      hasCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-456",
        persistedLastUpdateId: 900,
        env,
      }),
    ).resolves.toBe(false);
    await expect(
      hasCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "67890:second",
        generation: "generation-123",
        persistedLastUpdateId: 900,
        env,
      }),
    ).resolves.toBe(false);
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
      hasCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        env,
      }),
    ).resolves.toBe(false);
    await expect(
      hasCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: 899,
        env,
      }),
    ).resolves.toBe(false);
    await expect(
      hasCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: 901,
        env,
      }),
    ).resolves.toBe(true);
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
      hasCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: "12345:first",
        generation: "generation-123",
        persistedLastUpdateId: null,
        persistedOffsetIgnored: true,
        env,
      }),
    ).resolves.toBe(true);
  });
});
