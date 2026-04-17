import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectProtectedCanonicalTelegramBotTokens,
  detectProtectedTelegramTokenConflict,
  extractTelegramBotTokensFromConfig,
  isCanonicalSharedGatewayActive,
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

  it("does not let an isolated OPENCLAW_CONFIG_PATH redefine the canonical shared config", () => {
    const home = makeTempDir();
    const canonicalConfigPath = path.join(home, ".openclaw", "openclaw.json");
    const isolatedConfigPath = path.join(
      home,
      ".openclaw",
      "telegram-live-worktrees",
      "tg-live-1",
      "openclaw.telegram-live.json",
    );
    writeFile(canonicalConfigPath, "{}\n");
    writeFile(isolatedConfigPath, "{}\n");

    expect(
      resolveCanonicalSharedGatewayConfigPath({
        HOME: home,
        OPENCLAW_CONFIG_PATH: isolatedConfigPath,
      }),
    ).toBe(fs.realpathSync.native(canonicalConfigPath));
    expect(
      isCanonicalSharedGatewayConfigPath(isolatedConfigPath, {
        HOME: home,
        OPENCLAW_CONFIG_PATH: isolatedConfigPath,
      }),
    ).toBe(false);
  });

  it("reads protected Telegram bot tokens from the canonical shared config", () => {
    const home = makeTempDir();
    const canonicalMainRepo = path.join(home, "Programming_Projects", "openclaw");
    fs.mkdirSync(path.join(canonicalMainRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(canonicalMainRepo, "dist", "index.js"), "", "utf8");
    fs.writeFileSync(path.join(canonicalMainRepo, "package.json"), "{}\n", "utf8");
    const canonicalMainRepoReal = fs.realpathSync.native(canonicalMainRepo);
    const fakeBin = path.join(home, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    writeFile(
      path.join(fakeBin, "launchctl"),
      `#!/bin/sh\nprintf 'pid = 123\\nprogram = "${canonicalMainRepoReal}/dist/index.js"\\n'\n`,
    );
    writeFile(
      path.join(fakeBin, "ps"),
      `#!/bin/sh\nprintf 'node ${canonicalMainRepoReal}/dist/index.js gateway run\\n'\n`,
    );
    fs.chmodSync(path.join(fakeBin, "launchctl"), 0o755);
    fs.chmodSync(path.join(fakeBin, "ps"), 0o755);
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

    expect(
      isCanonicalSharedGatewayActive({
        HOME: home,
        OPENCLAW_MAIN_REPO: canonicalMainRepo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      }),
    ).toBe(true);
    expect(
      collectProtectedCanonicalTelegramBotTokens({
        HOME: home,
        OPENCLAW_MAIN_REPO: canonicalMainRepo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      }),
    ).toEqual(["main-token", "finance-token", "coder-token"]);
  });

  it("ignores disabled canonical account tokens even while shared runtime is active", () => {
    const home = makeTempDir();
    const canonicalMainRepo = path.join(home, "Programming_Projects", "openclaw");
    fs.mkdirSync(path.join(canonicalMainRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(canonicalMainRepo, "dist", "index.js"), "", "utf8");
    fs.writeFileSync(path.join(canonicalMainRepo, "package.json"), "{}\n", "utf8");
    const canonicalMainRepoReal = fs.realpathSync.native(canonicalMainRepo);
    const fakeBin = path.join(home, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    writeFile(
      path.join(fakeBin, "launchctl"),
      `#!/bin/sh\nprintf 'pid = 123\\nprogram = "${canonicalMainRepoReal}/dist/index.js"\\n'\n`,
    );
    writeFile(
      path.join(fakeBin, "ps"),
      `#!/bin/sh\nprintf 'node ${canonicalMainRepoReal}/dist/index.js gateway run\\n'\n`,
    );
    fs.chmodSync(path.join(fakeBin, "launchctl"), 0o755);
    fs.chmodSync(path.join(fakeBin, "ps"), 0o755);
    writeFile(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({
        channels: {
          telegram: {
            botToken: "main-token",
            accounts: {
              exec: { botToken: "exec-token", enabled: false },
              finance: { botToken: "finance-token", enabled: true },
            },
          },
        },
      }),
    );

    expect(
      collectProtectedCanonicalTelegramBotTokens({
        HOME: home,
        OPENCLAW_MAIN_REPO: canonicalMainRepo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      }),
    ).toEqual(["main-token", "finance-token"]);
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

  it("allows noncanonical runtimes to borrow canonical-config tokens when shared runtime is inactive", () => {
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

    expect(
      detectProtectedTelegramTokenConflict({
        config: {
          channels: {
            telegram: {
              botToken: "main-token",
              accounts: {
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
      }),
    ).toBeNull();
  });

  it("blocks noncanonical runtimes from using canonical shared tokens while shared runtime is active", () => {
    const home = makeTempDir();
    const canonicalConfigPath = path.join(home, ".openclaw", "openclaw.json");
    const canonicalMainRepo = path.join(home, "Programming_Projects", "openclaw");
    fs.mkdirSync(path.join(canonicalMainRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(canonicalMainRepo, "dist", "index.js"), "", "utf8");
    fs.writeFileSync(path.join(canonicalMainRepo, "package.json"), "{}\n", "utf8");
    const canonicalMainRepoReal = fs.realpathSync.native(canonicalMainRepo);
    const fakeBin = path.join(home, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    writeFile(
      path.join(fakeBin, "launchctl"),
      `#!/bin/sh\nprintf 'pid = 123\\nprogram = "${canonicalMainRepoReal}/dist/index.js"\\n'\n`,
    );
    writeFile(
      path.join(fakeBin, "ps"),
      `#!/bin/sh\nprintf 'node ${canonicalMainRepoReal}/dist/index.js gateway run\\n'\n`,
    );
    fs.chmodSync(path.join(fakeBin, "launchctl"), 0o755);
    fs.chmodSync(path.join(fakeBin, "ps"), 0o755);
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
      env: {
        HOME: home,
        OPENCLAW_MAIN_REPO: canonicalMainRepo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });

    expect(conflict).toEqual({
      tokens: ["main-token", "finance-token"],
      protectedBy: fs.realpathSync.native(canonicalConfigPath),
    });
  });

  it("allows noncanonical runtimes to borrow disabled canonical account tokens while shared runtime is active", () => {
    const home = makeTempDir();
    const canonicalConfigPath = path.join(home, ".openclaw", "openclaw.json");
    const canonicalMainRepo = path.join(home, "Programming_Projects", "openclaw");
    fs.mkdirSync(path.join(canonicalMainRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(canonicalMainRepo, "dist", "index.js"), "", "utf8");
    fs.writeFileSync(path.join(canonicalMainRepo, "package.json"), "{}\n", "utf8");
    const canonicalMainRepoReal = fs.realpathSync.native(canonicalMainRepo);
    const fakeBin = path.join(home, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    writeFile(
      path.join(fakeBin, "launchctl"),
      `#!/bin/sh\nprintf 'pid = 123\\nprogram = "${canonicalMainRepoReal}/dist/index.js"\\n'\n`,
    );
    writeFile(
      path.join(fakeBin, "ps"),
      `#!/bin/sh\nprintf 'node ${canonicalMainRepoReal}/dist/index.js gateway run\\n'\n`,
    );
    fs.chmodSync(path.join(fakeBin, "launchctl"), 0o755);
    fs.chmodSync(path.join(fakeBin, "ps"), 0o755);
    writeFile(
      canonicalConfigPath,
      JSON.stringify({
        channels: {
          telegram: {
            botToken: "main-token",
            accounts: {
              exec: { botToken: "exec-token", enabled: false },
              finance: { botToken: "finance-token", enabled: true },
            },
          },
        },
      }),
    );

    const conflict = detectProtectedTelegramTokenConflict({
      config: {
        channels: {
          telegram: {
            botToken: "exec-token",
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
      env: {
        HOME: home,
        OPENCLAW_MAIN_REPO: canonicalMainRepo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });

    expect(conflict).toBeNull();
  });
});
