import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireTelegramTesterScenarioReservation } from "../../scripts/lib/telegram-tester-scenario-reservations.mjs";

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
        `source ${JSON.stringify(sourcePath)} && BRANCH=main WORKTREE=/tmp/test RUNTIME_OWNERSHIP=ok RUNTIME_HEALTH=ok RUNTIME_START_ACTION=skip RUNTIME_START_TIMEOUT_SECS=45 RUNTIME_PLUGIN_MODE=main-parity TOKEN_PRESENT=no TOKEN_POOL_GUARD=ok TOKEN_FINGERPRINT=none CURRENT_LANE_BOT=unknown RUNTIME_TOKEN_SOURCE=unknown TOKEN_ORIGIN_HINT=unknown ASSIGNED_BOT_ID=unknown ASSIGNED_BOT_USERNAME=unknown ASSIGNED_BOT_NAME=unknown TOKEN_CLAIM_COUNT=0 PARITY_REPORT_PATH=/tmp/report.json PARITY_CONFIG_DIFF_ALLOWED_ONLY=true PARITY_BROWSER_SIDECAR_ENABLED=true PARITY_BROWSER_PROFILES_MATCH=true PARITY_TOOLS_MATCH=true PARITY_PLUGINS_MATCH=true PARITY_MODEL_CONFIG_MATCH=true PARITY_UPLOAD_DIR=/tmp/openclaw/uploads PARITY_UPLOAD_DIR_READY=true PARITY_UNEXPECTED_DIFFS= emit_ensure_proof_lines`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toContain("token_claim_count=0");
    expect(stdout).toContain("runtime_ownership=ok");
    expect(stdout).toContain("runtime_plugin_mode=main-parity");
    expect(stdout).toContain("config_diff_allowed_only=true");
    expect(stdout).toContain("browser_sidecar_enabled=true");
    expect(stdout).not.toContain("token_claim_path=");
  });

  it("serializes custom-root ensure and default-root release across one stable profile lock", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-lock-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const logPath = path.join(tempDir, "transactions.log");
    const machineHome = path.join(tempDir, "home");
    const customStateRoot = path.join(tempDir, "custom-state");
    const worktreePath = path.join(tempDir, "worktree");
    const profileId = `tg-live-${crypto
      .createHash("sha256")
      .update(worktreePath)
      .digest("hex")
      .slice(0, 10)}`;
    const defaultStateRoot = path.join(
      machineHome,
      "Library",
      "Application Support",
      "OpenClaw",
      "telegram-live-worktrees",
    );
    const commandLockDir = path.join(
      defaultStateRoot,
      "command-locks",
      `${profileId}.command.lock`,
    );
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; export HOME=${JSON.stringify(machineHome)}; HELPER_MODULE=${JSON.stringify(path.join(process.cwd(), "scripts", "lib", "telegram-live-runtime-helpers.mjs"))}; WORKTREE=${JSON.stringify(worktreePath)}; ensure_command_unlocked() { printf 'ensure-start:%s\\n' "$RUNTIME_STATE_DIR" >> ${JSON.stringify(logPath)}; sleep 0.3; printf 'ensure-end\\n' >> ${JSON.stringify(logPath)}; }; release_command_unlocked() { printf 'release-start:%s\\n' "$RUNTIME_STATE_DIR" >> ${JSON.stringify(logPath)}; printf 'release-end\\n' >> ${JSON.stringify(logPath)}; }; OPENCLAW_TELEGRAM_LIVE_STATE_ROOT=${JSON.stringify(customStateRoot)} ensure_command & ensure_pid=$!; sleep 0.05; OPENCLAW_TELEGRAM_LIVE_STATE_ROOT= release_command & release_pid=$!; wait "$ensure_pid"; wait "$release_pid"; cat ${JSON.stringify(logPath)}`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toBe(
      [
        `ensure-start:${path.join(customStateRoot, profileId)}`,
        "ensure-end",
        `release-start:${path.join(defaultStateRoot, profileId, ".openclaw")}`,
        "release-end",
        "",
      ].join("\n"),
    );
    expect(existsSync(commandLockDir)).toBe(false);
  });

  it("creates a missing profile lock parent before the first ensure", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-lock-parent-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const runtimeStateDir = path.join(tempDir, "missing", "nested", "state");
    const commandLockDir = path.join(tempDir, "missing", "nested", "profile.command.lock");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; resolve_profile() { RUNTIME_STATE_DIR=${JSON.stringify(runtimeStateDir)}; PROFILE_COMMAND_LOCK_DIR=${JSON.stringify(commandLockDir)}; }; ensure_command_unlocked() { printf ok; }; ensure_command`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toBe("ok");
    expect(existsSync(path.dirname(runtimeStateDir))).toBe(true);
    expect(existsSync(commandLockDir)).toBe(false);
  });

  it("routes every profile lifecycle mutator through the command lock", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-wrappers-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; with_profile_command_lock() { printf '%s\\n' "$1"; }; ensure_command; release_command; handoff_main_command`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toBe(
      "ensure_command_unlocked\nrelease_command_unlocked\nhandoff_main_command_unlocked\n",
    );
  });

  it("resolves the machine session owner before tester token claim", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-owner-order-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; resolve_profile() { :; }; resolve_base_config_path() { :; }; resolve_runtime_owner() { RUNTIME_PID=""; RUNTIME_OWNERSHIP=ok; }; reset_acp_validation_runtime_state_if_needed() { :; }; ensure_telegram_user_owner() { printf 'owner\\n'; }; ensure_tester_bot_claim() { printf 'token\\n'; FAIL=1; }; emit_ensure_proof_lines() { :; }; BRANCH=main FAIL=0 FAIL_REASONS=(); ensure_command_unlocked || true`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toBe("owner\ntoken\n");
  });

  it("releases the exact reservation generation and local claim as one safe boundary", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-release-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const envLocalPath = path.join(tempDir, ".env.local");
    const reservationRoot = path.join(tempDir, "reservations");
    const token = "12345:release-test";
    const scenarioId = "release-scenario";
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");
    const reservation = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId,
      worktreePath: tempDir,
      reservationRoot,
    });
    writeFileSync(
      envLocalPath,
      [
        `TELEGRAM_BOT_TOKEN=${token}`,
        `OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=${scenarioId}`,
        `OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=${String(reservation.generation)}`,
        `OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH=${crypto.createHash("sha256").update(token).digest("hex")}`,
        `OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION=${String(reservation.generation)}`,
        "KEEP_ME=yes",
        "",
      ].join("\n"),
    );

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; REPO_ROOT=${JSON.stringify(tempDir)}; WORKTREE=${JSON.stringify(tempDir)}; SCENARIO_RESERVATION_MODULE=${JSON.stringify(path.join(process.cwd(), "scripts", "lib", "telegram-tester-scenario-reservations.mjs"))}; OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT=${JSON.stringify(reservationRoot)}; resolve_profile() { RUNTIME_STATE_DIR=${JSON.stringify(path.join(tempDir, "state"))}; PROFILE_COMMAND_LOCK_DIR=${JSON.stringify(path.join(tempDir, "profile.command.lock"))}; RUNTIME_PORT=24567; }; resolve_runtime_owner() { RUNTIME_PID=""; RUNTIME_OWNERSHIP=ok; }; stop_owned_runtime() { RUNTIME_STOP_RESULT=not-running; }; remove_runtime_state_dir() { :; }; release_command`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toContain("release_token_cleared=yes");
    expect(stdout).toContain(`release_scenario_id=${scenarioId}`);
    expect(readFileSync(envLocalPath, "utf8")).toBe("KEEP_ME=yes\n");
  });

  it("releases a pre-reservation token claim after stopping its owned runtime", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-legacy-release-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const envLocalPath = path.join(tempDir, ".env.local");
    const reservationRoot = path.join(tempDir, "reservations");
    const token = "12345:legacy-release-test";
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");
    writeFileSync(envLocalPath, `TELEGRAM_BOT_TOKEN=${token}\nKEEP_ME=yes\n`);

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; REPO_ROOT=${JSON.stringify(tempDir)}; WORKTREE=${JSON.stringify(tempDir)}; SCENARIO_RESERVATION_MODULE=${JSON.stringify(path.join(process.cwd(), "scripts", "lib", "telegram-tester-scenario-reservations.mjs"))}; OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT=${JSON.stringify(reservationRoot)}; resolve_profile() { RUNTIME_STATE_DIR=${JSON.stringify(path.join(tempDir, "state"))}; PROFILE_COMMAND_LOCK_DIR=${JSON.stringify(path.join(tempDir, "profile.command.lock"))}; RUNTIME_PORT=24567; }; resolve_runtime_owner() { RUNTIME_PID="31337"; RUNTIME_OWNERSHIP=ok; }; stop_owned_runtime() { RUNTIME_STOP_RESULT=stopped; RUNTIME_PID=""; }; remove_runtime_state_dir() { :; }; release_command`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toContain("release_runtime_stop=stopped");
    expect(stdout).toContain("release_token_cleared=yes");
    expect(stdout).toContain("release_scenario_id=none");
    expect(readFileSync(envLocalPath, "utf8")).toBe("KEEP_ME=yes\n");
  });

  it("accepts the exact tester profile marker after gateway cwd changes", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-owner-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");
    expect(scriptSource).toMatch(/"scripts\/run-node\.mjs",\s+"--profile",\s+profileId,/u);

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)} && lsof() { if [[ "$*" == *"-tiTCP:24567"* ]]; then printf '31337\\n'; else printf 'p31337\\nfcwd\\nn/tmp/jarvis-workspace\\n'; fi; } && ps() { printf '/opt/homebrew/bin/node openclaw.mjs --profile tg-live-a1b2c3d4e5 gateway run --bind loopback --port 24567 --force --allow-unconfigured\\n'; } && WORKTREE=/tmp/repo PROFILE_ID=tg-live-a1b2c3d4e5 RUNTIME_PORT=24567 resolve_runtime_owner && printf 'ownership=%s\\nworktree=%s\\n' "$RUNTIME_OWNERSHIP" "$RUNTIME_WORKTREE"`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toContain("ownership=ok");
    expect(stdout).toContain("worktree=/tmp/repo");
  });

  it("rejects a longer profile with the expected profile as a prefix", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-other-owner-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)} && lsof() { if [[ "$*" == *"-tiTCP:24567"* ]]; then printf '31337\\n'; else printf 'p31337\\nfcwd\\nn/tmp/jarvis-workspace\\n'; fi; } && ps() { printf '/opt/homebrew/bin/node openclaw.mjs --profile tg-live-a1b2c3d4e5-stale gateway run --bind loopback --port 24567 --force --allow-unconfigured\\n'; } && WORKTREE=/tmp/repo PROFILE_ID=tg-live-a1b2c3d4e5 RUNTIME_PORT=24567 resolve_runtime_owner && printf 'ownership=%s\\nworktree=%s\\n' "$RUNTIME_OWNERSHIP" "$RUNTIME_WORKTREE"`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toContain("ownership=fail");
    expect(stdout).toContain("worktree=/tmp/jarvis-workspace");
  });

  it("stages benchmark uploads under the browser upload allowlist directory", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-upload-"));
    const sourcePath = path.join(tempDir, "proof.png");
    const uploadDir = path.join(tempDir, "uploads");
    const sourceScriptPath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, "fake image", "utf8");
    writeFileSync(sourceScriptPath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourceScriptPath)} && PARITY_UPLOAD_DIR=${JSON.stringify(uploadDir)} stage_upload_command ${JSON.stringify(sourcePath)}`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toContain(`upload_path=${path.join(uploadDir, "proof.png")}`);
    expect(stdout).toContain("upload_allowed=yes");
    expect(readFileSync(path.join(uploadDir, "proof.png"), "utf8")).toBe("fake image");
  });
});
