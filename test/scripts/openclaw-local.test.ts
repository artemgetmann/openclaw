import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "openclaw-local.sh");

function writeExecutable(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${contents}\n`, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function createOpenclawLocalHarness(): {
  root: string;
  callsPath: string;
  run: (args: string[], env?: Record<string, string | undefined>) => ReturnType<typeof spawnSync>;
  cleanup: () => void;
} {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-routing-"));
  const root = path.join(temp, "openclaw");
  const callsPath = path.join(temp, "calls.log");
  const home = path.join(temp, "home");
  fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  fs.copyFileSync(SCRIPT_PATH, path.join(root, "scripts", "openclaw-local.sh"));
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "", "utf8");

  writeExecutable(
    path.join(root, "scripts", "fake-node.sh"),
    [
      "#!/usr/bin/env bash",
      'printf "node:%s\\n" "$*" >> "$OPENCLAW_TEST_CALLS"',
      'printf "telegram-compat:%s\\n" "${OPENCLAW_TELEGRAM_USER_REPO_LOCAL_COMPAT:-}" >> "$OPENCLAW_TEST_CALLS"',
      "exit 0",
    ].join("\n"),
  );
  writeExecutable(
    path.join(root, "scripts", "restart-local-gateway.sh"),
    [
      "#!/usr/bin/env bash",
      'printf "local-helper:%s\\n" "$*" >> "$OPENCLAW_TEST_CALLS"',
      "exit 66",
    ].join("\n"),
  );
  writeExecutable(
    path.join(root, "scripts", "lib", "validated-node.sh"),
    [
      "#!/usr/bin/env bash",
      "openclaw_use_validated_node() {",
      '  export OPENCLAW_NODE_BIN="$1/scripts/fake-node.sh"',
      "}",
    ].join("\n"),
  );
  writeExecutable(
    path.join(root, "scripts", "lib", "consumer-instance.sh"),
    [
      "#!/usr/bin/env bash",
      "consumer_instance_default_id_for_checkout() { printf ''; }",
      'consumer_instance_normalize_id() { printf "%s" "${1:-}"; }',
      "consumer_instance_apply_runtime_env() { :; }",
    ].join("\n"),
  );
  writeExecutable(
    path.join(root, "scripts", "bootstrap-worktree-telegram.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'mkdir -p "$PWD/scripts/telegram-e2e/tmp"',
      "cat > \"$PWD/scripts/telegram-e2e/.env.local\" <<'EOF'",
      "TELEGRAM_API_ID=123456",
      "TELEGRAM_API_HASH=test-hash",
      "EOF",
      'printf "session" > "$PWD/scripts/telegram-e2e/tmp/userbot.session"',
      'printf "bootstrap:%s\\n" "$*" >> "$OPENCLAW_TEST_CALLS"',
    ].join("\n"),
  );
  writeExecutable(
    path.join(root, "scripts", "lib", "worktree-guards.sh"),
    [
      "#!/usr/bin/env bash",
      "worktree_guard_require_sacred_home_clone_base_branch() { :; }",
      "worktree_guard_reject_sacred_home_edits() { :; }",
      "worktree_guard_run_for_linked_checkout() { :; }",
      "worktree_guard_sacred_home_clone_role() {",
      '  if [[ -n "${OPENCLAW_TEST_SACRED_ROLE:-}" ]]; then',
      '    printf "%s\\n" "$OPENCLAW_TEST_SACRED_ROLE"',
      "  fi",
      "}",
    ].join("\n"),
  );

  return {
    root,
    callsPath,
    run: (args, env = {}) =>
      spawnSync("/bin/bash", [path.join(root, "scripts", "openclaw-local.sh"), ...args], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_TEST_CALLS: callsPath,
          ...env,
        },
        encoding: "utf8",
      }),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

describe("scripts/openclaw-local.sh restart routing", () => {
  it("lets canonical sacred main gateway restart reach the CLI instead of the local helper", () => {
    const harness = createOpenclawLocalHarness();
    try {
      const result = harness.run(["gateway", "restart"], {
        OPENCLAW_TEST_SACRED_ROLE: "main",
      });
      const calls = fs.readFileSync(harness.callsPath, "utf8");

      expect(result.status).toBe(0);
      expect(calls).toContain(
        `node:${fs.realpathSync(path.join(harness.root, "openclaw.mjs"))} gateway restart`,
      );
      expect(calls).not.toContain("local-helper:");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps non-canonical checkouts on the local helper when they target the shared label", () => {
    const harness = createOpenclawLocalHarness();
    try {
      const result = harness.run(["gateway", "restart"], {
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      });
      const calls = fs.readFileSync(harness.callsPath, "utf8");

      expect(result.status).toBe(66);
      expect(calls).toBe("local-helper:\n");
      expect(calls).not.toContain("node:");
    } finally {
      harness.cleanup();
    }
  });

  it("bootstraps missing Telegram userbot assets before telegram-user commands", () => {
    const harness = createOpenclawLocalHarness();
    try {
      const result = harness.run(["telegram-user", "status", "--json"]);
      const calls = fs.readFileSync(harness.callsPath, "utf8");

      expect(result.status).toBe(0);
      expect(calls).toContain("bootstrap:--strict");
      expect(calls).toContain("telegram-compat:1");
      expect(calls).toContain(
        `node:${fs.realpathSync(path.join(harness.root, "openclaw.mjs"))} telegram-user status --json`,
      );
      expect(
        fs.readFileSync(path.join(harness.root, "scripts", "telegram-e2e", ".env.local"), "utf8"),
      ).toContain("TELEGRAM_API_ID=123456");
      expect(
        fs.existsSync(path.join(harness.root, "scripts", "telegram-e2e", "tmp", "userbot.session")),
      ).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});
