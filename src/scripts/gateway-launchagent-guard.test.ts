import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function makeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function runGuard(params: {
  targetLabel: string;
  targetStateDir: string;
  targetConfigPath: string;
  targetPort: string;
  existingStateDir: string;
  existingConfigPath: string;
  existingPort: string;
}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-guard-"));
  const home = path.join(temp, "home");
  const bin = path.join(temp, "bin");
  fs.mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(home, "Library", "LaunchAgents", "ai.openclaw.gateway.plist"),
    "<plist/>",
    "utf8",
  );

  const callLog = path.join(temp, "launchctl.log");
  const plistBuddy = path.join(bin, "PlistBuddy");
  const launchctl = path.join(bin, "launchctl");
  makeExecutable(
    plistBuddy,
    [
      "#!/usr/bin/env bash",
      'case "$2" in',
      '  "Print :EnvironmentVariables:OPENCLAW_STATE_DIR") printf "%s\\n" "$FAKE_EXISTING_STATE_DIR" ;;',
      '  "Print :EnvironmentVariables:OPENCLAW_CONFIG_PATH") printf "%s\\n" "$FAKE_EXISTING_CONFIG_PATH" ;;',
      '  "Print :ProgramArguments:0") printf "%s\\n" "node" ;;',
      '  "Print :ProgramArguments:1") printf "%s\\n" "dist/index.js" ;;',
      '  "Print :ProgramArguments:2") printf "%s\\n" "gateway" ;;',
      '  "Print :ProgramArguments:3") printf "%s\\n" "--port" ;;',
      '  "Print :ProgramArguments:4") printf "%s\\n" "$FAKE_EXISTING_PORT" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  makeExecutable(
    launchctl,
    ["#!/usr/bin/env bash", 'printf "%s\\n" "$*" >> "$FAKE_LAUNCHCTL_LOG"', ""].join("\n"),
  );

  const script = [
    "set -euo pipefail",
    `source ${JSON.stringify(path.resolve("scripts/lib/gateway-launchagent-guard.sh"))}`,
    "openclaw_bootout_conflicting_gateway_label ai.openclaw.gateway " +
      `${params.targetLabel} ${JSON.stringify(params.targetStateDir)} ` +
      `${JSON.stringify(params.targetConfigPath)} ${params.targetPort}`,
  ].join("\n");

  const result = spawnSync("/bin/bash", ["-lc", script], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_PLISTBUDDY_BIN: plistBuddy,
      OPENCLAW_LAUNCHCTL_BIN: launchctl,
      FAKE_LAUNCHCTL_LOG: callLog,
      FAKE_EXISTING_STATE_DIR: params.existingStateDir,
      FAKE_EXISTING_CONFIG_PATH: params.existingConfigPath,
      FAKE_EXISTING_PORT: params.existingPort,
      OPENCLAW_CANONICAL_SHARED_GATEWAY_STATE_DIR: params.existingStateDir,
      OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH: params.existingConfigPath,
      OPENCLAW_CANONICAL_SHARED_GATEWAY_PORT: params.existingPort,
    },
    encoding: "utf8",
  });

  const launchctlCalls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "";
  fs.rmSync(temp, { recursive: true, force: true });
  return { result, launchctlCalls };
}

describe("gateway LaunchAgent bootout guard", () => {
  it("refuses to boot out the default gateway for a named isolated target", () => {
    const { result, launchctlCalls } = runGuard({
      targetLabel: "ai.openclaw.consumer.foo.gateway",
      targetStateDir: "/tmp/openclaw-consumer-foo/.openclaw",
      targetConfigPath: "/tmp/openclaw-consumer-foo/.openclaw/openclaw.json",
      targetPort: "26060",
      existingStateDir: "/Users/test/Library/Application Support/OpenClaw/.openclaw",
      existingConfigPath:
        "/Users/test/Library/Application Support/OpenClaw/.openclaw/openclaw.json",
      existingPort: "18789",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Skipping default gateway bootout");
    expect(launchctlCalls).toBe("");
  });

  it("does not treat matching canonical fields as permission for a named target", () => {
    const stateDir = "/Users/test/Library/Application Support/OpenClaw/.openclaw";
    const configPath = `${stateDir}/openclaw.json`;
    const { result, launchctlCalls } = runGuard({
      targetLabel: "ai.openclaw.consumer.foo.gateway",
      targetStateDir: stateDir,
      targetConfigPath: configPath,
      targetPort: "18789",
      existingStateDir: stateDir,
      existingConfigPath: configPath,
      existingPort: "18789",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Skipping default gateway bootout");
    expect(launchctlCalls).toBe("");
  });
});
