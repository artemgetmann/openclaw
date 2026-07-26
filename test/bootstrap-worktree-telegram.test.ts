import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runResult = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });

function writeSessionFixture(sessionPath: string, authKey: string, marker: string): void {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import sqlite3,sys",
        "connection=sqlite3.connect(sys.argv[1])",
        "connection.execute('CREATE TABLE sessions (dc_id INTEGER PRIMARY KEY, auth_key BLOB)')",
        "connection.execute('INSERT INTO sessions (dc_id, auth_key) VALUES (?, ?)', (2, sys.argv[2].encode()))",
        "connection.execute('CREATE TABLE fixture_metadata (marker TEXT)')",
        "connection.execute('INSERT INTO fixture_metadata (marker) VALUES (?)', (sys.argv[3],))",
        "connection.commit()",
        "connection.close()",
      ].join(";"),
      sessionPath,
      authKey,
      marker,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`failed to create session fixture: ${result.stderr}`);
  }
}

const initFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-telegram-"));
  const home = path.join(root, "home");
  const mainRepo = path.join(root, "main");
  const worktree = path.join(root, "worktree");

  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(mainRepo, "scripts", "telegram-e2e", "tmp"), { recursive: true });
  mkdirSync(path.join(worktree, "scripts"), { recursive: true });

  writeFileSync(path.join(mainRepo, ".env.bots"), "BOT_TOKEN=111:exhausted\n");
  writeFileSync(path.join(mainRepo, "scripts", "telegram-e2e", ".env"), "TG_ENV=canonical\n");
  writeFileSync(
    path.join(mainRepo, "scripts", "telegram-e2e", ".env.local"),
    "TG_LOCAL=canonical-local\n",
  );
  writeFileSync(
    path.join(mainRepo, "scripts", "telegram-e2e", "tmp", "userbot.session"),
    "session-bytes\n",
  );

  symlinkSync(
    path.join(process.cwd(), "scripts", "bootstrap-worktree-telegram.sh"),
    path.join(worktree, "scripts", "bootstrap-worktree-telegram.sh"),
  );
  mkdirSync(path.join(worktree, "scripts", "telegram-e2e"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "scripts", "telegram-e2e", "session_owner.py"),
    path.join(worktree, "scripts", "telegram-e2e", "session_owner.py"),
  );
  writeFileSync(
    path.join(worktree, "scripts", "assign-bot.sh"),
    `#!/usr/bin/env bash
echo "Error: no eligible tester bot tokens available." >&2
exit 1
`,
    { encoding: "utf8", mode: 0o755 },
  );

  return { home, mainRepo, worktree };
};

