import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DEPLOY_SCRIPT = path.join(ROOT, "scripts", "deploy-shared-main-runtime.sh");
const PROVE_SCRIPT = path.join(ROOT, "scripts", "prove-main-telegram-runtime.sh");

function runBash(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execFileSync("bash", ["-lc", command], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeTempDir(slug: string) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${slug}-`)));
}

function makeGitRepo(branch = "main") {
  const repo = makeTempDir("shared-main-repo");
  runBash("git init -q && git checkout -q -b main", { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  runBash(
    "git add tracked.txt && git -c user.name=test -c user.email=test@example.com commit -q -m init",
    {
      cwd: repo,
    },
  );
  if (branch !== "main") {
    runBash(`git checkout -q -b ${branch}`, { cwd: repo });
  }
  return repo;
}

function sourceDeployAndRun(functionCall: string, repo: string) {
  return runBash(`source "${DEPLOY_SCRIPT}"; ${functionCall}`, {
    cwd: repo,
    env: {
      OPENCLAW_SCRIPT_LIB_TEST: "1",
      OPENCLAW_SHARED_MAIN_TEST_MODE: "1",
      OPENCLAW_MAIN_REPO: repo,
      OPENCLAW_EXPECTED_MAIN_REPO: repo,
    },
  });
}

describe("scripts/deploy-shared-main-runtime.sh guards", () => {
  it("accepts a clean sacred main checkout", () => {
    const repo = makeGitRepo("main");

    expect(() => sourceDeployAndRun("require_sacred_main_checkout", repo)).not.toThrow();
  });

  it("refuses tracked dirt while ignoring untracked files", () => {
    const repo = makeGitRepo("main");
    fs.mkdirSync(path.join(repo, "checkpoints"));
    fs.writeFileSync(path.join(repo, "checkpoints", "note.md"), "untracked is allowed\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");

    expect(() => sourceDeployAndRun("require_sacred_main_checkout", repo)).toThrow(
      /refusing tracked dirt/,
    );
  });

  it("refuses a non-main branch", () => {
    const repo = makeGitRepo("feature-test");

    expect(() => sourceDeployAndRun("require_sacred_main_checkout", repo)).toThrow(/expected main/);
  });
});

function sourceProveAndRun(functionCall: string, env: NodeJS.ProcessEnv) {
  return runBash(`source "${PROVE_SCRIPT}"; ${functionCall}`, {
    env: {
      OPENCLAW_SCRIPT_LIB_TEST: "1",
      ...env,
    },
  });
}

describe("scripts/prove-main-telegram-runtime.sh parsing", () => {
  it("runs telegram-user JSON commands through silent pnpm", () => {
    const script = fs.readFileSync(PROVE_SCRIPT, "utf8");

    expect(script).toContain('pnpm --silent openclaw:local "$@" --json');
    expect(script).toContain("pnpm --silent openclaw:local telegram-user wait");
  });

  it("chooses the recent active [default] bot from logs", () => {
    const temp = makeTempDir("telegram-proof");
    const logPath = path.join(temp, "gateway.log");
    fs.writeFileSync(
      logPath,
      [
        "2026-06-05T19:00:00+08:00 [telegram] [coder] polling @Artem_jarvis_email_bot",
        "2026-06-05T19:27:43+08:00 [telegram] [default] polling @Jarvis_cl4w_bot",
        "",
      ].join("\n"),
    );

    const output = sourceProveAndRun("extract_default_provider_from_logs", {
      OPENCLAW_GATEWAY_LOG: logPath,
      OPENCLAW_GATEWAY_ERR_LOG: path.join(temp, "missing.err.log"),
    });

    expect(output.trim()).toBe("@Jarvis_cl4w_bot");
  });

  it("ignores stale smoke artifacts when resolving the active bot", () => {
    const temp = makeTempDir("telegram-artifacts");
    fs.mkdirSync(path.join(temp, ".artifacts", "telegram-smoke"), { recursive: true });
    fs.writeFileSync(
      path.join(temp, ".artifacts", "telegram-smoke", "last.txt"),
      "@Artem_jarvis_email_bot\n",
    );
    const logPath = path.join(temp, "gateway.log");
    fs.writeFileSync(logPath, "2026-06-05T19:27:43+08:00 [telegram] [default] @Jarvis_cl4w_bot\n");

    const output = sourceProveAndRun("resolve_active_bot", {
      OPENCLAW_GATEWAY_LOG: logPath,
      OPENCLAW_GATEWAY_ERR_LOG: path.join(temp, "missing.err.log"),
      OPENCLAW_CONFIG_PATH: path.join(temp, "missing.json"),
    });

    expect(JSON.parse(output)).toEqual({ username: "@Jarvis_cl4w_bot", id: "" });
  });

  it("fails when a polling stall appears after the deploy timestamp", () => {
    const temp = makeTempDir("telegram-stall");
    const errPath = path.join(temp, "gateway.err.log");
    fs.writeFileSync(
      errPath,
      [
        "2026-06-05T19:20:00+08:00 [telegram] Polling stall detected before deploy",
        "2026-06-05T19:31:00+08:00 [telegram] Polling stall detected after deploy",
        "",
      ].join("\n"),
    );

    expect(() =>
      sourceProveAndRun('scan_logs_after_since "2026-06-05T19:30:00"', {
        OPENCLAW_GATEWAY_ERR_LOG: errPath,
        OPENCLAW_GATEWAY_LOG: path.join(temp, "missing.log"),
      }),
    ).toThrow(/Polling stall detected after deploy/);
  });

  it("passes when stall lines are only before the deploy timestamp", () => {
    const temp = makeTempDir("telegram-no-stall");
    const errPath = path.join(temp, "gateway.err.log");
    fs.writeFileSync(
      errPath,
      [
        "2026-06-05T19:20:00+08:00 [telegram] Polling stall detected before deploy",
        "2026-06-05T19:31:00+08:00 [telegram] polling healthy",
        "",
      ].join("\n"),
    );

    expect(() =>
      sourceProveAndRun('scan_logs_after_since "2026-06-05T19:30:00"', {
        OPENCLAW_GATEWAY_ERR_LOG: errPath,
        OPENCLAW_GATEWAY_LOG: path.join(temp, "missing.log"),
      }),
    ).not.toThrow();
  });
});
