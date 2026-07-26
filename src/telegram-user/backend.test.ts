import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempToolingRoots: string[] = [];
const hostMachineSelectorPath = path.join(
  os.homedir(),
  ".openclaw",
  "telegram-user",
  "canonical-session.path",
);
const hostRepoSelectorPath = path.join(
  process.cwd(),
  "scripts",
  "telegram-e2e",
  "tmp",
  "userbot.session.path",
);
const hostRepoSelectorScopePath = path.join(
  process.cwd(),
  "scripts",
  "telegram-e2e",
  "tmp",
  "userbot.session.scope",
);
const realExistsSync = fsSync.existsSync.bind(fsSync);

async function makeTelegramToolingRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempToolingRoots.push(root);
  const toolingDir = path.join(root, "scripts", "telegram-e2e");
  await fs.mkdir(toolingDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(toolingDir, "requirements.txt"), "telethon>=1.43.1\n"),
    fs.writeFile(path.join(toolingDir, "session_owner.py"), "# owner\n"),
    fs.writeFile(path.join(toolingDir, "telethon_cli.py"), "print('ok')\n"),
    fs.writeFile(path.join(toolingDir, "telethon_compat.py"), "# compat\n"),
  ]);
  return root;
}

describe("telegram-user backend defaults", () => {
  beforeEach(() => {
    // Unit tests must not inherit the developer machine's live ownership
    // decision. Temp-HOME selectors created by individual tests remain visible.
    vi.spyOn(fsSync, "existsSync").mockImplementation((target) =>
      String(target) === hostMachineSelectorPath ||
      String(target) === hostRepoSelectorPath ||
      String(target) === hostRepoSelectorScopePath
        ? false
        : realExistsSync(target),
    );
  });

  afterEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
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

  it("keeps credentials profile-local but defaults the session to machine-local state", async () => {
    const stateDir = path.join(os.tmpdir(), `openclaw-telegram-user-${Date.now()}`);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const { getTelegramUserDefaults } = await import("./backend.js");

    expect(getTelegramUserDefaults()).toMatchObject({
      defaultEnvFilePath: path.join(stateDir, "telegram-user", ".env.local"),
      defaultSessionPath: path.join(os.homedir(), ".openclaw", "telegram-user", "userbot.session"),
      telegramUserStateDir: path.join(stateDir, "telegram-user"),
    });
  });

  it("honors managed worktree selectors when tooling is loaded from an installed runtime", async () => {
    const installedStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-telegram-installed-state-"),
    );
    const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-worktree-"));
    tempToolingRoots.push(installedStateDir, worktreeRoot);
    const envFilePath = path.join(worktreeRoot, "scripts", "telegram-e2e", ".env.local");
    const sessionPath = path.join(worktreeRoot, "selected-account.session");
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(
      envFilePath,
      "TELEGRAM_API_ID=123\nTELEGRAM_API_HASH=test-hash\nUSERBOT_SESSION=/stale/from-env\n",
    );
    await fs.writeFile(sessionPath, "placeholder session\n");
    vi.stubEnv("OPENCLAW_STATE_DIR", installedStateDir);
    vi.stubEnv("OPENCLAW_TELEGRAM_USER_ENV_FILE", envFilePath);
    vi.stubEnv("OPENCLAW_TELEGRAM_USER_SESSION", sessionPath);

    const { resolveTelegramUserBackendSelectors } = await import("./backend.js");

    // Managed child-process selectors are an explicit pair and must beat both
    // installed-runtime defaults and stale values inside the selected env file.
    await expect(resolveTelegramUserBackendSelectors({})).resolves.toEqual({
      envFilePath,
      envFileSource: "explicit",
      sessionPath,
    });
  });

  it("keeps a caller-selected env file's session ahead of the managed lane session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-selector-state-"));
    tempToolingRoots.push(stateDir);
    const ambientEnvFile = path.join(stateDir, "ambient.env");
    const ambientSession = path.join(stateDir, "ambient.session");
    const explicitEnvFile = path.join(stateDir, "explicit.env");
    const envSelectedSession = path.join(stateDir, "env-selected.session");
    await fs.writeFile(ambientEnvFile, `USERBOT_SESSION=${ambientSession}\n`);
    await fs.writeFile(explicitEnvFile, `USERBOT_SESSION=${envSelectedSession}\n`);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_TELEGRAM_USER_ENV_FILE", ambientEnvFile);
    vi.stubEnv("OPENCLAW_TELEGRAM_USER_SESSION", ambientSession);

    const { resolveTelegramUserBackendSelectors } = await import("./backend.js");

    await expect(
      resolveTelegramUserBackendSelectors({ envFile: explicitEnvFile }),
    ).resolves.toEqual({
      envFilePath: explicitEnvFile,
      envFileSource: "explicit",
      sessionPath: envSelectedSession,
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

  it("migrates only recognized repo-relative session selectors to the machine owner", async () => {
    const { resolveTelegramUserSessionSelection } = await import("./backend.js");
    const canonicalSession = "/tmp/machine-owner/userbot.session";

    expect(
      resolveTelegramUserSessionSelection({
        canonicalSession,
        env: {} as NodeJS.ProcessEnv,
        loadedEnv: { USERBOT_SESSION: "scripts/telegram-e2e/tmp/userbot.session" },
      }),
    ).toEqual({ sessionPath: canonicalSession, source: "env-file" });
    expect(
      resolveTelegramUserSessionSelection({
        canonicalSession,
        env: {} as NodeJS.ProcessEnv,
        explicitSession: "/tmp/separate-account.session",
        loadedEnv: { USERBOT_SESSION: "scripts/telegram-e2e/tmp/userbot.session" },
      }),
    ).toEqual({ sessionPath: "/tmp/separate-account.session", source: "explicit" });
    expect(() =>
      resolveTelegramUserSessionSelection({
        canonicalSession,
        env: {} as NodeJS.ProcessEnv,
        loadedEnv: { USERBOT_SESSION: "custom/relative.session" },
      }),
    ).toThrow("E_INVALID_SESSION_SELECTOR: env-file Telegram session selector must be absolute.");
  });

  it("migrates a known state-local env selector but preserves explicit absolute overrides", async () => {
    const { resolveTelegramUserSessionSelection } = await import("./backend.js");
    const stateDir = "/tmp/jarvis-app-state";
    const stateLocalSession = path.join(stateDir, "telegram-user", "userbot.session");
    const canonicalSession = "/tmp/machine-owner/userbot.session";
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

    expect(
      resolveTelegramUserSessionSelection({
        canonicalSession,
        env,
        loadedEnv: { USERBOT_SESSION: stateLocalSession },
      }),
    ).toEqual({ sessionPath: canonicalSession, source: "env-file" });
    expect(
      resolveTelegramUserSessionSelection({
        canonicalSession,
        env,
        explicitSession: stateLocalSession,
      }),
    ).toEqual({ sessionPath: stateLocalSession, source: "explicit" });
  });

  it("keeps an absent repo session selector target authoritative over existing state legacy", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-pinned-home-"));
    const stateDir = path.join(homeDir, "state");
    tempToolingRoots.push(homeDir);
    const stateSession = path.join(stateDir, "telegram-user", "userbot.session");
    const pinnedSession = path.join(stateDir, "canonical-owner", "userbot.session");
    const machineSession = path.join(homeDir, ".openclaw", "telegram-user", "userbot.session");
    const selectorPath = path.join(
      process.cwd(),
      "scripts",
      "telegram-e2e",
      "tmp",
      "userbot.session.path",
    );
    await fs.mkdir(path.dirname(stateSession), { recursive: true });
    await fs.writeFile(stateSession, "fixture-state\n");
    const originalReadFileSync = fsSync.readFileSync;
    vi.mocked(fsSync.existsSync).mockImplementation((target) =>
      String(target) === selectorPath ? true : realExistsSync(target),
    );
    vi.spyOn(fsSync, "readFileSync").mockImplementation(((
      target: fsSync.PathOrFileDescriptor,
      options?: unknown,
    ) =>
      String(target) === selectorPath
        ? `${pinnedSession}\n`
        : originalReadFileSync(target, options as never)) as typeof fsSync.readFileSync);

    const { resolveTelegramUserSessionSelection } = await import("./backend.js");
    expect(
      resolveTelegramUserSessionSelection({
        env: { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      sessionPath: pinnedSession,
      source: "machine-default",
    });
    await expect(fs.access(pinnedSession)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.mkdir(path.dirname(machineSession), { recursive: true });
    await fs.writeFile(machineSession, "fixture-machine\n");
    expect(() =>
      resolveTelegramUserSessionSelection({
        env: { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      }),
    ).toThrow("E_AMBIGUOUS_SESSION");

    expect(
      resolveTelegramUserSessionSelection({
        canonicalSession: pinnedSession,
        env: { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      sessionPath: pinnedSession,
      source: "machine-default",
    });
  });

  it("keeps a tagged explicit lane owner above an existing machine owner", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-explicit-lane-"));
    tempToolingRoots.push(homeDir);
    const explicitSession = path.join(homeDir, "separate-account.session");
    const machineSession = path.join(homeDir, "machine-account.session");
    const machineSelectorPath = path.join(
      homeDir,
      ".openclaw",
      "telegram-user",
      "canonical-session.path",
    );
    await fs.mkdir(path.dirname(machineSelectorPath), { recursive: true });
    await fs.writeFile(machineSelectorPath, `${machineSession}\n`, { mode: 0o600 });

    const originalReadFileSync = fsSync.readFileSync;
    vi.mocked(fsSync.existsSync).mockImplementation((target) => {
      if (String(target) === hostMachineSelectorPath) {
        return false;
      }
      return String(target) === hostRepoSelectorPath || String(target) === hostRepoSelectorScopePath
        ? true
        : realExistsSync(target);
    });
    vi.spyOn(fsSync, "readFileSync").mockImplementation(((
      target: fsSync.PathOrFileDescriptor,
      options?: unknown,
    ) => {
      if (String(target) === hostRepoSelectorPath) {
        return `${explicitSession}\n`;
      }
      if (String(target) === hostRepoSelectorScopePath) {
        return "explicit-canonical\n";
      }
      return originalReadFileSync(target, options as never);
    }) as typeof fsSync.readFileSync);

    const { resolveTelegramUserSessionSelection } = await import("./backend.js");
    expect(
      resolveTelegramUserSessionSelection({
        env: { HOME: homeDir } as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      sessionPath: explicitSession,
      source: "explicit-repo-selector",
    });
  });

  it("keeps a machine-wide owner claim authoritative across divergent legacy files", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-owner-home-"));
    const stateDir = path.join(homeDir, "jarvis-state");
    tempToolingRoots.push(homeDir);
    const machineSession = path.join(homeDir, ".openclaw", "telegram-user", "userbot.session");
    const claimedSession = path.join(stateDir, "telegram-user", "userbot.session");
    const selectorPath = path.join(homeDir, ".openclaw", "telegram-user", "canonical-session.path");
    await fs.mkdir(path.dirname(machineSession), { recursive: true });
    await fs.mkdir(path.dirname(claimedSession), { recursive: true });
    await fs.writeFile(machineSession, "unauthorized-machine-fixture\n");
    await fs.writeFile(claimedSession, "authorized-jarvis-fixture\n");
    await fs.writeFile(selectorPath, `${claimedSession}\n`, { mode: 0o600 });

    const { resolveTelegramUserSessionSelection } = await import("./backend.js");
    expect(
      resolveTelegramUserSessionSelection({
        env: { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
        loadedEnv: { USERBOT_SESSION: claimedSession },
      }),
    ).toEqual({
      sessionPath: claimedSession,
      source: "machine-selector",
    });
  });

  it("keeps a missing machine owner authoritative until locked bootstrap recovery", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-stale-owner-"));
    const stateDir = path.join(homeDir, "stable-state");
    tempToolingRoots.push(homeDir);
    const selectorPath = path.join(homeDir, ".openclaw", "telegram-user", "canonical-session.path");
    const deletedSession = path.join(homeDir, "deleted-worktree", "userbot.session");
    await fs.mkdir(path.dirname(selectorPath), { recursive: true });
    await fs.writeFile(selectorPath, `${deletedSession}\n`, { mode: 0o600 });

    const { resolveTelegramUserSessionSelection } = await import("./backend.js");
    expect(
      resolveTelegramUserSessionSelection({
        env: { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      sessionPath: deletedSession,
      source: "machine-selector",
    });
  });

  it("discovers the sacred-main owner source without an env override", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-main-owner-"));
    tempToolingRoots.push(homeDir);
    const mainSession = path.join(
      homeDir,
      "Programming_Projects",
      "openclaw",
      "scripts",
      "telegram-e2e",
      "tmp",
      "userbot.session",
    );
    await fs.mkdir(path.dirname(mainSession), { recursive: true });
    await fs.writeFile(mainSession, "main-owner-fixture\n");

    const { resolveTelegramUserOwnerCandidates } = await import("./backend.js");
    expect(
      resolveTelegramUserOwnerCandidates({ HOME: homeDir } as NodeJS.ProcessEnv),
    ).toContainEqual({
      path: mainSession,
      source: "main-canonical-legacy",
    });
  });

  it("includes a custom machine-selector owner in later account comparisons", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-selected-owner-"));
    tempToolingRoots.push(homeDir);
    const selectorPath = path.join(homeDir, ".openclaw", "telegram-user", "canonical-session.path");
    const selectedSession = path.join(homeDir, "retained-owner", "operator.session");
    await fs.mkdir(path.dirname(selectorPath), { recursive: true });
    await fs.mkdir(path.dirname(selectedSession), { recursive: true });
    await fs.writeFile(selectedSession, "selected-owner-fixture\n");
    await fs.writeFile(selectorPath, `${selectedSession}\n`, { mode: 0o600 });

    const { resolveTelegramUserOwnerCandidates } = await import("./backend.js");
    expect(
      resolveTelegramUserOwnerCandidates({ HOME: homeDir } as NodeJS.ProcessEnv),
    ).toContainEqual({
      path: selectedSession,
      source: "machine-selector",
    });
  });

  it("lets a process lock pin override the env-file selector and validates the winner", async () => {
    const { resolveTelegramUserLockSelection } = await import("./backend.js");

    expect(
      resolveTelegramUserLockSelection({
        env: {
          HOME: "/tmp/test-home",
          OPENCLAW_TELEGRAM_USER_LOCK_PATH: "/tmp/process-owner.lock",
        } as NodeJS.ProcessEnv,
        loadedEnv: {
          OPENCLAW_TELEGRAM_USER_LOCK_PATH: "/tmp/env-file-owner.lock",
        },
      }),
    ).toEqual({
      lockPath: "/tmp/process-owner.lock",
      scope: "explicit",
    });
    expect(
      resolveTelegramUserLockSelection({
        env: {
          HOME: "/tmp/test-home",
          OPENCLAW_TELEGRAM_USER_LOCK_PATH:
            "/tmp/test-home/.openclaw/telegram-user/userbot.session.openclaw.lock",
        } as NodeJS.ProcessEnv,
        loadedEnv: {
          OPENCLAW_TELEGRAM_USER_LOCK_PATH: "/tmp/env-file-owner.lock",
        },
      }),
    ).toEqual({
      lockPath: "/tmp/test-home/.openclaw/telegram-user/userbot.session.openclaw.lock",
      scope: "machine",
    });
    expect(() =>
      resolveTelegramUserLockSelection({
        env: {
          OPENCLAW_TELEGRAM_USER_LOCK_PATH: "relative/process-owner.lock",
        } as NodeJS.ProcessEnv,
        loadedEnv: {
          OPENCLAW_TELEGRAM_USER_LOCK_PATH: "/tmp/env-file-owner.lock",
        },
      }),
    ).toThrow("E_INVALID_LOCK_SELECTOR");
  });

  it("lets an absolute selector bypass divergent defaults while implicit selection fails closed", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-ambiguity-home-"));
    const stateDir = path.join(homeDir, "jarvis-state");
    tempToolingRoots.push(homeDir);
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const machineSession = path.join(homeDir, ".openclaw", "telegram-user", "userbot.session");
    const stateSession = path.join(stateDir, "telegram-user", "userbot.session");
    await fs.mkdir(path.dirname(machineSession), { recursive: true });
    await fs.mkdir(path.dirname(stateSession), { recursive: true });
    await fs.writeFile(machineSession, "fixture-machine\n");
    await fs.writeFile(stateSession, "fixture-state\n");

    // Import itself must remain safe even though process.env points at divergent
    // historical defaults. Explicit recovery selectors are resolved afterward.
    const { resolveTelegramUserBackendSelectors } = await import("./backend.js");
    await expect(
      resolveTelegramUserBackendSelectors({ session: "/tmp/separate-account.session" }),
    ).resolves.toEqual({
      envFilePath: path.join(stateDir, "telegram-user", ".env.local"),
      envFileSource: "runtime-default",
      sessionPath: "/tmp/separate-account.session",
    });
    await expect(resolveTelegramUserBackendSelectors({})).rejects.toThrow("E_AMBIGUOUS_SESSION");
  });

  it("keeps a monitor binding authoritative over a stale legacy session", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-binding-home-"));
    const stateDir = path.join(homeDir, "jarvis-state");
    const staleLegacySession = path.join(homeDir, ".openclaw", "telegram-user", "userbot.session");
    tempToolingRoots.push(homeDir);
    const boundEnvFile = path.join(stateDir, "configured.env");
    const boundSession = path.join(stateDir, "configured.session");
    await fs.mkdir(path.dirname(staleLegacySession), { recursive: true });
    await fs.writeFile(staleLegacySession, "needs-reauth-legacy-fixture\n");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(boundEnvFile, "TELEGRAM_API_ID=123\n");
    vi.stubEnv("HOME", homeDir);
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
      envFileSource: "monitor-binding",
      sessionPath: boundSession,
    });
    await expect(
      resolveTelegramUserBackendSelectors({
        envFile: path.join(stateDir, "explicit.env"),
        session: path.join(stateDir, "explicit.session"),
      }),
    ).resolves.toEqual({
      envFilePath: path.join(stateDir, "explicit.env"),
      envFileSource: "explicit",
      sessionPath: path.join(stateDir, "explicit.session"),
    });

    const explicitEnvFile = path.join(stateDir, "explicit-with-session.env");
    const envSelectedSession = path.join(stateDir, "env-selected.session");
    await fs.writeFile(explicitEnvFile, `USERBOT_SESSION=${envSelectedSession}\n`);
    await expect(
      resolveTelegramUserBackendSelectors({ envFile: explicitEnvFile }),
    ).resolves.toEqual({
      envFilePath: explicitEnvFile,
      envFileSource: "explicit",
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
      envFileSource: "monitor-binding",
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
      envFileSource: "runtime-default",
      sessionPath: path.join(homeDir, ".openclaw", "telegram-user", "userbot.session"),
    });
  });

  it("uses canonical consumer state for mutable Telegram tooling", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-consumer-home-"));
    tempToolingRoots.push(homeDir);
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_PROFILE", "consumer-lane");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(homeDir, "raw-profile-state"));

    const { resolveConsumerRuntimeIdentity } = await import("../consumer/runtime-identity.js");
    const identity = resolveConsumerRuntimeIdentity({ homeDir, instanceId: "lane" });
    const { getTelegramUserDefaults } = await import("./backend.js");

    expect(getTelegramUserDefaults()).toMatchObject({
      defaultEnvFilePath: path.join(identity.stateDir, "telegram-user", ".env.local"),
      defaultSessionPath: path.join(homeDir, ".openclaw", "telegram-user", "userbot.session"),
      telegramUserStateDir: path.join(identity.stateDir, "telegram-user"),
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
      envFileSource: "explicit",
      sessionPath: envSelectedSession,
    });
    await expect(
      resolveTelegramUserBackendSelectors({
        envFile: explicitEnvFile,
        session: path.join(stateDir, "flag.session"),
      }),
    ).resolves.toEqual({
      envFilePath: explicitEnvFile,
      envFileSource: "explicit",
      sessionPath: path.join(stateDir, "flag.session"),
    });
  });

  it("turns a killed backend send into an explicit unknown-delivery timeout", async () => {
    const { parseTelegramUserBackendExecError } = await import("./backend.js");
    const processError = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
      stderr: "",
    });

    const parsed = parseTelegramUserBackendExecError(processError, {
      command: "send",
      env: {} as NodeJS.ProcessEnv,
      meta: {
        api_hash_source: "missing",
        api_id_source: "missing",
        env_file: "/tmp/telegram.env",
        env_file_source: "explicit",
        lock_scope: "machine",
        session_path: "/tmp/telegram.session",
        session_source: "explicit",
      },
      timeoutMs: 60_000,
    });

    expect(parsed.message).toContain("E_BACKEND_TIMEOUT");
    expect(parsed.message).toContain("delivery state is unknown");
    expect(parsed.message).toContain("read the target chat before retrying");
  });

  it("treats every mutating backend timeout as indeterminate", async () => {
    const { parseTelegramUserBackendExecError } = await import("./backend.js");
    const processError = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
      stderr: "",
    });
    const meta = {
      api_hash_source: "missing" as const,
      api_id_source: "missing" as const,
      env_file: "/tmp/telegram.env",
      env_file_source: "explicit" as const,
      lock_scope: "machine" as const,
      session_path: "/tmp/telegram.session",
      session_source: "explicit" as const,
    };

    const topicCreate = parseTelegramUserBackendExecError(processError, {
      command: "topic-create",
      env: {} as NodeJS.ProcessEnv,
      meta,
      timeoutMs: 60_000,
    });
    const read = parseTelegramUserBackendExecError(processError, {
      command: "read",
      env: {} as NodeJS.ProcessEnv,
      meta,
      timeoutMs: 60_000,
    });

    expect(topicCreate.message).toContain("state is unknown");
    expect(topicCreate.message).toContain("Inspect current state before retrying");
    expect(read.message).toContain("may be retried");
  });
});