describe("bootstrap-worktree-telegram", () => {
  it("copies canonical Telegram assets without claiming a tester bot in copy-only mode", () => {
    const { home, mainRepo, worktree } = initFixture();

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--copy-only"],
      { HOME: home, OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("telegram bootstrap complete");
    expect(result.stdout).toContain("telegram_session_source=main-canonical-legacy");
    expect(result.stdout).toContain("telegram_session_migration=adopted");
    expect(result.stdout).toContain("telegram_lock_scope=machine");
    expect(readFileSync(path.join(worktree, ".env.bots"), "utf8")).toContain(
      "BOT_TOKEN=111:exhausted",
    );
    expect(readFileSync(path.join(worktree, "scripts", "telegram-e2e", ".env.local"), "utf8")).toBe(
      "TG_LOCAL=canonical-local\n",
    );
    expect(
      existsSync(path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session")),
    ).toBe(false);
    expect(
      readFileSync(
        path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session.path"),
        "utf8",
      ),
    ).toBe(
      `${path.join(realpathSync(mainRepo), "scripts", "telegram-e2e", "tmp", "userbot.session")}\n`,
    );
    expect(existsSync(path.join(worktree, ".env.local"))).toBe(false);
  });

  it("copies canonical Telegram assets before an optional exhausted-pool claim failure", () => {
    const { home, mainRepo, worktree } = initFixture();

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--optional"],
      { HOME: home, OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("telegram_session_source=main-canonical-legacy");
    expect(result.stdout).toContain("telegram_lock_scope=machine");
    expect(result.stdout).toContain("telegram bootstrap complete");
    expect(result.stderr).toContain("warning: telegram tester claim deferred; pool exhausted");
    expect(readFileSync(path.join(worktree, ".env.bots"), "utf8")).toContain(
      "BOT_TOKEN=111:exhausted",
    );
    expect(readFileSync(path.join(worktree, "scripts", "telegram-e2e", ".env"), "utf8")).toBe(
      "TG_ENV=canonical\n",
    );
    expect(readFileSync(path.join(worktree, "scripts", "telegram-e2e", ".env.local"), "utf8")).toBe(
      "TG_LOCAL=canonical-local\n",
    );
    expect(
      existsSync(path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session")),
    ).toBe(false);
  });

  it("still copies canonical Telegram assets before surfacing a strict exhausted-pool failure", () => {
    const { home, mainRepo, worktree } = initFixture();

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--strict"],
      { HOME: home, OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Error: no eligible tester bot tokens available.");
    expect(readFileSync(path.join(worktree, "scripts", "telegram-e2e", ".env.local"), "utf8")).toBe(
      "TG_LOCAL=canonical-local\n",
    );
    expect(
      existsSync(path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session")),
    ).toBe(false);
  });

  it("fails closed when machine and legacy implicit session owners diverge", () => {
    const { home, mainRepo, worktree } = initFixture();
    mkdirSync(path.join(home, ".openclaw", "telegram-user"), { recursive: true });
    writeFileSync(
      path.join(home, ".openclaw", "telegram-user", "userbot.session"),
      "other-session-bytes\n",
    );

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--copy-only"],
      { HOME: home, OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("E_AMBIGUOUS_SESSION");
    expect(result.stderr).toContain("machine,main-canonical-legacy");
    expect(result.stderr).toContain("owner claim --source machine");
    expect(result.stderr).toContain("owner claim --source main-canonical-legacy");
    expect(result.stderr).not.toContain("session-bytes");
  });

  it("collapses identical machine and legacy copies into one durable owner", () => {
    const { home, mainRepo, worktree } = initFixture();
    const machineSession = path.join(home, ".openclaw", "telegram-user", "userbot.session");
    const mainSession = path.join(mainRepo, "scripts", "telegram-e2e", "tmp", "userbot.session");
    mkdirSync(path.dirname(machineSession), { recursive: true });
    writeFileSync(mainSession, "");
    writeSessionFixture(mainSession, "same-auth-key", "main-copy");
    writeSessionFixture(machineSession, "same-auth-key", "machine-copy");

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--copy-only"],
      { HOME: home, OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("telegram_session_source=machine");
    expect(result.stdout).toContain("telegram_session_migration=duplicates-collapsed");
    expect(
      readFileSync(path.join(home, ".openclaw", "telegram-user", "canonical-session.path"), "utf8"),
    ).toBe(`${realpathSync(machineSession)}\n`);
  });

  it("keeps a lane-local legacy session discoverable as a migration input", () => {
    const { home, mainRepo, worktree } = initFixture();
    const mainSession = path.join(mainRepo, "scripts", "telegram-e2e", "tmp", "userbot.session");
    const laneSession = path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session");
    unlinkSync(mainSession);
    mkdirSync(path.dirname(laneSession), { recursive: true });
    writeSessionFixture(laneSession, "lane-auth-key", "legacy-worktree");

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--copy-only"],
      { HOME: home, OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("telegram_session_source=lane-legacy");
    expect(
      readFileSync(path.join(home, ".openclaw", "telegram-user", "canonical-session.path"), "utf8"),
    ).toBe(`${realpathSync(laneSession)}\n`);
  });

  it("reports the known Jarvis app-support session as an implicit divergent owner", () => {
    const { home, mainRepo, worktree } = initFixture();
    const jarvisSession = path.join(
      home,
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "telegram-user",
      "userbot.session",
    );
    mkdirSync(path.dirname(jarvisSession), { recursive: true });
    writeFileSync(jarvisSession, "jarvis-session-bytes\n");

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--copy-only"],
      { HOME: home, OPENCLAW_MAIN_REPO: mainRepo },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("E_AMBIGUOUS_SESSION");
    expect(result.stderr).toContain("jarvis-state-legacy,main-canonical-legacy");
    expect(result.stderr).not.toContain("jarvis-session-bytes");
  });

  it("allows an explicit machine session owner without copying its database", () => {
    const { home, mainRepo, worktree } = initFixture();
    const explicitSession = path.join(path.dirname(mainRepo), "separate-account.session");

    const result = runResult(
      worktree,
      "bash",
      ["scripts/bootstrap-worktree-telegram.sh", "--copy-only"],
      {
        OPENCLAW_MAIN_REPO: mainRepo,
        OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION: explicitSession,
        HOME: home,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("telegram_session_source=explicit-canonical");
    expect(result.stdout).toContain("telegram_lock_scope=machine");
    expect(
      readFileSync(
        path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session.path"),
        "utf8",
      ),
    ).toBe(`${explicitSession}\n`);
    expect(
      readFileSync(
        path.join(worktree, "scripts", "telegram-e2e", "tmp", "userbot.session.scope"),
        "utf8",
      ),
    ).toBe("explicit-canonical\n");
    expect(existsSync(explicitSession)).toBe(false);
  });
});
