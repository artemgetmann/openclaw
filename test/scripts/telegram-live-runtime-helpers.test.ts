import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapTelegramLiveCodexAuthStoreFromSources,
  buildTelegramLiveRuntimeConfig,
  clearEnvAssignmentText,
  readUsableOpenClawCodexAuthStore,
  summarizeTelegramTesterTokenPool,
} from "../../scripts/lib/telegram-live-runtime-helpers.mjs";

function writeAuthStore(filePath: string, store: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function unsignedJwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.`;
}

describe("summarizeTelegramTesterTokenPool", () => {
  it("reports pool exhaustion after claimed and reserved tokens are removed", () => {
    const summary = summarizeTelegramTesterTokenPool({
      poolTokens: ["bot-1", "bot-2", "bot-3"],
      claimedEntries: [
        { token: "bot-1", worktreePath: "/tmp/wt-a" },
        { token: "bot-1", worktreePath: "/tmp/wt-a" },
      ],
      reservedTokens: ["bot-2", "bot-3"],
      currentToken: "",
    });

    expect(summary.poolCount).toBe(3);
    expect(summary.claimedCount).toBe(1);
    expect(summary.reservedCount).toBe(2);
    expect(summary.claimableCount).toBe(0);
    expect(summary.selection.ok).toBe(false);
    expect(summary.selection.reason).toBe("pool_exhausted");
  });

  it("treats a current token reserved by base config as unavailable", () => {
    const summary = summarizeTelegramTesterTokenPool({
      poolTokens: ["bot-1", "bot-2"],
      claimedEntries: [],
      reservedTokens: ["bot-1"],
      currentToken: "bot-1",
    });

    expect(summary.currentTokenStatus).toBe("reserved_by_base_config");
    expect(summary.selection.ok).toBe(true);
    expect(summary.selection.selectedToken).toBe("bot-2");
    expect(summary.selection.reason).toBe("reassign_conflict_or_invalid");
  });

  it("builds a tester runtime config without mutating the canonical source config", () => {
    const baseConfig = {
      env: {
        OPENAI_API_KEY: "sk-live-test",
      },
      channels: {
        telegram: {
          enabled: false,
          botToken: "99999:main-bot",
          accounts: {
            main: { botToken: "88888:main-account" },
          },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "sk-main-provider",
          },
        },
      },
    };

    const config = buildTelegramLiveRuntimeConfig({
      baseConfig,
      assignedToken: "tester-token",
      runtimePort: 24567,
    });

    expect(baseConfig.channels.telegram.botToken).toBe("99999:main-bot");
    expect(baseConfig.channels.telegram.accounts.main.botToken).toBe("88888:main-account");
    expect(baseConfig.env.OPENAI_API_KEY).toBe("sk-live-test");
    expect(baseConfig.models.providers.openai.apiKey).toBe("sk-main-provider");
    expect(config.channels.telegram.botToken).toBe("tester-token");
    expect(config.channels.telegram.accounts).toBeUndefined();
    expect(config.env.OPENAI_API_KEY).toBeUndefined();
    expect(config.models.providers.openai.apiKey).toBeUndefined();
  });
});

describe("clearEnvAssignmentText", () => {
  it("removes every shadowed assignment for a key", () => {
    const result = clearEnvAssignmentText({
      key: "TELEGRAM_BOT_TOKEN",
      content: [
        "FOO=1",
        "TELEGRAM_BOT_TOKEN=bot-a",
        "BAR=2",
        "export TELEGRAM_BOT_TOKEN=bot-b",
        "",
      ].join("\n"),
    });

    expect(result.removed).toBe(true);
    expect(result.removedValue).toBe("bot-b");
    expect(result.content).toBe(["FOO=1", "BAR=2", ""].join("\n"));
  });
});

describe("Codex auth store inheritance", () => {
  it("copies a usable OpenClaw Codex profile into an isolated tester runtime", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-codex-auth-"));
    const sourceAuthPath = path.join(root, "source", "auth-profiles.json");
    const runtimeStateDir = path.join(root, "runtime-state");
    const futureExpiry = Date.now() + 60 * 60 * 1000;
    writeAuthStore(sourceAuthPath, {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "fake-access-token",
          refresh: "fake-refresh-token",
          expires: futureExpiry,
        },
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "fake-anthropic-key",
        },
      },
      order: {
        "openai-codex": ["openai-codex:default"],
        anthropic: ["anthropic:default"],
      },
    });

    const result = bootstrapTelegramLiveCodexAuthStoreFromSources({
      runtimeStateDir,
      agentId: "main",
      sourceAuthPaths: [sourceAuthPath],
      nowMs: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.sourceKind).toBe("openclaw_auth_store");
    const targetAuthPath = path.join(
      runtimeStateDir,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    const copied = JSON.parse(readFileSync(targetAuthPath, "utf8"));
    expect(Object.keys(copied.profiles)).toEqual(["openai-codex:default"]);
    expect(copied.profiles["openai-codex:default"].access).toBe("fake-access-token");
    expect(copied.profiles["anthropic:default"]).toBeUndefined();
    expect(statSync(targetAuthPath).mode & 0o777).toBe(0o600);
  });

  it("selects fresher Codex auth.json over a stale copied OpenClaw profile", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-codex-freshest-"));
    const sourceAuthPath = path.join(root, "source", "auth-profiles.json");
    const runtimeStateDir = path.join(root, "runtime-state");
    const codexHome = path.join(root, "codex-home");
    const nowMs = new Date("2026-06-11T08:00:00Z").getTime();
    const copiedExpiry = nowMs + 30 * 60 * 1000;
    const cliExpiry = nowMs + 2 * 60 * 60 * 1000;
    const cliAccess = unsignedJwtWithExp(Math.floor(cliExpiry / 1000));

    writeAuthStore(sourceAuthPath, {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-copied-access",
          refresh: "stale-copied-refresh",
          expires: copiedExpiry,
        },
      },
    });
    writeAuthStore(path.join(codexHome, "auth.json"), {
      tokens: {
        access_token: cliAccess,
        refresh_token: "fresh-cli-refresh",
        account_id: "acct_123",
      },
    });

    const result = bootstrapTelegramLiveCodexAuthStoreFromSources({
      runtimeStateDir,
      agentId: "main",
      sourceAuthPaths: [sourceAuthPath],
      codexHome,
      nowMs,
      platform: "linux",
    });

    expect(result).toMatchObject({
      ok: true,
      sourceKind: "codex_cli_auth_json",
      accessExpiryMs: cliExpiry,
      expirySource: "jwt_exp",
      candidateCount: 2,
    });
    expect(JSON.stringify(result)).not.toContain("fresh-cli-refresh");
    expect(JSON.stringify(result)).not.toContain("stale-copied-refresh");

    const copied = JSON.parse(readFileSync(String(result.authStorePath), "utf8"));
    expect(copied.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: cliAccess,
      refresh: "fresh-cli-refresh",
      expires: cliExpiry,
      accountId: "acct_123",
    });
  });

  it("selects fresher Codex Keychain auth over a stale copied OpenClaw profile", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-codex-keychain-"));
    const sourceAuthPath = path.join(root, "source", "auth-profiles.json");
    const runtimeStateDir = path.join(root, "runtime-state");
    const codexHome = path.join(root, "codex-home");
    const nowMs = new Date("2026-06-11T08:00:00Z").getTime();
    const copiedExpiry = nowMs + 30 * 60 * 1000;
    const keychainExpiry = nowMs + 3 * 60 * 60 * 1000;
    const keychainAccess = unsignedJwtWithExp(Math.floor(keychainExpiry / 1000));

    writeAuthStore(sourceAuthPath, {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-copied-access",
          refresh: "stale-copied-refresh",
          expires: copiedExpiry,
        },
      },
    });
    mkdirSync(codexHome, { recursive: true });

    const result = bootstrapTelegramLiveCodexAuthStoreFromSources({
      runtimeStateDir,
      agentId: "main",
      sourceAuthPaths: [sourceAuthPath],
      codexHome,
      nowMs,
      platform: "darwin",
      execFileSync: () =>
        JSON.stringify({
          tokens: {
            access_token: keychainAccess,
            refresh_token: "fresh-keychain-refresh",
            account_id: "acct_keychain",
          },
          last_refresh: "2026-06-11T08:30:00Z",
        }),
    });

    expect(result).toMatchObject({
      ok: true,
      sourceKind: "codex_cli_keychain",
      accessExpiryMs: keychainExpiry,
      expirySource: "jwt_exp",
      candidateCount: 2,
    });
    expect(JSON.stringify(result)).not.toContain("fresh-keychain-refresh");
    expect(JSON.stringify(result)).not.toContain("stale-copied-refresh");

    const copied = JSON.parse(readFileSync(String(result.authStorePath), "utf8"));
    expect(copied.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: keychainAccess,
      refresh: "fresh-keychain-refresh",
      expires: keychainExpiry,
      accountId: "acct_keychain",
    });
  });

  it("rejects expired OpenClaw Codex profiles before tester runtime import", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-codex-expired-"));
    const sourceAuthPath = path.join(root, "source", "auth-profiles.json");
    writeAuthStore(sourceAuthPath, {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "fake-access-token",
          refresh: "fake-refresh-token",
          expires: Date.now() - 1000,
        },
      },
    });

    const result = readUsableOpenClawCodexAuthStore({
      authStorePath: sourceAuthPath,
      nowMs: Date.now(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_usable_codex_profile");
  });
});
