import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("persists a dedicated hook secret only for the monitor-listener opt-in", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-hooks-"));
    const sourcePath = path.join(tempDir, "runtime-source.sh");
    const baseConfigPath = path.join(tempDir, "base.json");
    const helperPath = path.join(
      process.cwd(),
      "scripts",
      "lib",
      "telegram-live-runtime-helpers.mjs",
    );
    writeFileSync(sourcePath, readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n"));
    writeFileSync(baseConfigPath, "{}\n");

    const prepare = (stateDir: string, enabled: boolean) =>
      execFileSync(
        BASH_BIN,
        [
          "--noprofile",
          "--norc",
          "-lc",
          `source ${JSON.stringify(sourcePath)}; RUNTIME_STATE_DIR=${JSON.stringify(stateDir)}; BASE_CONFIG_PATH=${JSON.stringify(baseConfigPath)}; ASSIGNED_BOT_TOKEN=tester-token; RUNTIME_PORT=24567; HELPER_MODULE=${JSON.stringify(helperPath)}; OPENCLAW_TELEGRAM_LIVE_ENABLE_MONITOR_LISTENER=${enabled ? "1" : "0"} prepare_isolated_runtime_config`,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

    const defaultDir = path.join(tempDir, "default");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      path.join(defaultDir, "openclaw.telegram-live.json"),
      `${JSON.stringify({
        gateway: { auth: { token: "gateway-default" } },
        hooks: { enabled: true, token: "manual-hook" },
      })}\n`,
    );
    expect(prepare(defaultDir, false)).not.toContain("manual-hook");
    const defaultConfig = JSON.parse(
      readFileSync(path.join(defaultDir, "openclaw.telegram-live.json"), "utf8"),
    );
    expect(defaultConfig.hooks).toBeUndefined();

    const enabledDir = path.join(tempDir, "enabled");
    mkdirSync(enabledDir, { recursive: true });
    writeFileSync(
      path.join(enabledDir, "openclaw.telegram-live.json"),
      `${JSON.stringify({
        gateway: { auth: { token: "gateway-opt-in" } },
        hooks: { enabled: true, token: "listener-secret" },
      })}\n`,
    );
    expect(prepare(enabledDir, true)).not.toContain("listener-secret");
    const enabledConfig = JSON.parse(
      readFileSync(path.join(enabledDir, "openclaw.telegram-live.json"), "utf8"),
    );
    expect(enabledConfig.hooks).toEqual({
      enabled: true,
      path: "/hooks",
      token: "listener-secret",
    });
    expect(enabledConfig.hooks.token).not.toBe(enabledConfig.gateway.auth.token);
  });

  it("requires the exact isolated owner and health record for listener readiness", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-listener-owner-"));
    const laneDir = path.join(tempDir, "lane with spaces");
    mkdirSync(laneDir, { recursive: true });
    const sourcePath = path.join(tempDir, "runtime-source.sh");
    const ownerPath = path.join(tempDir, "owner.json");
    const healthPath = path.join(tempDir, "listener-health.json");
    const profile = "tg-live-a1b2c3d4e5";
    const cronStore = path.join(laneDir, "cron", "jobs.json");
    const monitorStore = path.join(laneDir, "cron", "monitors.json");
    const cursorStore = path.join(laneDir, "cron", "telegram-user-listener-cursors.json");
    const envFile = path.join(laneDir, "telegram user", ".env.local");
    const session = path.join(laneDir, "telegram user", "owner.session");
    const hookUrl = "http://127.0.0.1:24567/hooks/telegram-user-monitor-event";
    const executable = "/usr/local/bin/node";
    const birthIdentity = "Mon Jul 27 07:00:00 2026";
    const instanceId = "a".repeat(48);
    const argv = [
      "openclaw.mjs",
      "--profile",
      profile,
      "telegram-user",
      "monitor-poll",
      "--watch",
      "--poll-interval-ms",
      "1000",
      "--cron-store",
      cronStore,
      "--monitor-store",
      monitorStore,
      "--cursor-store",
      cursorStore,
      "--hook-url",
      hookUrl,
      "--env-file",
      envFile,
      "--session",
      session,
      "--json",
    ];
    const expectedCommand = `${executable} ${argv.join(" ")}`;
    writeFileSync(sourcePath, readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n"));
    writeFileSync(
      ownerPath,
      `${JSON.stringify({
        version: 2,
        pid: 31337,
        birthIdentity,
        instanceId,
        executable,
        argv,
        cwd: laneDir,
        profileId: profile,
        worktree: laneDir,
        cronStorePath: cronStore,
        monitorStorePath: monitorStore,
        cursorStorePath: cursorStore,
        envFile,
        session,
        hookUrl,
      })}\n`,
    );
    writeFileSync(
      healthPath,
      `${JSON.stringify({
        records: {
          "telegram-user": {
            owner: { pid: 31337, profile, instanceId },
            lastSuccessfulCheckAtMs: Date.now(),
            pollIntervalMs: 1000,
            state: "healthy",
          },
        },
      })}\n`,
    );
    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; kill() { [[ "$1" == "-0" && "$2" == "31337" ]]; }; ps() { if [[ "$*" == *"lstart="* ]]; then printf '%s\\n' ${JSON.stringify(birthIdentity)}; elif [[ "$*" == *"eww"* ]]; then printf '%s %s\\n' 'openclaw-telegram-user' ${JSON.stringify(`OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE=${instanceId}`)}; else printf '%s\\n' 'openclaw-telegram-user'; fi; }; lsof() { printf 'p31337\\nfcwd\\nn%s\\n' ${JSON.stringify(laneDir)}; }; PROFILE_ID=${profile}; WORKTREE=${JSON.stringify(laneDir)}; RUNTIME_PORT=24567; MONITOR_LISTENER_OWNER_PATH=${JSON.stringify(ownerPath)}; MONITOR_LISTENER_HEALTH_STORE_PATH=${JSON.stringify(healthPath)}; MONITOR_LISTENER_CRON_STORE_PATH=${JSON.stringify(cronStore)}; MONITOR_LISTENER_MONITOR_STORE_PATH=${JSON.stringify(monitorStore)}; MONITOR_LISTENER_CURSOR_STORE_PATH=${JSON.stringify(cursorStore)}; resolve_monitor_listener_owner; probe_monitor_listener_health; printf 'ownership=%s\\nhealth=%s\\n' "$MONITOR_LISTENER_OWNERSHIP" "$MONITOR_LISTENER_HEALTH"`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(stdout).toBe("ownership=ok\nhealth=ok\n");

    const missingMarkerHealth = JSON.parse(readFileSync(healthPath, "utf8"));
    delete missingMarkerHealth.records["telegram-user"].owner.instanceId;
    writeFileSync(healthPath, `${JSON.stringify(missingMarkerHealth)}\n`);
    const missingMarkerStdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; kill() { [[ "$1" == "-0" && "$2" == "31337" ]]; }; ps() { if [[ "$*" == *"lstart="* ]]; then printf '%s\\n' ${JSON.stringify(birthIdentity)}; else printf '%s\\n' ${JSON.stringify(expectedCommand)}; fi; }; lsof() { printf 'p31337\\nfcwd\\nn%s\\n' ${JSON.stringify(laneDir)}; }; PROFILE_ID=${profile}; WORKTREE=${JSON.stringify(laneDir)}; RUNTIME_PORT=24567; MONITOR_LISTENER_OWNER_PATH=${JSON.stringify(ownerPath)}; MONITOR_LISTENER_CRON_STORE_PATH=${JSON.stringify(cronStore)}; MONITOR_LISTENER_MONITOR_STORE_PATH=${JSON.stringify(monitorStore)}; MONITOR_LISTENER_CURSOR_STORE_PATH=${JSON.stringify(cursorStore)}; resolve_monitor_listener_owner; printf '%s\\n' "$MONITOR_LISTENER_OWNERSHIP"`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(missingMarkerStdout).toBe("foreign-process\n");

    const sharedHealth = JSON.parse(readFileSync(healthPath, "utf8"));
    sharedHealth.records["telegram-user"].owner.pid = 99999;
    sharedHealth.records["telegram-user"].owner.instanceId = instanceId;
    writeFileSync(healthPath, `${JSON.stringify(sharedHealth)}\n`);
    const sharedStdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; kill() { [[ "$1" == "-0" && "$2" == "31337" ]]; }; ps() { if [[ "$*" == *"lstart="* ]]; then printf '%s\\n' ${JSON.stringify(birthIdentity)}; elif [[ "$*" == *"eww"* ]]; then printf '%s %s\\n' ${JSON.stringify(expectedCommand)} ${JSON.stringify(`OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE=${instanceId}`)}; else printf '%s\\n' ${JSON.stringify(expectedCommand)}; fi; }; lsof() { printf 'p31337\\nfcwd\\nn%s\\n' ${JSON.stringify(laneDir)}; }; PROFILE_ID=${profile}; WORKTREE=${JSON.stringify(laneDir)}; RUNTIME_PORT=24567; MONITOR_LISTENER_OWNER_PATH=${JSON.stringify(ownerPath)}; MONITOR_LISTENER_HEALTH_STORE_PATH=${JSON.stringify(healthPath)}; MONITOR_LISTENER_CRON_STORE_PATH=${JSON.stringify(cronStore)}; MONITOR_LISTENER_MONITOR_STORE_PATH=${JSON.stringify(monitorStore)}; MONITOR_LISTENER_CURSOR_STORE_PATH=${JSON.stringify(cursorStore)}; resolve_monitor_listener_owner; probe_monitor_listener_health; printf '%s\\n' "$MONITOR_LISTENER_HEALTH"`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(sharedStdout).toBe("fail\n");
  });

  it("terminates the exact marked child when owner publish or birth capture fails", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-listener-rollback-"));
    const repoRoot = path.join(tempDir, "repo");
    const sourcePath = path.join(tempDir, "runtime-source.sh");
    const helperPath = path.join(tempDir, "helper.mjs");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(sourcePath, readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n"));
    writeFileSync(
      path.join(repoRoot, "openclaw.mjs"),
      'import fs from "node:fs"; fs.writeFileSync(process.env.LISTENER_TEST_PID_PATH, String(process.pid)); setInterval(() => {}, 1000);\n',
    );
    writeFileSync(
      helperPath,
      `export function buildTelegramLiveRuntimeChildEnv({ parentEnv }) { return { ...parentEnv, OPENCLAW_TELEGRAM_USER_ENV_FILE: ${JSON.stringify(path.join(tempDir, "telegram.env"))}, OPENCLAW_TELEGRAM_USER_SESSION: ${JSON.stringify(path.join(tempDir, "telegram.session"))} }; }\n`,
    );
    writeFileSync(path.join(tempDir, "telegram.env"), "");
    writeFileSync(path.join(tempDir, "telegram.session"), "");

    const verifyRollback = (label: string, failureEnv: NodeJS.ProcessEnv) => {
      const stateDir = path.join(tempDir, label);
      const pidPath = path.join(tempDir, `${label}.pid`);
      const ownerPath = path.join(stateDir, "listener.owner.json");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, "openclaw.telegram-live.json"),
        `${JSON.stringify({ hooks: { enabled: true, token: "dedicated-secret" } })}\n`,
      );
      execFileSync(
        BASH_BIN,
        [
          "--noprofile",
          "--norc",
          "-lc",
          `source ${JSON.stringify(sourcePath)}; REPO_ROOT=${JSON.stringify(repoRoot)}; WORKTREE=${JSON.stringify(repoRoot)}; PROFILE_ID=tg-live-rollback; RUNTIME_STATE_DIR=${JSON.stringify(stateDir)}; RUNTIME_CONFIG_PATH=${JSON.stringify(path.join(stateDir, "openclaw.telegram-live.json"))}; RUNTIME_PORT=24567; MONITOR_LISTENER_CRON_STORE_PATH=${JSON.stringify(path.join(stateDir, "cron/jobs.json"))}; MONITOR_LISTENER_MONITOR_STORE_PATH=${JSON.stringify(path.join(stateDir, "cron/monitors.json"))}; MONITOR_LISTENER_CURSOR_STORE_PATH=${JSON.stringify(path.join(stateDir, "cron/cursors.json"))}; MONITOR_LISTENER_OWNER_PATH=${JSON.stringify(ownerPath)}; MONITOR_LISTENER_HEALTH_STORE_PATH=${JSON.stringify(path.join(stateDir, "cron/listener-health.json"))}; MONITOR_LISTENER_LOG_PATH=${JSON.stringify(path.join(stateDir, "listener.log"))}; HELPER_MODULE=${JSON.stringify(helperPath)}; start_isolated_monitor_listener`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            LISTENER_TEST_PID_PATH: pidPath,
            ...failureEnv,
          },
        },
      );

      const childPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(existsSync(ownerPath)).toBe(false);
    };

    verifyRollback("owner-write", {
      OPENCLAW_TELEGRAM_LIVE_TEST_FAIL_LISTENER_OWNER_WRITE: "1",
    });
    verifyRollback("missing-lstart", {
      OPENCLAW_TELEGRAM_LIVE_TEST_FORCE_LISTENER_LSTART_MISSING: "1",
    });
  });

  it("cleans up a newly spawned listener when readiness times out", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-listener-timeout-"));
    const sourcePath = path.join(tempDir, "runtime-source.sh");
    writeFileSync(sourcePath, readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n"));
    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; started=0; resolve_monitor_listener_owner() { if [[ "$started" == "1" ]]; then MONITOR_LISTENER_PID=31337; MONITOR_LISTENER_OWNERSHIP=ok; else MONITOR_LISTENER_PID=""; MONITOR_LISTENER_OWNERSHIP=missing; fi; }; probe_monitor_listener_health() { MONITOR_LISTENER_HEALTH=fail; }; start_isolated_monitor_listener() { started=1; MONITOR_LISTENER_START_ACTION=started; }; stop_owned_monitor_listener() { printf 'cleanup=%s\\n' "$MONITOR_LISTENER_PID"; MONITOR_LISTENER_STOP_RESULT=stopped; started=0; }; sleep() { :; }; MONITOR_LISTENER_ENABLED=yes; RUNTIME_OWNERSHIP=ok; RUNTIME_HEALTH=ok; OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_TIMEOUT_SECS=1; ensure_isolated_monitor_listener || true`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(stdout).toBe("cleanup=31337\n");
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
    expect(stdout).not.toContain("monitor_listener_instance");
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

  it("stops only the listener child bound to the exact isolated ownership record", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-listener-release-"));
    const sourcePath = path.join(tempDir, "runtime-source.sh");
    const ownerPath = path.join(tempDir, "owner.json");
    const healthPath = path.join(tempDir, "health.json");
    const killLog = path.join(tempDir, "kills.log");
    const birthCheckLog = path.join(tempDir, "birth-checks.log");
    const executable = "/usr/local/bin/node";
    const profile = "tg-live-exact";
    const birthIdentity = "Mon Jul 27 07:00:00 2026";
    const instanceId = "b".repeat(48);
    const cronStore = path.join(tempDir, "cron/jobs.json");
    const monitorStore = path.join(tempDir, "cron/monitors.json");
    const cursorStore = path.join(tempDir, "cron/cursors.json");
    const hookUrl = "http://127.0.0.1:24567/hooks/telegram-user-monitor-event";
    const envFile = path.join(tempDir, "telegram.env");
    const session = path.join(tempDir, "telegram.session");
    const argv = [
      "openclaw.mjs",
      "--profile",
      profile,
      "telegram-user",
      "monitor-poll",
      "--watch",
      "--cron-store",
      cronStore,
      "--monitor-store",
      monitorStore,
      "--cursor-store",
      cursorStore,
      "--hook-url",
      hookUrl,
      "--env-file",
      envFile,
      "--session",
      session,
    ];
    const expectedCommand = `${executable} ${argv.join(" ")}`;
    writeFileSync(sourcePath, readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n"));
    const writeOwner = (profileId: string) =>
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          version: 2,
          pid: 31337,
          birthIdentity,
          instanceId,
          executable,
          argv,
          cwd: tempDir,
          profileId,
          worktree: tempDir,
          cronStorePath: cronStore,
          monitorStorePath: monitorStore,
          cursorStorePath: cursorStore,
          hookUrl,
          envFile,
          session,
        })}\n`,
      );
    const writeHealth = () =>
      writeFileSync(
        healthPath,
        `${JSON.stringify({
          records: {
            "telegram-user": {
              owner: { pid: 31337, profile, instanceId },
            },
          },
        })}\n`,
      );
    writeOwner(profile);
    writeHealth();
    const common = `PROFILE_ID=${profile}; WORKTREE=${JSON.stringify(tempDir)}; RUNTIME_PORT=24567; MONITOR_LISTENER_OWNER_PATH=${JSON.stringify(ownerPath)}; MONITOR_LISTENER_HEALTH_STORE_PATH=${JSON.stringify(healthPath)}; MONITOR_LISTENER_CRON_STORE_PATH=${JSON.stringify(cronStore)}; MONITOR_LISTENER_MONITOR_STORE_PATH=${JSON.stringify(monitorStore)}; MONITOR_LISTENER_CURSOR_STORE_PATH=${JSON.stringify(cursorStore)}`;
    const exactStdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; alive=1; kill() { if [[ "$1" == "-0" ]]; then [[ "$alive" == "1" ]]; else printf '%s\\n' "$1" >> ${JSON.stringify(killLog)}; alive=0; fi; }; ps() { if [[ "$*" == *"lstart="* ]]; then printf '%s\\n' ${JSON.stringify(birthIdentity)}; elif [[ "$*" == *"eww"* ]]; then printf '%s %s\\n' ${JSON.stringify(expectedCommand)} ${JSON.stringify(`OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE=${instanceId}`)}; else printf '%s\\n' ${JSON.stringify(expectedCommand)}; fi; }; lsof() { printf 'p31337\\nfcwd\\nn%s\\n' ${JSON.stringify(tempDir)}; }; ${common}; stop_owned_monitor_listener; printf '%s\\n' "$MONITOR_LISTENER_STOP_RESULT"`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(exactStdout).toBe("stopped\n");
    expect(readFileSync(killLog, "utf8")).toBe("31337\n");

    writeOwner(profile);
    writeHealth();
    const reusedStdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; kill() { if [[ "$1" == "-0" ]]; then return 0; fi; printf 'unsafe\\n' >> ${JSON.stringify(killLog)}; }; ps() { if [[ "$*" == *"lstart="* ]]; then printf 'x\\n' >> ${JSON.stringify(birthCheckLog)}; if [[ "$(wc -l < ${JSON.stringify(birthCheckLog)})" -eq 1 ]]; then printf '%s\\n' ${JSON.stringify(birthIdentity)}; else printf '%s\\n' 'Mon Jul 27 07:00:01 2026'; fi; elif [[ "$*" == *"eww"* ]]; then printf '%s %s\\n' ${JSON.stringify(expectedCommand)} ${JSON.stringify(`OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE=${instanceId}`)}; else printf '%s\\n' ${JSON.stringify(expectedCommand)}; fi; }; lsof() { printf 'p31337\\nfcwd\\nn%s\\n' ${JSON.stringify(tempDir)}; }; ${common}; stop_owned_monitor_listener; printf '%s\\n' "$MONITOR_LISTENER_STOP_RESULT"`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(reusedStdout).toBe("identity-changed\n");
    expect(readFileSync(killLog, "utf8")).toBe("31337\n");

    writeOwner("tg-live-other");
    const foreignStdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)}; kill() { if [[ "$1" == "-0" ]]; then return 0; fi; printf 'unsafe\\n' >> ${JSON.stringify(killLog)}; }; ${common}; stop_owned_monitor_listener; printf '%s\\n' "$MONITOR_LISTENER_STOP_RESULT"`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(foreignStdout).toBe("not-owned\n");
    expect(readFileSync(killLog, "utf8")).toBe("31337\n");
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
