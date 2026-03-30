import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectProtectedCanonicalTelegramBotTokens,
  detectProtectedTelegramTokenConflict,
  extractTelegramBotTokensFromConfig,
  isCanonicalSharedGatewayConfigPath,
  resolveCanonicalSharedGatewayConfigPath,
} from "./telegram-live-token-claims.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-protected-"));
  tempDirs.push(dir);
  return dir;
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

describe("telegram shared-token protection", () => {
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

  it("resolves the canonical shared gateway config path under ~/.openclaw", () => {
    const home = makeTempDir();
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    writeFile(configPath, "{}\n");

    expect(resolveCanonicalSharedGatewayConfigPath({ HOME: home })).toBe(
      fs.realpathSync.native(configPath),
    );
    expect(isCanonicalSharedGatewayConfigPath(configPath, { HOME: home })).toBe(true);
  });

  it("reads protected Telegram bot tokens from the canonical shared config", () => {
    const home = makeTempDir();
    writeFile(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({
        channels: {
          telegram: {
            botToken: "main-token",
            accounts: {
              finance: { botToken: "finance-token" },
              coder: { botToken: "coder-token" },
            },
          },
        },
      }),
    );

    expect(collectProtectedCanonicalTelegramBotTokens({ HOME: home })).toEqual([
      "main-token",
      "finance-token",
      "coder-token",
    ]);
  });

  it("allows the canonical shared config to use protected tokens", () => {
    const home = makeTempDir();
    const canonicalConfigPath = path.join(home, ".openclaw", "openclaw.json");
    writeFile(
      canonicalConfigPath,
      JSON.stringify({
        channels: {
          telegram: {
            botToken: "main-token",
          },
        },
      }),
    );

    expect(
      detectProtectedTelegramTokenConflict({
        config: {
          channels: {
            telegram: {
              botToken: "main-token",
            },
          },
        },
        configPath: canonicalConfigPath,
        env: { HOME: home },
      }),
    ).toBeNull();
  });

  it("blocks noncanonical runtimes from using canonical shared tokens", () => {
    const home = makeTempDir();
    const canonicalConfigPath = path.join(home, ".openclaw", "openclaw.json");
    writeFile(
      canonicalConfigPath,
      JSON.stringify({
        channels: {
          telegram: {
            botToken: "main-token",
            accounts: {
              finance: { botToken: "finance-token" },
            },
          },
        },
      }),
    );

    const conflict = detectProtectedTelegramTokenConflict({
      config: {
        channels: {
          telegram: {
            botToken: "main-token",
            accounts: {
              tester: { botToken: "tester-token" },
              finance: { botToken: "finance-token" },
            },
          },
        },
      },
      configPath: path.join(
        home,
        ".openclaw",
        "telegram-live-worktrees",
        "tg-live-1",
        "openclaw.telegram-live.json",
      ),
      env: { HOME: home },
    });

    expect(conflict).toEqual({
      tokens: ["main-token", "finance-token"],
      protectedBy: fs.realpathSync.native(canonicalConfigPath),
    });
  });
});
