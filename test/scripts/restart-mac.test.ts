import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "restart-mac.sh");

describe("scripts/restart-mac.sh", () => {
  it("defaults to a narrow app scope and keeps the broad kill path explicit", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('APP_SCOPE="self"');
    expect(script).toContain("--app-scope self|all");
    expect(script).toContain("Only restart the current app bundle and its gateway");
    expect(script).toContain("Also kill any other OpenClaw app process");
    expect(script).toContain(
      "Default app scope: self (only the current app bundle and its gateway)",
    );
    expect(script).toContain("restart_processes_remaining");
    expect(script).toMatch(/if \[\[ "\$APP_SCOPE" == "all" \]\]; then[\s\S]*pkill -x "OpenClaw"/);
  });

  it("scopes the launchagent disable marker to the active state dir and records provenance", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'LAUNCHAGENT_DISABLE_STATE_DIR="${OPENCLAW_STATE_DIR:-${OPENCLAW_HOME:+${OPENCLAW_HOME}/.openclaw}}"',
    );
    expect(script).toContain('"source": "scripts/restart-mac.sh"');
    expect(script).toContain('"stateDir": "${LAUNCHAGENT_DISABLE_STATE_DIR}"');
    expect(script).toContain('"worktree": "${ROOT_DIR}"');
    expect(script).toContain('write_launchagent_disable_marker "unsigned-restart"');
  });
});
