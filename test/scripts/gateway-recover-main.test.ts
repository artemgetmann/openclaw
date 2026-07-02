import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "gateway-recover-main.sh");
const WATCHDOG_SCRIPT_PATH = path.join(process.cwd(), "scripts", "gateway-watchdog.sh");

function runJarvisPortProbe(launchState: string, port = 18789) {
  const stateFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-test-")),
    "state.txt",
  );
  fs.writeFileSync(stateFile, launchState);
  try {
    return execFileSync(
      "bash",
      [
        "-lc",
        [
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `PORT=${port}`,
          `launch_state="$(cat ${JSON.stringify(stateFile)})"`,
          'if jarvis_gateway_targets_shared_port "${launch_state}"; then printf yes; else printf no; fi',
        ].join("; "),
      ],
      { encoding: "utf8" },
    );
  } finally {
    fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
  }
}

describe("scripts/gateway-recover-main.sh", () => {
  it("reinstalls the shared gateway with canonical App Support env only", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'CANONICAL_OPENCLAW_HOME="${HOME}/Library/Application Support/OpenClaw"',
    );
    expect(script).toContain('CANONICAL_OPENCLAW_STATE_DIR="${CANONICAL_OPENCLAW_HOME}/.openclaw"');
    expect(script).toContain(
      'CANONICAL_OPENCLAW_CONFIG_PATH="${CANONICAL_OPENCLAW_STATE_DIR}/openclaw.json"',
    );
    expect(script).toContain('CANONICAL_OPENCLAW_LOG_DIR="${CANONICAL_OPENCLAW_STATE_DIR}/logs"');
    expect(script).toContain('GATEWAY_ERR_LOG="${CANONICAL_OPENCLAW_LOG_DIR}/gateway.err.log"');
    expect(script).toContain("env -i");
    expect(script).toContain('OPENCLAW_HOME="${CANONICAL_OPENCLAW_HOME}"');
    expect(script).toContain('OPENCLAW_STATE_DIR="${CANONICAL_OPENCLAW_STATE_DIR}"');
    expect(script).toContain('OPENCLAW_CONFIG_PATH="${CANONICAL_OPENCLAW_CONFIG_PATH}"');
    expect(script).toContain('OPENCLAW_LOG_DIR="${CANONICAL_OPENCLAW_LOG_DIR}"');
    expect(script).toContain('OPENCLAW_GATEWAY_BIND="loopback"');
    expect(script).toContain('OPENCLAW_LAUNCHD_LABEL="${GATEWAY_LABEL}"');
    expect(script).toContain('OPENCLAW_MAIN_REPO="${MAIN_REPO}"');
    expect(script).not.toMatch(/OPENCLAW_PROFILE=/);
    expect(script).not.toMatch(/OPENCLAW_GATEWAY_TOKEN=/);
  });

  it("uses the canonical health route for recovery readiness", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('"http://127.0.0.1:${PORT}/healthz"');
    expect(script).not.toContain('"http://127.0.0.1:${PORT}/"');
  });

  it("exits before restart work when the canonical gateway is already healthy", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    const jarvisGuardCallIndex = script.indexOf("assert_no_jarvis_gateway_conflict");
    const healthyCallIndex = script.indexOf("if canonical_gateway_healthy; then");
    const healthyMessageIndex = script.indexOf(
      "canonical gateway is already healthy; exiting without restart",
    );
    const shallowRecoveryIndex = script.indexOf('log_block "Shallow launchd recovery"');
    const fullStopIndex = script.indexOf('log_block "Full clean stop"');

    expect(script).toContain("canonical_gateway_healthy() {");
    expect(script).toContain("assert_no_jarvis_gateway_conflict() {");
    expect(jarvisGuardCallIndex).toBeGreaterThanOrEqual(0);
    expect(healthyCallIndex).toBeGreaterThanOrEqual(0);
    expect(jarvisGuardCallIndex).toBeLessThan(healthyCallIndex);
    expect(healthyMessageIndex).toBeGreaterThan(healthyCallIndex);
    expect(healthyMessageIndex).toBeLessThan(shallowRecoveryIndex);
    expect(healthyMessageIndex).toBeLessThan(fullStopIndex);
  });

  it("refuses shared gateway recovery while Jarvis owns the same port unless explicitly overridden", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'JARVIS_GATEWAY_LABEL="${OPENCLAW_JARVIS_GATEWAY_LABEL:-ai.jarvis.gateway}"',
    );
    expect(script).toContain(
      'ALLOW_SHARED_GATEWAY_WITH_JARVIS="${OPENCLAW_ALLOW_SHARED_GATEWAY_WITH_JARVIS:-0}"',
    );
    expect(script).toContain("jarvis_gateway_targets_shared_port() {");
    expect(script).toContain('if (line == "environment = {")');
    expect(script).toContain('line == "OPENCLAW_GATEWAY_PORT => " port');
    expect(script).toContain('previous == "--port" && line == port');
    expect(script).toContain("refusing to recover %s while %s is loaded for port %s");
    expect(script).toContain("scripts/prove-jarvis-runtime.sh");
    expect(script).toContain("OPENCLAW_ALLOW_SHARED_GATEWAY_WITH_JARVIS=1");
  });

  it("ignores stale inherited launchd environment when checking Jarvis port ownership", () => {
    const inheritedOnly = [
      "gui/501/ai.jarvis.gateway = {",
      "  arguments = {",
      "    node",
      "    dist/index.js",
      "    gateway",
      "    --port",
      "    19001",
      "  }",
      "  inherited environment = {",
      "    OPENCLAW_GATEWAY_PORT => 18789",
      "  }",
      "  environment = {",
      "    OPENCLAW_GATEWAY_PORT => 19001",
      "  }",
      "}",
    ].join("\n");

    expect(runJarvisPortProbe(inheritedOnly)).toBe("no");
  });

  it("detects Jarvis port ownership from active environment and launch arguments", () => {
    const activeEnv = [
      "gui/501/ai.jarvis.gateway = {",
      "  arguments = {",
      "    node",
      "    dist/index.js",
      "    gateway",
      "    --port",
      "    19001",
      "  }",
      "  environment = {",
      "    OPENCLAW_GATEWAY_PORT => 18789",
      "  }",
      "}",
    ].join("\n");
    const launchArgument = [
      "gui/501/ai.jarvis.gateway = {",
      "  arguments = {",
      "    node",
      "    dist/index.js",
      "    gateway",
      "    --port",
      "    18789",
      "  }",
      "  environment = {",
      "    OPENCLAW_GATEWAY_PORT => 19001",
      "  }",
      "}",
    ].join("\n");

    expect(runJarvisPortProbe(activeEnv)).toBe("yes");
    expect(runJarvisPortProbe(launchArgument)).toBe("yes");
  });

  it("supports shallow launchd recovery without full stop, build, or reinstall", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    const shallowStart = script.indexOf('if [[ "${RECOVERY_MODE}" == "shallow" ]]; then');
    const shallowEnd = script.indexOf('log_block "Full clean stop"', shallowStart);
    const shallowBlock = script.slice(shallowStart, shallowEnd);

    expect(script).toContain('RECOVERY_MODE="${OPENCLAW_GATEWAY_RECOVER_MODE:-full}"');
    expect(script).toContain("--shallow");
    expect(shallowBlock).toContain('log_block "Shallow launchd recovery"');
    expect(script).toContain("ensure_gateway_launch_agent_started_or_exit() {");
    expect(shallowBlock).toContain("ensure_gateway_launch_agent_started_or_exit");
    expect(shallowBlock).toContain("wait_for_listener");
    expect(shallowBlock).toContain("wait_for_http_probe");
    expect(shallowBlock).not.toContain("stop_canonical_main_runtime_pids");
    expect(shallowBlock).not.toContain("run_shared_runtime_build");
    expect(shallowBlock).not.toContain("install_main_launch_agent");
    expect(shallowBlock).not.toContain("bootout");
  });

  it("avoids broad process cleanup and only kills filtered canonical runtime pids", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).not.toMatch(/\bpkill\b/);
    expect(script).not.toContain("run_openclaw_cli gateway stop");
    expect(script).toContain("collect_canonical_main_runtime_pids() {");
    expect(script).toContain("pid_matches_main_runtime");
    expect(script).toContain("pgrep -x openclaw-gateway");
    expect(script).toContain("ps -axo pid=,command=");
    expect(script).toContain('kill -TERM "${pids[@]}"');
    expect(script).toContain('kill -KILL "${remaining[@]}"');
  });
});

