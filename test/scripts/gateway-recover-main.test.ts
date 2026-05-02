import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "gateway-recover-main.sh");

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
});
