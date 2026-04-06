import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const baseRunEnv: NodeJS.ProcessEnv = { ...process.env, ...baseGitEnv };

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...baseRunEnv, ...env } : baseRunEnv,
  }).trim();
};

describe("git-hooks/pre-commit (integration)", () => {
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-commit-"));
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    run(dir, "git", ["checkout", "-qb", "codex/test-pre-commit"]);

    // Use the real hook script and lightweight helper stubs.
    mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
    mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
    mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "git-hooks", "pre-commit"),
      path.join(dir, "git-hooks", "pre-commit"),
    );
    symlinkSync(
      path.join(process.cwd(), "scripts", "lib", "worktree-guards.sh"),
      path.join(dir, "scripts", "lib", "worktree-guards.sh"),
    );
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
      {
        encoding: "utf8",
        mode: 0o755,
      },
    );
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
      "process.exit(0);\n",
      "utf8",
    );
    const fakeBinDir = path.join(dir, "bin");
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(path.join(fakeBinDir, "node"), "#!/usr/bin/env bash\nexit 0\n", {
      encoding: "utf8",
      mode: 0o755,
    });

    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toEqual(["--all"]);
  });

  it("blocks direct commits on protected base branches", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-commit-main-guard-"));
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    run(dir, "git", ["config", "user.name", "Test User"]);
    run(dir, "git", ["config", "user.email", "test@example.com"]);

    mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "scripts", "lib", "worktree-guards.sh"),
      path.join(dir, "scripts", "lib", "worktree-guards.sh"),
    );
    expect(() =>
      run(dir, "/bin/bash", [
        "-c",
        'source "$PWD/scripts/lib/worktree-guards.sh"; worktree_guard_forbid_protected_base_branch_commit "$PWD"',
      ]),
    ).toThrow(/protected base branch 'main'/);

    run(dir, "git", ["checkout", "-qb", "codex/consumer-openclaw-project"]);

    expect(() =>
      run(dir, "/bin/bash", [
        "-c",
        'source "$PWD/scripts/lib/worktree-guards.sh"; worktree_guard_forbid_protected_base_branch_commit "$PWD"',
      ]),
    ).toThrow(/protected base branch 'codex\/consumer-openclaw-project'/);
  });

  it("allows protected base branch commits only with an explicit override", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-protected-branch-override-"));
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "scripts", "lib", "worktree-guards.sh"),
      path.join(dir, "scripts", "lib", "worktree-guards.sh"),
    );

    expect(
      run(
        dir,
        "/bin/bash",
        [
          "-c",
          'source "$PWD/scripts/lib/worktree-guards.sh"; worktree_guard_forbid_protected_base_branch_commit "$PWD"',
        ],
        {
          OPENCLAW_ALLOW_PROTECTED_BRANCH_COMMITS: "1",
        },
      ),
    ).toBe("");
  });

  it("blocks stale durable consumer lanes that are behind origin", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-consumer-guard-"));
    const remoteDir = path.join(dir, "remote.git");
    const seedDir = path.join(dir, "seed");
    const cloneDir = path.join(dir, "clone");
    const advanceDir = path.join(dir, "advance");
    const worktreeDir = path.join(cloneDir, ".worktrees", "consumer-durable");

    run(dir, "git", ["init", "--bare", remoteDir]);

    mkdirSync(seedDir, { recursive: true });
    run(seedDir, "git", ["init", "-q", "--initial-branch=main"]);
    run(seedDir, "git", ["config", "user.name", "Test User"]);
    run(seedDir, "git", ["config", "user.email", "test@example.com"]);
    writeFileSync(path.join(seedDir, "README.md"), "seed\n", "utf8");
    run(seedDir, "git", ["add", "README.md"]);
    run(seedDir, "git", ["commit", "-qm", "seed main"]);
    run(seedDir, "git", ["remote", "add", "origin", remoteDir]);
    run(seedDir, "git", ["push", "-u", "origin", "main"]);
    run(seedDir, "git", ["checkout", "-qb", "codex/consumer-openclaw-project"]);
    writeFileSync(path.join(seedDir, "consumer.txt"), "v1\n", "utf8");
    run(seedDir, "git", ["add", "consumer.txt"]);
    run(seedDir, "git", ["commit", "-qm", "seed consumer"]);
    run(seedDir, "git", ["push", "-u", "origin", "codex/consumer-openclaw-project"]);

    run(dir, "git", ["clone", "-q", remoteDir, cloneDir]);
    run(cloneDir, "git", ["config", "user.name", "Test User"]);
    run(cloneDir, "git", ["config", "user.email", "test@example.com"]);
    run(cloneDir, "git", [
      "branch",
      "--track",
      "codex/consumer-openclaw-project",
      "origin/codex/consumer-openclaw-project",
    ]);
    run(cloneDir, "git", ["worktree", "add", worktreeDir, "codex/consumer-openclaw-project"]);

    run(dir, "git", ["clone", "-q", remoteDir, advanceDir]);
    run(advanceDir, "git", ["config", "user.name", "Test User"]);
    run(advanceDir, "git", ["config", "user.email", "test@example.com"]);
    run(advanceDir, "git", ["checkout", "-q", "codex/consumer-openclaw-project"]);
    writeFileSync(path.join(advanceDir, "consumer.txt"), "v2\n", "utf8");
    run(advanceDir, "git", ["commit", "-am", "advance consumer", "-q"]);
    run(advanceDir, "git", ["push", "-q", "origin", "codex/consumer-openclaw-project"]);

    run(worktreeDir, "git", ["fetch", "-q", "origin", "codex/consumer-openclaw-project"]);

    expect(() =>
      run(worktreeDir, "/bin/bash", [
        "-c",
        `source "${path.join(process.cwd(), "scripts", "lib", "worktree-guards.sh")}"; worktree_guard_forbid_stale_durable_lane_commit "$PWD"`,
      ]),
    ).toThrow(/stale durable lane/);
  });
});
