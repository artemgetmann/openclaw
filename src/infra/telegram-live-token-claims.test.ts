import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectClaimedTelegramBotTokens,
  detectProtectedTelegramTokenConflict,
  extractTelegramBotTokensFromConfig,
  isTelegramLiveRuntimeConfigPath,
} from "./telegram-live-token-claims.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-claims-"));
  tempDirs.push(dir);
  return dir;
}

function canonicalize(targetPath: string): string {
  return fs.realpathSync.native(targetPath);
}

function writeFile(targetPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("telegram live token claims", () => {
  it("extracts Telegram bot tokens from top-level and account config", () => {
    expect(
      extractTelegramBotTokensFromConfig({
        channels: {
          telegram: {
            botToken: "default-token",
            accounts: {
              finance: { botToken: "finance-token" },
              empty: { enabled: true },
            },
          },
        },
      }),
    ).toEqual(["default-token", "finance-token"]);
  });

  it("collects claimed tokens from the canonical repo root and worktrees", () => {
    const repoRoot = makeTempDir();
    const canonicalRepoRoot = canonicalize(repoRoot);
    writeFile(path.join(repoRoot, ".git"), "gitdir: /tmp/fake\n");
    writeFile(path.join(repoRoot, ".env.local"), 'TELEGRAM_BOT_TOKEN="root-token"\n');
    writeFile(
      path.join(repoRoot, ".worktrees", "alpha", ".env.local"),
      "TELEGRAM_BOT_TOKEN=alpha-token\n",
    );
    writeFile(
      path.join(repoRoot, ".worktrees", "beta", ".env.local"),
      "TELEGRAM_BOT_TOKEN=alpha-token\n",
    );

    const claims = collectClaimedTelegramBotTokens({
      HOME: path.dirname(path.dirname(repoRoot)),
      OPENCLAW_MAIN_REPO: repoRoot,
    });

    expect(claims.get("root-token")).toEqual([canonicalRepoRoot]);
    expect(claims.get("alpha-token")).toEqual([
      path.join(canonicalRepoRoot, ".worktrees", "alpha"),
      path.join(canonicalRepoRoot, ".worktrees", "beta"),
    ]);
  });

  it("treats telegram-live runtime configs as exempt from the protected-token guard", () => {
    const home = makeTempDir();
    const liveConfigPath = path.join(
      home,
      ".openclaw",
      "telegram-live-worktrees",
      "tg-live-deadbeef00",
      "openclaw.telegram-live.json",
    );

    expect(isTelegramLiveRuntimeConfigPath(liveConfigPath, { HOME: home })).toBe(true);
    expect(
      detectProtectedTelegramTokenConflict({
        config: {
          channels: {
            telegram: {
              botToken: "finance-token",
            },
          },
        },
        configPath: liveConfigPath,
        env: { HOME: home, OPENCLAW_MAIN_REPO: home },
      }),
    ).toBeNull();
  });

  it("flags non-telegram-live configs that try to use claimed live tokens", () => {
    const repoRoot = makeTempDir();
    const canonicalRepoRoot = canonicalize(repoRoot);
    const home = makeTempDir();
    writeFile(path.join(repoRoot, ".git"), "gitdir: /tmp/fake\n");
    writeFile(path.join(repoRoot, ".env.local"), "TELEGRAM_BOT_TOKEN=finance-token\n");

    const conflict = detectProtectedTelegramTokenConflict({
      config: {
        channels: {
          telegram: {
            botToken: "finance-token",
            accounts: {
              coder: { botToken: "coder-token" },
            },
          },
        },
      },
      configPath: path.join(home, ".openclaw", "openclaw.json"),
      env: {
        HOME: home,
        OPENCLAW_MAIN_REPO: repoRoot,
      },
    });

    expect(conflict).toEqual({
      tokens: ["finance-token"],
      claimPaths: [canonicalRepoRoot],
    });
  });
});
