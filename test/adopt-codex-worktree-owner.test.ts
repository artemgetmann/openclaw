import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (cwd: string, command: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();

const result = (cwd: string, command: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-adoption-owner-"));
  const remote = path.join(root, "remote.git");
  const home = path.join(root, "home");
  const detached = path.join(root, "codex-detached");

  run(root, "git", ["init", "--bare", remote]);
  run(root, "git", ["init", home, "--initial-branch=main"]);
  run(home, "git", ["config", "user.name", "Test User"]);
  run(home, "git", ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(home, "package.json"), '{"name":"fixture"}\n');
  run(home, "git", ["add", "package.json"]);
  run(home, "git", ["commit", "-m", "seed"]);
  run(home, "git", ["remote", "add", "origin", remote]);
  run(home, "git", ["push", "-u", "origin", "main"]);
  run(root, "git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  mkdirSync(path.join(home, "scripts", "lib"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "scripts", "adopt-codex-worktree.sh"),
    path.join(home, "scripts", "adopt-codex-worktree.sh"),
  );
  symlinkSync(
    path.join(process.cwd(), "scripts", "lib", "worktree-guards.sh"),
    path.join(home, "scripts", "lib", "worktree-guards.sh"),
  );
  writeFileSync(
    path.join(home, "scripts", "lib", "validated-node.sh"),
    '#!/usr/bin/env bash\nopenclaw_use_validated_node() { export OPENCLAW_NODE_BIN="$(command -v node)"; }\n',
  );
  for (const script of [
    "bootstrap-worktree-telegram.sh",
    "bootstrap-worktree-tester-baseline.sh",
    "bootstrap-worktree-runtime.sh",
    "worktree-doctor.sh",
    "worktree-ready-check.sh",
  ]) {
    let body = "#!/usr/bin/env bash\nset -euo pipefail\n";
    if (script === "bootstrap-worktree-telegram.sh") {
      body += 'touch "$PWD/bootstrap-effect"\n';
    } else if (script === "bootstrap-worktree-tester-baseline.sh") {
      body +=
        'if [[ -n "${TEST_BASELINE_ENV_LOG:-}" ]]; then printf \'%s\\n%s\\n\' "${OPENCLAW_WORKTREE_BASELINE_SOURCE_CONFIG_PATH:-}" "${OPENCLAW_WORKTREE_BASELINE_SOURCE_STATE_DIR:-}" > "$TEST_BASELINE_ENV_LOG"; fi\n' +
        "printf 'baseline_state_dir=/tmp/fixture-state\\nbaseline_config_path=/tmp/fixture-config\\n'\n";
    } else if (script === "worktree-ready-check.sh") {
      body += "printf 'lane_ready=yes\\n'\n";
    }
    writeFileSync(path.join(home, "scripts", script), body, { mode: 0o755 });
  }
  writeFileSync(
    path.join(home, "scripts", "with-heavy-local-slot.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
wait_seconds=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) shift 2 ;;
    --wait-seconds) wait_seconds="$2"; shift 2 ;;
    --) shift; break ;;
    *) exit 2 ;;
  esac
