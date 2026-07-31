import { spawn, spawnSync } from "node:child_process";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE,
  resolveGatewayLifecycleLeasePaths,
} from "../infra/gateway-lifecycle-lease.js";
import { resolveGatewayLaunchAgentLabel } from "./constants.js";

export type LaunchdRestartHandoffMode = "kickstart" | "start-after-exit";

export type LaunchdRestartHandoffResult = {
  ok: boolean;
  pid?: number;
  detail?: string;
};

export type LaunchdRestartTarget = {
  domain: string;
  label: string;
  plistPath: string;
  serviceTarget: string;
};

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

function resolveLaunchAgentLabel(env?: Record<string, string | undefined>): string {
  const envLabel = env?.OPENCLAW_LAUNCHD_LABEL?.trim();
  if (envLabel) {
    return envLabel;
  }
  return resolveGatewayLaunchAgentLabel(env?.OPENCLAW_PROFILE);
}

export function resolveLaunchdRestartTarget(
  env: Record<string, string | undefined> = process.env,
): LaunchdRestartTarget {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const home = env.HOME?.trim() || os.homedir();
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  return {
    domain,
    label,
    plistPath,
    serviceTarget: `${domain}/${label}`,
  };
}

export function isCurrentProcessLaunchdServiceLabel(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  readLaunchdState: (serviceTarget: string) => string | null = (serviceTarget) => {
    const result = spawnSync("launchctl", ["print", serviceTarget], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout : null;
  },
): boolean {
  const launchdLabel =
    env.LAUNCH_JOB_LABEL?.trim() || env.LAUNCH_JOB_NAME?.trim() || env.XPC_SERVICE_NAME?.trim();
  const configuredLabel = env.OPENCLAW_LAUNCHD_LABEL?.trim();
  const matchingMarker =
    (launchdLabel && launchdLabel === label) || (configuredLabel && configuredLabel === label);
  if (!matchingMarker) {
    return false;
  }

  const serviceTarget = `${resolveGuiDomain()}/${label}`;
  const launchdState = readLaunchdState(serviceTarget);
  const pidMatch = launchdState?.match(/^\s*pid\s*=\s*([1-9][0-9]*)\s*$/m);
  if (!pidMatch) {
    // A matching launchd marker without readable owner state is ambiguous. The
    // conservative detached path may refuse, but it cannot kill the caller.
    return true;
  }
  return Number.parseInt(pidMatch[1] ?? "", 10) === process.pid;
}

function buildLaunchdRestartScript(mode: LaunchdRestartHandoffMode): string {
  const publishAdmission = `receipt_dir="$6"
ready_path="$receipt_dir/ready"
ack_path="$receipt_dir/ack"
ready_tmp="$receipt_dir/ready.tmp.$$"
umask 077
printf 'admitted\\n' >"$ready_tmp"
/bin/mv "$ready_tmp" "$ready_path"
cleanup_receipt() {
  /bin/rm -f "$ready_path" "$ready_tmp" "$ack_path"
  /bin/rmdir "$receipt_dir" 2>/dev/null || true
}
trap cleanup_receipt EXIT
# Mutation starts only after the caller observes admission. Without this
# acknowledgment, a fast handoff could delete the ready receipt between polls and
# make a completed launchctl mutation look like a lease refusal.
while [ ! -f "$ack_path" ]; do
  ack_wait_count=$((\${ack_wait_count:-0} + 1))
  if [ "$ack_wait_count" -ge 800 ]; then
    # A killed caller cannot acknowledge admission. Bound the lease lifetime
    # to 20 seconds instead of pinning every machine-wide lifecycle owner.
    exit ${GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE}
  fi
  sleep 0.025
done
`;
  const waitForDelay = `delay_ms="$5"
if [ -n "$delay_ms" ] && [ "$delay_ms" -gt 0 ] 2>/dev/null; then
  delay_seconds=$((delay_ms / 1000))
  delay_millis=$((delay_ms % 1000))
  sleep "\${delay_seconds}.$(printf '%03d' "$delay_millis")"
fi
`;
  const waitForCallerPid = `wait_pid="$4"
if [ -n "$wait_pid" ] && [ "$wait_pid" -gt 1 ] 2>/dev/null; then
  wait_pid_start="$7"
  lifecycle_helper="$8"
  # Bare PID liveness is ambiguous after PID reuse. The canonical helper
  # distinguishes the original live identity, proven exit, and ambiguity.
  . "$lifecycle_helper"
  wait_pid_count=0
  while true; do
    if openclaw_heavy_local_slot_owner_is_live "$wait_pid" "$wait_pid_start"; then
      wait_pid_count=$((wait_pid_count + 1))
      [ "$wait_pid_count" -lt 300 ] ||
        exit ${GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE}
      sleep 0.1
      continue
    else
      wait_status=$?
    fi
    [ "$wait_status" -eq 1 ] && break
    exit ${GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE}
  done
fi
`;

  if (mode === "kickstart") {
    return `${publishAdmission}
service_target="$1"
domain="$2"
plist_path="$3"
${waitForDelay}
${waitForCallerPid}
if ! launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
  }

  return `${publishAdmission}
service_target="$1"
domain="$2"
plist_path="$3"
${waitForDelay}
${waitForCallerPid}
if ! launchctl start "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl start "$service_target" >/dev/null 2>&1 || launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  else
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
}

function resolveProcessStartIdentity(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.status !== 0) {
    return null;
  }
  const start = result.stdout.trim().replace(/\s+/g, " ");
  return start || null;
}

function buildLeaseOwnerScript(handoffScript: string): string {
  return `wrapper="$1"
label="$2"
receipt_dir="$3"
shift 3
set +e
"$wrapper" --policy gateway-lifecycle --label "$label" -- /bin/sh -c '${handoffScript.replaceAll("'", "'\\''")}' openclaw-launchd-restart-handoff "$@"
status=$?
if [ -d "$receipt_dir" ] && [ ! -f "$receipt_dir/ready" ]; then
  failed_tmp="$receipt_dir/failed.tmp.$$"
  printf '%s\\n' "$status" >"$failed_tmp"
  /bin/mv "$failed_tmp" "$receipt_dir/failed"
fi
exit "$status"
`;
}

function terminateUnadmittedLeaseOwner(childPid: number | undefined): void {
  if (!childPid || childPid <= 1) {
    return;
  }
  try {
    // The exact child we spawned is a detached process-group leader. Callers
    // use this only before acknowledging `ready`, so launchd mutation has not
    // begun and a late admission can still be prevented safely.
    process.kill(-childPid, "SIGTERM");
  } catch {
    // It may already have exited between receipt inspection and signaling.
  }
}

function waitForLeaseAdmission(params: {
  receiptDir: string;
  childPid: number | undefined;
  timeoutMs?: number;
}): { ok: true } | { ok: false; detail: string } {
  const readyPath = path.join(params.receiptDir, "ready");
  const failedPath = path.join(params.receiptDir, "failed");
  const deadline = Date.now() + (params.timeoutMs ?? 15_000);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  // This function is intentionally synchronous: callers must not report a
  // scheduled restart until the detached owner has atomically acquired the
  // machine lease. The child does all expensive waiting outside this process;
  // polling only observes its private admission receipt.
  while (Date.now() < deadline) {
    if (fssync.existsSync(readyPath)) {
      try {
        const ackPath = path.join(params.receiptDir, "ack");
        const ackTmp = `${ackPath}.tmp.${process.pid}`;
        fssync.writeFileSync(ackTmp, "observed\n", { mode: 0o600 });
        fssync.renameSync(ackTmp, ackPath);
        return { ok: true };
      } catch {
        terminateUnadmittedLeaseOwner(params.childPid);
        return { ok: false, detail: "could not acknowledge gateway lifecycle lease admission" };
      }
    }
    if (fssync.existsSync(failedPath)) {
      const status = fssync.readFileSync(failedPath, "utf8").trim();
      return {
        ok: false,
        detail: `machine-wide gateway lifecycle lease unavailable (exit ${status || GATEWAY_LIFECYCLE_TEMPORARY_UNAVAILABLE_EXIT_CODE})`,
      };
    }
    Atomics.wait(sleeper, 0, 0, 25);
  }

  terminateUnadmittedLeaseOwner(params.childPid);
  return { ok: false, detail: "timed out acquiring machine-wide gateway lifecycle lease" };
}

function cleanupFailedReceipt(receiptDir: string): void {
  let names: string[] = [];
  try {
    names = fssync.readdirSync(receiptDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (
      name !== "ready" &&
      name !== "ack" &&
      name !== "failed" &&
      !name.startsWith("ready.tmp.") &&
      !name.startsWith("ack.tmp.") &&
      !name.startsWith("failed.tmp.")
    ) {
      continue;
    }
    try {
      fssync.rmSync(path.join(receiptDir, name));
    } catch {
      // The detached owner may have already cleaned its private receipt.
    }
  }
  try {
    fssync.rmdirSync(receiptDir);
  } catch {
    // A live admitted owner removes the directory after mutation completes.
  }
}

export function scheduleDetachedLaunchdRestartHandoff(params: {
  env?: Record<string, string | undefined>;
  mode: LaunchdRestartHandoffMode;
  delayMs?: number;
  waitForPid?: number;
}): LaunchdRestartHandoffResult {
  const target = resolveLaunchdRestartTarget(params.env);
  const leasePaths = resolveGatewayLifecycleLeasePaths();
  if (!leasePaths) {
    return {
      ok: false,
      detail: "packaged machine-wide lifecycle lease helpers are missing",
    };
  }
  const delayMs =
    typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
      ? Math.max(0, Math.floor(params.delayMs))
      : 0;
  const waitForPid =
    typeof params.waitForPid === "number" && Number.isFinite(params.waitForPid)
      ? Math.floor(params.waitForPid)
      : 0;
  const waitForPidStart = waitForPid > 1 ? resolveProcessStartIdentity(waitForPid) : "";
  if (waitForPid > 1 && !waitForPidStart) {
    return {
      ok: false,
      detail: "could not prove restart caller PID/start identity",
    };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  let receiptDir: string | undefined;
  try {
    receiptDir = fssync.mkdtempSync(path.join(os.tmpdir(), `openclaw-gateway-lifecycle-${uid}-`));
    fssync.chmodSync(receiptDir, 0o700);
    const handoffScript = buildLaunchdRestartScript(params.mode);
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        buildLeaseOwnerScript(handoffScript),
        "openclaw-launchd-restart-lease-owner",
        leasePaths.wrapper,
        `gateway-restart-handoff:${target.label}`,
        receiptDir,
        target.serviceTarget,
        target.domain,
        target.plistPath,
        String(waitForPid),
        String(delayMs),
        receiptDir,
        waitForPidStart,
        leasePaths.helper,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...params.env },
      },
    );
    const admission = waitForLeaseAdmission({ receiptDir, childPid: child.pid });
    if (!admission.ok) {
      cleanupFailedReceipt(receiptDir);
      return { ok: false, detail: admission.detail };
    }
    child.unref();
    return { ok: true, pid: child.pid ?? undefined };
  } catch (err) {
    if (receiptDir) {
      cleanupFailedReceipt(receiptDir);
    }
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
