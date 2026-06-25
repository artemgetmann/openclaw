import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("telegram-user backend defaults", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("resolves Telegram tooling from a bundled runtime root next to dist", async () => {
    const runtimeRoot = path.join(os.tmpdir(), `openclaw-telegram-runtime-${Date.now()}`);
    const toolingDir = path.join(runtimeRoot, "scripts", "telegram-e2e");
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(path.join(runtimeRoot, "dist"), { recursive: true });
      await mkdir(toolingDir, { recursive: true });
      await Promise.all([
        writeFile(path.join(toolingDir, "requirements.txt"), "telethon>=1.43.1\n"),
        writeFile(path.join(toolingDir, "telethon_cli.py"), "print('ok')\n"),
        writeFile(path.join(toolingDir, "telethon_compat.py"), "# compat\n"),
      ]);
    });

    const { resolveTelegramUserToolingRoot } = await import("./backend.js");

    expect(
      resolveTelegramUserToolingRoot({
        cwd: path.join(runtimeRoot, "workspace"),
        importDir: path.join(runtimeRoot, "dist"),
      }),
    ).toBe(runtimeRoot);
  });

  it("uses OpenClaw state for fresh install mutable Telegram user files", async () => {
    const stateDir = path.join(os.tmpdir(), `openclaw-telegram-user-${Date.now()}`);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const { getTelegramUserDefaults } = await import("./backend.js");

    expect(getTelegramUserDefaults()).toMatchObject({
      defaultEnvFilePath: path.join(stateDir, "telegram-user", ".env.local"),
      defaultSessionPath: path.join(stateDir, "telegram-user", "userbot.session"),
      telegramUserStateDir: path.join(stateDir, "telegram-user"),
    });
  });

  it("honors USERBOT_SESSION from the env file unless --session is explicit", async () => {
    const { resolveTelegramUserSessionPath } = await import("./backend.js");

    expect(
      resolveTelegramUserSessionPath({
        env: { USERBOT_SESSION: "/tmp/from-process" } as NodeJS.ProcessEnv,
        loadedEnv: { USERBOT_SESSION: "/tmp/from-env-file" },
      }),
    ).toBe("/tmp/from-env-file");
    expect(
      resolveTelegramUserSessionPath({
        env: { USERBOT_SESSION: "/tmp/from-process" } as NodeJS.ProcessEnv,
        explicitSession: "/tmp/from-flag",
        loadedEnv: { USERBOT_SESSION: "/tmp/from-env-file" },
      }),
    ).toBe("/tmp/from-flag");
  });
});
