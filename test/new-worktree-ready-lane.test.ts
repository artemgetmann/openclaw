import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();

const initRemoteClone = (prefix: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const remoteDir = path.join(root, "remote.git");
  const seedDir = path.join(root, "seed");
  const cloneDir = path.join(root, "clone");

  run(root, "git", ["init", "--bare", remoteDir]);
  run(root, "git", ["init", seedDir, "--initial-branch=main"]);
  run(seedDir, "git", ["config", "user.name", "Test User"]);
  run(seedDir, "git", ["config", "user.email", "test@example.com"]);
  writeFileSync(
    path.join(seedDir, "package.json"),
    '{"name":"fixture","packageManager":"pnpm@10.23.0"}\n',
  );
  run(seedDir, "git", ["add", "package.json"]);
  run(seedDir, "git", ["commit", "-m", "seed"]);
  run(seedDir, "git", ["remote", "add", "origin", remoteDir]);
  run(seedDir, "git", ["push", "-u", "origin", "main"]);
  run(root, "git", ["clone", remoteDir, cloneDir]);
  run(cloneDir, "git", ["config", "user.name", "Test User"]);
  run(cloneDir, "git", ["config", "user.email", "test@example.com"]);
  return { root, cloneDir };
};

const installNewWorktreeFixture = (cloneDir: string) => {
  mkdirSync(path.join(cloneDir, "scripts", "lib"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "scripts", "new-worktree.sh"),
    path.join(cloneDir, "scripts", "new-worktree.sh"),
  );
  symlinkSync(
    path.join(process.cwd(), "scripts", "lib", "worktree-guards.sh"),
    path.join(cloneDir, "scripts", "lib", "worktree-guards.sh"),
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "lib", "validated-node.sh"),
    `#!/usr/bin/env bash
openclaw_use_validated_node() {
  export OPENCLAW_NODE_BIN="$(command -v node)"
  export OPENCLAW_VALIDATED_NODE_BIN="$OPENCLAW_NODE_BIN"
  return 0
}
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "bootstrap-worktree-telegram.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "telegram-live-runtime.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "worktree-doctor.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "bootstrap-worktree-runtime.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
ROOT=""
SKIP_BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --quiet) shift ;;
    *) shift ;;
  esac
done
if [[ "\${STUB_BOOTSTRAP_MODE:-ok}" == "fail" ]]; then
  exit 1
fi
mkdir -p "$ROOT/node_modules/.bin"
cat > "$ROOT/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
echo 4.1.0
EOF
chmod 755 "$ROOT/node_modules/.bin/vitest"
if [[ "$SKIP_BUILD" != "1" ]]; then
  mkdir -p "$ROOT/dist"
  printf 'export {}\\n' > "$ROOT/dist/index.js"
fi
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "worktree-ready-check.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
ROOT=""
MODE="clean"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    *) shift ;;
  esac
done
test -x "$ROOT/node_modules/.bin/vitest"
if [[ "$MODE" == "clean" ]]; then
  test -f "$ROOT/dist/index.js"
fi
printf 'ready_root=%s\\n' "$ROOT"
printf 'ready_mode=%s\\n' "$MODE"
printf 'ready_vitest=4.1.0\\n'
printf 'ready_proof=pnpm exec vitest --version\\n'
printf 'lane_ready=yes\\n'
`,
    { encoding: "utf8", mode: 0o755 },
  );
};

const commitFixture = (cloneDir: string, message: string) => {
  run(cloneDir, "git", ["add", "."]);
  run(cloneDir, "git", ["commit", "-m", message]);
  run(cloneDir, "git", ["push", "origin", "main"]);
};

describe("scripts/new-worktree.sh readiness gating", () => {
  it("prints a ready lane proof before handing back a clean lane", () => {
    const { cloneDir } = initRemoteClone("openclaw-new-worktree-ok-");
    installNewWorktreeFixture(cloneDir);
    commitFixture(cloneDir, "fixture");

    const output = run(
      cloneDir,
      "bash",
      ["scripts/new-worktree.sh", "ready-lane", "--base", "main"],
      { OPENCLAW_MAIN_HOME_CLONE: cloneDir },
    );

    expect(output).toContain("bootstrap_runtime=ok");
    expect(output).toContain("lane_ready=yes");
    expect(output).toContain("ready_proof=pnpm exec vitest --version");
    expect(output).toContain("worktree=");
  });

  it("keeps warm lanes readiness-gated while skipping the build", () => {
    const { cloneDir } = initRemoteClone("openclaw-new-worktree-warm-");
    installNewWorktreeFixture(cloneDir);
    commitFixture(cloneDir, "fixture");

    const output = run(
      cloneDir,
      "bash",
      ["scripts/new-worktree.sh", "warm-lane", "--base", "main", "--mode", "warm"],
      { OPENCLAW_MAIN_HOME_CLONE: cloneDir },
    );

    const worktreePath = output.match(/^worktree=(.+)$/m)?.[1];
    expect(output).toContain("lane_mode=warm");
    expect(output).toContain("bootstrap_runtime=dependencies-only");
    expect(output).toContain("lane_ready=yes");
    expect(worktreePath).toBeTruthy();
    expect(readFileSync(path.join(worktreePath!, ".dev-launch.env"), "utf8")).toContain(
      "OPENCLAW_GATEWAY_PORT=",
    );
    expect(() => readFileSync(path.join(worktreePath!, "dist", "index.js"), "utf8")).toThrow();
  });

  it("fails closed when bootstrap cannot prove readiness", () => {
    const { cloneDir } = initRemoteClone("openclaw-new-worktree-fail-");
    installNewWorktreeFixture(cloneDir);
    commitFixture(cloneDir, "fixture");

    expect(() =>
      run(cloneDir, "bash", ["scripts/new-worktree.sh", "broken-lane", "--base", "main"], {
        OPENCLAW_MAIN_HOME_CLONE: cloneDir,
        STUB_BOOTSTRAP_MODE: "fail",
      }),
    ).toThrow(/readiness gate/);
  });
});
