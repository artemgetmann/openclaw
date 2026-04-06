import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTelegramLiveRuntimeConfig,
  collectActiveTelegramTokenLeaseEntries,
  extractTelegramBotTokensFromConfig,
  selectTelegramTesterToken,
} from "../../scripts/lib/telegram-live-runtime-helpers.mjs";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-live-helper-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("telegram live runtime helpers", () => {
  it("extracts reserved Telegram bot tokens from base config", () => {
    const tokens = extractTelegramBotTokensFromConfig({
      channels: {
        telegram: {
          botToken: "default-token",
          accounts: {
            coder: { botToken: "coder-token" },
            empty: { enabled: true },
            finance: { botToken: "finance-token" },
          },
        },
      },
    });

    expect(tokens).toEqual(["default-token", "coder-token", "finance-token"]);
  });

  it("reassigns when the current tester token is reserved by the main runtime", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["prod-token", "tester-a", "tester-b"],
      claimedTokens: ["tester-a"],
      reservedTokens: ["prod-token"],
      currentToken: "prod-token",
    });

    expect(result).toMatchObject({
      ok: true,
      action: "assign",
      reason: "reassign_conflict_or_invalid",
      selectedToken: "tester-b",
    });
  });

  it("reassigns when the current tester token is actively leased by another runtime", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["tester-a", "tester-b"],
      claimedTokens: [],
      leasedEntries: [{ token: "tester-a", worktreePath: "/tmp/other", pid: 123 }],
      reservedTokens: [],
      currentToken: "tester-a",
    });

    expect(result).toMatchObject({
      ok: true,
      action: "assign",
      reason: "reassign_conflict_or_invalid",
      selectedToken: "tester-b",
    });
  });

  it("detects active leases from other worktrees without blocking the current worktree lease", () => {
    const leaseRoot = makeTempDir();
    const currentWorktree = "/repo/current";
    const otherWorktree = "/repo/other";
    const liveToken = "12345:live";
    const localToken = "23456:local";
    const liveHash = crypto.createHash("sha256").update(liveToken).digest("hex");
    const localHash = crypto.createHash("sha256").update(localToken).digest("hex");

    fs.writeFileSync(
      path.join(leaseRoot, `12345-${liveHash}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        starttime: null,
        createdAt: new Date().toISOString(),
        tokenHash: liveHash,
        tokenFingerprint: "livefinger",
        botId: "12345",
        accountId: "finance",
        worktree: otherWorktree,
      }),
    );
    fs.writeFileSync(
      path.join(leaseRoot, `23456-${localHash}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        starttime: null,
        createdAt: new Date().toISOString(),
        tokenHash: localHash,
        tokenFingerprint: "localfinger",
        botId: "23456",
        accountId: "tester",
        worktree: currentWorktree,
      }),
    );

    expect(
      collectActiveTelegramTokenLeaseEntries({
        tokens: [liveToken, localToken],
        leaseRoot,
        currentWorktreePath: currentWorktree,
      }),
    ).toEqual([
      { token: liveToken, worktreePath: otherWorktree, pid: process.pid, accountId: "finance" },
    ]);
  });

  it("builds a Telegram-only runtime config that disables ACP and uses API-key model routing", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        env: {
          OPENAI_API_KEY: "sk-live-test",
        },
        acp: {
          backend: "acpx",
          dispatch: { enabled: true },
        },
        channels: {
          telegram: {
            enabled: false,
            requireMention: false,
            accounts: {
              coder: { botToken: "prod-token" },
            },
          },
          slack: { enabled: true },
        },
        plugins: {
          allow: ["slack"],
          deny: ["legacy"],
          entries: {
            acpx: { enabled: true },
            slack: { enabled: true },
          },
          slots: {
            memory: "default",
          },
        },
      },
      assignedToken: "tester-token",
      runtimePort: 24567,
    });

    expect(config.gateway).toMatchObject({
      port: 24567,
      bind: "loopback",
      mode: "local",
      controlUi: { enabled: false },
    });
    expect(config.channels).toEqual({
      telegram: {
        enabled: true,
        requireMention: false,
        botToken: "tester-token",
      },
    });
    expect(config.agents?.defaults?.model).toMatchObject({
      primary: "openai/gpt-5.4",
      fallbacks: [],
    });
    expect(config.acp).toEqual({
      enabled: false,
      dispatch: { enabled: false },
    });
    expect(config.plugins).toMatchObject({
      enabled: true,
      allow: ["telegram"],
      slots: { memory: "none" },
    });
    expect(config.plugins?.deny).toEqual(["legacy", "acpx"]);
    expect(config.plugins?.entries?.telegram).toMatchObject({ enabled: true });
    expect(config.plugins?.entries?.acpx).toMatchObject({ enabled: false });
  });

  it("honors an explicit preferred model for isolated Telegram tester lanes", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        env: {
          OPENAI_API_KEY: "sk-live-test",
        },
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5"],
            },
          },
        },
      },
      assignedToken: "tester-token",
      preferredModel: "openai-codex/gpt-5.4",
      runtimePort: 24567,
    });

    expect(config.agents?.defaults?.model).toMatchObject({
      primary: "openai-codex/gpt-5.4",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });
});
