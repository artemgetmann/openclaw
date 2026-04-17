import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const SCRIPT_PATH = path.join(process.cwd(), "scripts", "telegram-live-runtime.sh");

describe("telegram-live-runtime.sh", () => {
  it("keeps truthy env parsing compatible with macOS bash 3", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)} && is_truthy_env_flag "TRUE" && printf ok`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toBe("ok");
  });

  it("emits ensure proof lines with an empty token claim array on macOS bash 3", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-empty-array-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)} && BRANCH=main WORKTREE=/tmp/test RUNTIME_OWNERSHIP=ok RUNTIME_HEALTH=ok RUNTIME_START_ACTION=skip RUNTIME_START_TIMEOUT_SECS=45 RUNTIME_PLUGIN_MODE=telegram-only TOKEN_PRESENT=no TOKEN_POOL_GUARD=ok TOKEN_FINGERPRINT=none CURRENT_LANE_BOT=unknown RUNTIME_TOKEN_SOURCE=unknown TOKEN_ORIGIN_HINT=unknown ASSIGNED_BOT_ID=unknown ASSIGNED_BOT_USERNAME=unknown ASSIGNED_BOT_NAME=unknown TOKEN_CLAIM_COUNT=0 emit_ensure_proof_lines`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toContain("token_claim_count=0");
    expect(stdout).toContain("runtime_ownership=ok");
    expect(stdout).not.toContain("token_claim_path=");
  });
});
