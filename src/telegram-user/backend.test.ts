import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("telegram-user backend defaults", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
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
