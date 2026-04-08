import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();

const runResult = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });

const initRemoteClone = (prefix: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const remoteDir = path.join(root, "remote.git");
  const seedDir = path.join(root, "seed");
  const cloneDir = path.join(root, "clone");

  run(root, "git", ["init", "--bare", remoteDir]);
  run(root, "git", ["init", seedDir, "--initial-branch=main"]);
  run(seedDir, "git", ["config", "user.name", "Test User"]);
  run(seedDir, "git", ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(seedDir, "README.md"), "seed\n");
  run(seedDir, "git", ["add", "README.md"]);
  run(seedDir, "git", ["commit", "-m", "seed"]);
  run(seedDir, "git", ["remote", "add", "origin", remoteDir]);
  run(seedDir, "git", ["push", "-u", "origin", "main"]);
  run(root, "git", ["clone", remoteDir, cloneDir]);
  return cloneDir;
};

describe("home-clone task wrappers", () => {
  it("refuses to hand off a lane unless the child script proves readiness", () => {
    const cloneDir = initRemoteClone("openclaw-home-clone-helpers-");
    mkdirSync(path.join(cloneDir, "scripts", "shell-helpers"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "scripts", "shell-helpers", "home-clone-helpers.sh"),
      path.join(cloneDir, "scripts", "shell-helpers", "home-clone-helpers.sh"),
    );
    mkdirSync(path.join(cloneDir, ".worktrees", "fake-lane"), { recursive: true });
    writeFileSync(
      path.join(cloneDir, "scripts", "new-worktree.sh"),
      `#!/usr/bin/env bash
printf 'worktree=%s/.worktrees/fake-lane\\n' "$PWD"
printf 'lane_ready=no\\n'
`,
      { encoding: "utf8", mode: 0o755 },
    );
    run(cloneDir, "git", ["config", "user.name", "Test User"]);
    run(cloneDir, "git", ["config", "user.email", "test@example.com"]);
    run(cloneDir, "git", ["add", "."]);
    run(cloneDir, "git", ["commit", "-m", "fixture"]);
    run(cloneDir, "git", ["push", "origin", "main"]);

    const result = runResult(
      cloneDir,
      "bash",
      [
        "-lc",
        'unset OPENCLAW_HOME_CLONE_HELPERS_LOADED; source "$PWD/scripts/shell-helpers/home-clone-helpers.sh"; oc-main-task fake-lane',
      ],
      { OPENCLAW_MAIN_HOME_CLONE: cloneDir },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/did not prove lane readiness/);
  });
});
