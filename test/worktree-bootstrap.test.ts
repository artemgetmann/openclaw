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

const installValidatedNodeStub = (root: string) => {
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  // The production bootstrap self-guards heavy work. These unit fixtures run
  // entirely against stubbed install/build commands, so retain the call shape
  // while making admission a deterministic no-op.
  writeFileSync(
    path.join(root, "scripts", "lib", "heavy-local-slot.sh"),
    `#!/usr/bin/env bash
openclaw_heavy_local_slot_require_or_reexec() {
  return 0
}
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(root, "scripts", "lib", "validated-node.sh"),
    `#!/usr/bin/env bash
openclaw_use_validated_node() {
  export OPENCLAW_NODE_BIN="$(command -v node)"
  export OPENCLAW_VALIDATED_NODE_BIN="$OPENCLAW_NODE_BIN"
  return 0
}

openclaw_run_repo_pnpm() {
  local root="$1"
  shift

  case "$1" in
    install)
      mkdir -p "$root/node_modules/.bin"
      if [[ "\${STUB_DISABLE_INSTALL_VITEST:-0}" != "1" ]]; then
        cat > "$root/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
echo 4.1.0
EOF
        chmod 755 "$root/node_modules/.bin/vitest"
      fi
      ;;
    build)
      mkdir -p "$root/dist"
      printf 'export {}\\n' > "$root/dist/index.js"
      head_commit="$(git -C "$root" rev-parse HEAD)"
      printf '{"commit":"%s"}\\n' "$head_commit" > "$root/dist/build-info.json"
      ;;
    exec)
      if [[ "$2" == "vitest" && "$3" == "--version" && -x "$root/node_modules/.bin/vitest" ]]; then
        "$root/node_modules/.bin/vitest"
        return 0
      fi
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}
`,
    { encoding: "utf8", mode: 0o755 },
  );
};

const installBootstrapFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    '{"name":"fixture","packageManager":"pnpm@10.23.0"}\n',
  );
  run(root, "git", ["init", "--initial-branch=main"]);
  run(root, "git", ["config", "user.name", "Test User"]);
  run(root, "git", ["config", "user.email", "test@example.com"]);
  run(root, "git", ["add", "package.json"]);
  run(root, "git", ["commit", "-m", "fixture"]);
  installValidatedNodeStub(root);
  symlinkSync(
    path.join(process.cwd(), "scripts", "bootstrap-worktree-runtime.sh"),
    path.join(root, "scripts", "bootstrap-worktree-runtime.sh"),
  );
  symlinkSync(
    path.join(process.cwd(), "scripts", "worktree-ready-check.sh"),
    path.join(root, "scripts", "worktree-ready-check.sh"),
  );
  return root;
};

describe("worktree bootstrap readiness", () => {
  it("repairs partial node_modules before declaring the lane ready", () => {
    const root = installBootstrapFixture();
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist", "index.js"), "export {}\n");

    run(root, "bash", ["scripts/bootstrap-worktree-runtime.sh", "--root", root]);

    expect(run(root, "bash", ["-lc", "test -x node_modules/.bin/vitest && echo ok"])).toBe("ok");
  });

  it("allows warm bootstrap to skip the build while still proving local tools", () => {
    const root = installBootstrapFixture();

    run(root, "bash", ["scripts/bootstrap-worktree-runtime.sh", "--root", root, "--skip-build"]);

    expect(run(root, "bash", ["-lc", "test -x node_modules/.bin/vitest && echo ok"])).toBe("ok");
    expect(run(root, "bash", ["-lc", "test ! -f dist/index.js && echo ok"])).toBe("ok");
  });

  it("fails when local Vitest still cannot be resolved after bootstrap", () => {
    const root = installBootstrapFixture();

    const result = runResult(
      root,
      "bash",
      ["scripts/bootstrap-worktree-runtime.sh", "--root", root],
      { STUB_DISABLE_INSTALL_VITEST: "1" },
    );

    expect(result.status).not.toBe(0);
    expect(run(root, "bash", ["-lc", "test ! -e node_modules/.bin/vitest && echo ok"])).toBe("ok");
  });

  it("rebuilds dist when build metadata belongs to a prior commit", () => {
    const root = installBootstrapFixture();

    run(root, "bash", ["scripts/bootstrap-worktree-runtime.sh", "--root", root]);
    writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"2.0.0"}\n');
    run(root, "git", ["add", "package.json"]);
    run(root, "git", ["commit", "-m", "advance head"]);

    run(root, "bash", ["scripts/bootstrap-worktree-runtime.sh", "--root", root]);

    const buildInfo = JSON.parse(
      run(root, "node", [
        "-e",
        "process.stdout.write(require('fs').readFileSync('dist/build-info.json','utf8'))",
      ]),
    ) as { commit: string };
    expect(buildInfo.commit).toBe(run(root, "git", ["rev-parse", "HEAD"]));
  });
});