describe("scripts/gateway-watchdog.sh", () => {
  it("requires sustained health failure before reclaiming the gateway", () => {
    const script = fs.readFileSync(WATCHDOG_SCRIPT_PATH, "utf8");

    expect(script).toContain('FAIL_THRESHOLD="${OPENCLAW_GATEWAY_WATCHDOG_FAIL_THRESHOLD:-8}"');
    expect(script).toContain(
      'HTTP_TIMEOUT_SECONDS="${OPENCLAW_GATEWAY_WATCHDOG_HTTP_TIMEOUT_SECONDS:-10}"',
    );
    expect(script).toContain('curl -fsS --max-time "${HTTP_TIMEOUT_SECONDS}"');
    expect(script).not.toContain('FAIL_THRESHOLD="${OPENCLAW_GATEWAY_WATCHDOG_FAIL_THRESHOLD:-2}"');
    expect(script).not.toContain("curl -fsS --max-time 3");
  });

  it("uses shallow recovery and disables watchdog self-management", () => {
    const script = fs.readFileSync(WATCHDOG_SCRIPT_PATH, "utf8");

    expect(script).toContain("OPENCLAW_GATEWAY_RECOVER_MANAGE_WATCHDOG=0");
    expect(script).toContain("OPENCLAW_GATEWAY_RECOVER_MODE=shallow");
    expect(script).toContain('"${RECOVER_SCRIPT}" --shallow');
    expect(script).toContain("RECOVERY_BACKOFF_SECONDS=");
    expect(script).toContain("shallow recovery failed; backing off");
    expect(script).not.toContain('"${RECOVER_SCRIPT}"\n');
  });
});
