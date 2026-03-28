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

  it("blocks the canonical shared main checkout when it owns ai.openclaw.gateway", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-commit-main-guard-"));
    const home = path.join(dir, "home");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "scripts", "lib", "worktree-guards.sh"),
      path.join(dir, "scripts", "lib", "worktree-guards.sh"),
    );
    writeFileSync(path.join(dir, "dist", "index.js"), "console.log('gateway');\n", "utf8");
    writeFileSync(
      path.join(home, "Library", "LaunchAgents", "ai.openclaw.gateway.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>${path.join(dir, "dist", "index.js")}</string>
    <string>gateway</string>
  </array>
</dict>
</plist>
`,
      "utf8",
    );
    expect(() =>
      run(
        dir,
        "/bin/bash",
        [
          "-c",
          'source "$PWD/scripts/lib/worktree-guards.sh"; worktree_guard_forbid_shared_root_main_commits "$PWD"',
        ],
        {
          HOME: home,
        },
      ),
    ).toThrow(/canonical shared main checkout/);
  });
});
