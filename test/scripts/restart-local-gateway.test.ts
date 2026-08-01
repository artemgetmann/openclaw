import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "restart-local-gateway.sh");

function writeStub(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${contents}\n`, "utf8");
}

function createRestartHarness(): {
  root: string;
  wrapperLog: string;
  run: (launchdLabel: string, overrides?: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>;
  cleanup: () => void;
} {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "restart-local-gateway-"));
  const root = path.join(temp, "openclaw");
  const home = path.join(temp, "home");
  fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const wrapperLog = path.join(temp, "wrapper.log");
  fs.copyFileSync(SCRIPT_PATH, path.join(root, "scripts", "restart-local-gateway.sh"));

  // The ownership refusal runs after shared library setup, so the harness
  // supplies only the contracts needed to reach that guard without touching
  // launchd, a real checkout, or the user's runtime.
  writeStub(
    path.join(root, "scripts", "lib", "validated-node.sh"),
    ["openclaw_use_validated_node() {", '  export OPENCLAW_NODE_BIN="/usr/bin/true"', "}"].join(
      "\n",
    ),
  );
  writeStub(
    path.join(root, "scripts", "lib", "consumer-instance.sh"),
    [
      "consumer_instance_default_id_for_checkout() { printf ''; }",
      'consumer_instance_normalize_id() { printf "%s" "${1:-}"; }',
      "consumer_instance_apply_runtime_env() { :; }",
    ].join("\n"),
  );
  writeStub(
    path.join(root, "scripts", "lib", "worktree-guards.sh"),
    [
      "worktree_guard_require_sacred_home_clone_base_branch() { :; }",
      "worktree_guard_reject_sacred_home_edits() { :; }",
    ].join("\n"),
  );
  writeStub(
    path.join(root, "scripts", "lib", "heavy-local-slot.sh"),
    "openclaw_heavy_local_slot_inherited_lease_is_valid() { return 1; }",
  );
  writeStub(
    path.join(root, "scripts", "with-heavy-local-slot.sh"),
    ["#!/usr/bin/env bash", 'printf "%s\\n" "$*" >"$OPENCLAW_TEST_WRAPPER_LOG"', "exit 75"].join(
      "\n",
    ),
  );
  writeStub(path.join(root, "scripts", "gateway-lifecycle-command.sh"), "#!/usr/bin/env bash");
  fs.chmodSync(path.join(root, "scripts", "with-heavy-local-slot.sh"), 0o700);
  fs.chmodSync(path.join(root, "scripts", "gateway-lifecycle-command.sh"), 0o700);

  return {
    root,
    wrapperLog,
    run: (launchdLabel, overrides = {}) =>
      spawnSync("/bin/bash", [path.join(root, "scripts", "restart-local-gateway.sh")], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_LAUNCHD_LABEL: launchdLabel,
          OPENCLAW_TEST_WRAPPER_LOG: wrapperLog,
          // An explicit lane value prevents checkout-name inference from
          // replacing the exact label under test.
          OPENCLAW_STATE_DIR: path.join(temp, "state"),
          ...overrides,
        },
        encoding: "utf8",
      }),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

describe("scripts/restart-local-gateway.sh shared ownership guard", () => {
  it.each(["ai.openclaw.gateway", "ai.jarvis.gateway"])(
    "refuses to manage shared launchd label %s",
    (launchdLabel) => {
      const harness = createRestartHarness();
      try {
        const result = harness.run(launchdLabel);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `refuses to manage the shared managed launchd service ${launchdLabel}`,
        );
      } finally {
        harness.cleanup();
      }
    },
  );

  it("enters the canonical lifecycle wrapper before a lane-local mutation", () => {
    const harness = createRestartHarness();
    try {
      const label = "ai.openclaw.consumer.test.gateway";
      const result = harness.run(label);

      expect(result.status).toBe(75);
      expect(fs.readFileSync(harness.wrapperLog, "utf8")).toContain(
        `--policy gateway-lifecycle --label gateway-restart:${label}`,
      );
      expect(fs.readFileSync(harness.wrapperLog, "utf8")).toContain(
        "gateway-lifecycle-command.sh local-script -- /bin/bash",
      );
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a legacy detached self-restart before lifecycle mutation", () => {
    const harness = createRestartHarness();
    try {
      const result = harness.run("ai.openclaw.consumer.test.gateway", {
        OPENCLAW_RESTART_DETACHED: "1",
      });

      expect(result.status).toBe(75);
      expect(result.stderr).toContain("use the guarded openclaw gateway restart handoff");
      expect(fs.existsSync(harness.wrapperLog)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });
});
