import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempToolingRoots: string[] = [];

async function makeTelegramToolingRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempToolingRoots.push(root);
  const toolingDir = path.join(root, "scripts", "telegram-e2e");
  await fs.mkdir(toolingDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(toolingDir, "requirements.txt"), "telethon>=1.43.1\n"),
    fs.writeFile(path.join(toolingDir, "telethon_cli.py"), "print('ok')\n"),
    fs.writeFile(path.join(toolingDir, "telethon_compat.py"), "# compat\n"),
  ]);
  return root;
}

describe("telegram-user backend defaults", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    const roots = tempToolingRoots.splice(0);
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("resolves Telegram tooling from a bundled runtime root next to dist", async () => {
    const runtimeRoot = await makeTelegramToolingRoot("openclaw-telegram-runtime-");
    await fs.mkdir(path.join(runtimeRoot, "dist"), { recursive: true });

    const { resolveTelegramUserToolingRoot } = await import("./backend.js");

    expect(
      resolveTelegramUserToolingRoot({
        cwd: path.join(runtimeRoot, "workspace"),
        importDir: path.join(runtimeRoot, "dist"),
      }),
    ).toBe(runtimeRoot);
  });

  it("prefers bundled runtime tooling over stale caller cwd tooling", async () => {
    const runtimeRoot = await makeTelegramToolingRoot("openclaw-telegram-runtime-");
    const staleCwdRoot = await makeTelegramToolingRoot("openclaw-telegram-stale-cwd-");
    await fs.mkdir(path.join(runtimeRoot, "dist", "telegram-user"), { recursive: true });

    const { resolveTelegramUserToolingRoot } = await import("./backend.js");

    expect(
      resolveTelegramUserToolingRoot({
        cwd: staleCwdRoot,
        importDir: path.join(runtimeRoot, "dist", "telegram-user"),
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
