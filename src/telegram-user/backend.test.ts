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

  it("discovers a monitor service binding in a later backend import for the same state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-binding-state-"));
    tempToolingRoots.push(stateDir);
    const boundEnvFile = path.join(stateDir, "configured.env");
    const boundSession = path.join(stateDir, "configured.session");
    await fs.writeFile(boundEnvFile, "TELEGRAM_API_ID=123\n");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const { writeTelegramUserMonitorBinding } = await import("./monitor-service-binding.js");
    await writeTelegramUserMonitorBinding({
      env: process.env,
      envFile: boundEnvFile,
      session: boundSession,
    });

    // Resetting modules models the later CLI/backend process: it gets only the
    // same profile/state selectors, not the original monitor install arguments.
    vi.resetModules();
    const { resolveTelegramUserBackendSelectors } = await import("./backend.js");
    await expect(resolveTelegramUserBackendSelectors({})).resolves.toEqual({
      envFilePath: boundEnvFile,
      sessionPath: boundSession,
    });
    await expect(
      resolveTelegramUserBackendSelectors({
        envFile: path.join(stateDir, "explicit.env"),
        session: path.join(stateDir, "explicit.session"),
      }),
    ).resolves.toEqual({
      envFilePath: path.join(stateDir, "explicit.env"),
      sessionPath: path.join(stateDir, "explicit.session"),
    });

    const explicitEnvFile = path.join(stateDir, "explicit-with-session.env");
    const envSelectedSession = path.join(stateDir, "env-selected.session");
    await fs.writeFile(explicitEnvFile, `USERBOT_SESSION=${envSelectedSession}\n`);
    await expect(
      resolveTelegramUserBackendSelectors({ envFile: explicitEnvFile }),
    ).resolves.toEqual({
      envFilePath: explicitEnvFile,
      sessionPath: envSelectedSession,
    });
  });

  it("normalizes consumer runtime identity before reading the monitor binding", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-consumer-home-"));
    tempToolingRoots.push(homeDir);
    const boundEnvFile = path.join(homeDir, "configured.env");
    const boundSession = path.join(homeDir, "configured.session");
    await fs.writeFile(boundEnvFile, "TELEGRAM_API_ID=123\n");
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_PROFILE", "consumer-lane");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(homeDir, "raw-profile-state"));

    const { resolveGatewayRuntimeIdentityEnv } = await import("../daemon/service-env.js");
    const { writeTelegramUserMonitorBinding } = await import("./monitor-service-binding.js");
    await writeTelegramUserMonitorBinding({
      env: resolveGatewayRuntimeIdentityEnv(process.env) as NodeJS.ProcessEnv,
      envFile: boundEnvFile,
      session: boundSession,
    });

    vi.resetModules();
    const { resolveTelegramUserBackendSelectors } = await import("./backend.js");
    await expect(resolveTelegramUserBackendSelectors({})).resolves.toEqual({
      envFilePath: boundEnvFile,
      sessionPath: boundSession,
    });
  });

  it("uses canonical consumer state defaults when the monitor binding has no selectors", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-consumer-home-"));
    tempToolingRoots.push(homeDir);
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_PROFILE", "consumer-lane");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(homeDir, "raw-profile-state"));

    const { resolveConsumerRuntimeIdentity } = await import("../consumer/runtime-identity.js");
    const { resolveGatewayRuntimeIdentityEnv } = await import("../daemon/service-env.js");
    const { writeTelegramUserMonitorBinding } = await import("./monitor-service-binding.js");
    const identity = resolveConsumerRuntimeIdentity({ homeDir, instanceId: "lane" });
    await writeTelegramUserMonitorBinding({
      env: resolveGatewayRuntimeIdentityEnv(process.env) as NodeJS.ProcessEnv,
    });

    vi.resetModules();
    const { resolveTelegramUserBackendSelectors } = await import("./backend.js");

    await expect(resolveTelegramUserBackendSelectors({})).resolves.toEqual({
      envFilePath: path.join(identity.stateDir, "telegram-user", ".env.local"),
      sessionPath: path.join(identity.stateDir, "telegram-user", "userbot.session"),
    });
  });

  it("uses explicit env-file credentials even when the persisted binding is unreadable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-binding-state-"));
    tempToolingRoots.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const { resolveTelegramUserMonitorBindingPath } = await import("./monitor-service-binding.js");
    await fs.mkdir(resolveTelegramUserMonitorBindingPath(process.env), { recursive: true });

    const explicitEnvFile = path.join(stateDir, "explicit.env");
    const envSelectedSession = path.join(stateDir, "env-selected.session");
    await fs.writeFile(explicitEnvFile, `USERBOT_SESSION=${envSelectedSession}\n`);
    const { resolveTelegramUserBackendSelectors } = await import("./backend.js");

    await expect(
      resolveTelegramUserBackendSelectors({ envFile: explicitEnvFile }),
    ).resolves.toEqual({
      envFilePath: explicitEnvFile,
      sessionPath: envSelectedSession,
    });
    await expect(
      resolveTelegramUserBackendSelectors({
        envFile: explicitEnvFile,
        session: path.join(stateDir, "flag.session"),
      }),
    ).resolves.toEqual({
      envFilePath: explicitEnvFile,
      sessionPath: path.join(stateDir, "flag.session"),
    });
  });
});