done
printf '%s\\n' "$wait_seconds" > "$PWD/capacity-wait-seconds"
exec "$@"
`,
    { mode: 0o755 },
  );
  run(home, "git", ["add", "."]);
  run(home, "git", ["commit", "-m", "fixture scripts"]);
  run(home, "git", ["push", "origin", "main"]);
  run(root, "git", ["--git-dir", remote, "fetch", home, "main:main"]);
  run(home, "git", ["worktree", "add", "--detach", detached, "HEAD"]);
  return { root, home, detached };
};

const adopt = (
  home: string,
  detached: string,
  name: string,
  thread = "thread-fixture",
  env?: NodeJS.ProcessEnv,
  extraArgs: string[] = [],
) =>
  result(
    detached,
    "bash",
    [
      path.join(detached, "scripts", "adopt-codex-worktree.sh"),
      name,
      "--root",
      detached,
      "--no-home-refresh",
      "--thread-id",
      thread,
      ...extraArgs,
    ],
    { OPENCLAW_MAIN_HOME_CLONE: home, ...env },
  );

describe("Codex worktree adoption ownership", () => {
  it("adopts one detached worktree and emits one exact owner receipt", () => {
    const { home, detached } = fixture();
    const canonicalDetached = realpathSync(detached);
    const adopted = adopt(home, detached, "single-owner");

    expect(adopted.status).toBe(0);
    expect(adopted.stdout).toContain(
      `adoption_owner_receipt=thread:thread-fixture worktree:${canonicalDetached} branch:codex/single-owner`,
    );
    expect(run(detached, "git", ["branch", "--show-current"])).toBe("codex/single-owner");
    expect(existsSync(path.join(detached, "bootstrap-effect"))).toBe(true);
  });

  it("adopts a source-only tester without reading credential baselines", () => {
    const { home, detached } = fixture();
    const baselineLog = path.join(detached, "baseline-env.log");
    const adopted = adopt(
      home,
      detached,
      "credential-free",
      "tester-thread",
      { TEST_BASELINE_ENV_LOG: baselineLog },
      ["--credential-mode", "none"],
    );

    expect(adopted.status).toBe(0);
    expect(adopted.stdout).toContain("credential_mode=none");
    expect(adopted.stdout).toContain("telegram_bootstrap=skipped-no-credentials");
    expect(existsSync(path.join(detached, "bootstrap-effect"))).toBe(false);
    const [configSource, stateSource] = run(detached, "sed", ["-n", "1,2p", baselineLog]).split(
      "\n",
    );
    expect(configSource).toContain(".local/no-credential-baseline-source/openclaw.json");
    expect(stateSource).toContain(".local/no-credential-baseline-source");
  });

  it("uses one bounded lease-free wait for source-only tester bootstrap", () => {
    const { home, detached } = fixture();
    const adopted = adopt(home, detached, "bounded-wait", "tester-thread", undefined, [
      "--credential-mode",
      "none",
      "--capacity-wait-seconds",
      "86400",
    ]);

    expect(adopted.status).toBe(0);
    expect(run(detached, "sed", ["-n", "1p", "capacity-wait-seconds"])).toBe("86400");
  });

  it("fails before bootstrap when the intended branch is attached elsewhere", () => {
    const { root, home, detached } = fixture();
    const owner = path.join(root, "existing-owner");
    run(home, "git", ["worktree", "add", "-b", "codex/conflict", owner, "HEAD"]);
    const canonicalDetached = realpathSync(detached);
    const canonicalOwner = realpathSync(owner);

    const blocked = adopt(home, detached, "conflict", "thread-fixture", {
      TEST_SECRET_SENTINEL: "must-not-appear",
    });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain(`Requested worktree: ${canonicalDetached}`);
    expect(blocked.stderr).toContain(`  ${canonicalOwner}`);
    expect(blocked.stderr).toContain("No branch was created, switched, or stolen");
    expect(`${blocked.stdout}\n${blocked.stderr}`).not.toContain("must-not-appear");
    expect(existsSync(path.join(detached, "bootstrap-effect"))).toBe(false);
    expect(run(detached, "git", ["branch", "--show-current"])).toBe("");
  });

  it("attaches a same-name unattached branch only when it matches the detached head", () => {
    const { home, detached } = fixture();
    run(home, "git", ["branch", "codex/recovered", "HEAD"]);

    const adopted = adopt(home, detached, "recovered");
    expect(adopted.status).toBe(0);
    expect(run(detached, "git", ["branch", "--show-current"])).toBe("codex/recovered");
  });

  it("does not switch or reset an unattached branch at a different commit", () => {
    const { home, detached } = fixture();
    run(home, "git", ["branch", "codex/mismatched", "HEAD~1"]);

    const blocked = adopt(home, detached, "mismatched");
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("unattached lane branch does not match");
    expect(blocked.stderr).toContain("No branch was switched or reset");
    expect(run(detached, "git", ["branch", "--show-current"])).toBe("");
  });

  it("preserves dirty, stale, and sacred-home fail-closed protections", () => {
    const dirtyFixture = fixture();
    writeFileSync(path.join(dirtyFixture.detached, "dirty.txt"), "dirty\n");
    expect(adopt(dirtyFixture.home, dirtyFixture.detached, "dirty").stderr).toContain(
      "worktree has local changes",
    );

    const staleFixture = fixture();
    writeFileSync(path.join(staleFixture.home, "later.txt"), "later\n");
    run(staleFixture.home, "git", ["add", "later.txt"]);
    run(staleFixture.home, "git", ["commit", "-m", "advance"]);
    run(staleFixture.home, "git", ["push", "origin", "main"]);
    expect(adopt(staleFixture.home, staleFixture.detached, "stale").stderr).toContain(
      "detached HEAD is not origin/main",
    );

    const sacredFixture = fixture();
    const sacred = result(
      sacredFixture.home,
      "bash",
      [
        path.join(sacredFixture.home, "scripts", "adopt-codex-worktree.sh"),
        "sacred",
        "--root",
        sacredFixture.home,
        "--no-home-refresh",
      ],
      { OPENCLAW_MAIN_HOME_CLONE: sacredFixture.home },
    );
    expect(sacred.status).not.toBe(0);
    expect(sacred.stderr).toContain("checkout is not a linked git worktree");
  });
});
