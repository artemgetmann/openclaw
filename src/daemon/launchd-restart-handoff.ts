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
  cancel?: () => boolean;
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

function buildLeaseOwnerScript(): string {
  return `wrapper="$1"
lifecycle_command="$2"
label="$3"
receipt_dir="$4"
shift 4
set +e
"$wrapper" --policy gateway-lifecycle --label "$label" -- "$lifecycle_command" handoff "$@"
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

async function waitForLeaseAdmission(params: {
  receiptDir: string;
  childPid: number | undefined;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const readyPath = path.join(params.receiptDir, "ready");
  const failedPath = path.join(params.receiptDir, "failed");
  const deadline = Date.now() + (params.timeoutMs ?? 15_000);

  // Callers must not report a scheduled restart until the detached owner has
  // atomically acquired the machine lease. Yield between receipt probes so a
  // running gateway keeps serving timers, connections, and stop signals while
  // another owner is being inspected.
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
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
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

function cancelAdmittedHandoff(receiptDir: string): boolean {
  const cancelPath = path.join(receiptDir, "cancel");
  const cancelTmp = `${cancelPath}.tmp.${process.pid}`;
  try {
    // The UID-private receipt directory is shared only with the exact detached
    // owner. Atomic publication avoids a PID signal/reuse race while giving the
    // waiting helper a durable superseding-stop instruction.
    fssync.writeFileSync(cancelTmp, "stop superseded restart\n", { mode: 0o600 });
    fssync.renameSync(cancelTmp, cancelPath);
    return true;
  } catch {
    try {
      fssync.rmSync(cancelTmp);
    } catch {
      // Preserve the original failure result.
    }
    return false;
  }
}

export async function scheduleDetachedLaunchdRestartHandoff(params: {
  env?: Record<string, string | undefined>;
  mode: LaunchdRestartHandoffMode;
  delayMs?: number;
  waitForPid?: number;
}): Promise<LaunchdRestartHandoffResult> {
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
  let waitForPidStart = "";
  if (waitForPid > 1) {
    const resolvedStart = resolveProcessStartIdentity(waitForPid);
    if (!resolvedStart) {
      return {
        ok: false,
        detail: "could not prove restart caller PID/start identity",
      };
    }
    waitForPidStart = resolvedStart;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  let receiptDir: string | undefined;
  try {
    // Keep the UID in the mkdtemp prefix so the shell owner can reject a
    // receipt path for another account. Build the trusted prefix separately:
    // runtime paths must never interpolate untrusted data directly inside a
    // tmpdir join, even though this value is numeric and process-derived.
    const receiptPrefix = `openclaw-gateway-lifecycle-${uid}-`;
    const createdReceiptDir = fssync.mkdtempSync(path.join(os.tmpdir(), receiptPrefix));
    receiptDir = createdReceiptDir;
    fssync.chmodSync(createdReceiptDir, 0o700);
    const childEnv = { ...process.env, ...params.env };
    // A detached owner must acquire its own lease. If it inherited the
    // caller's capability, ancestry would validate temporarily but the caller
    // could release that lease before the delayed launchctl mutation.
    delete childEnv.OPENCLAW_HEAVY_LOCAL_SLOT_LEASE_TOKEN;
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        buildLeaseOwnerScript(),
        "openclaw-launchd-restart-lease-owner",
        leasePaths.wrapper,
        leasePaths.commandHelper,
        `gateway-restart-handoff:${target.label}`,
        createdReceiptDir,
        params.mode,
        target.serviceTarget,
        target.domain,
        target.plistPath,
        String(waitForPid),
        String(delayMs),
        createdReceiptDir,
        waitForPidStart,
        leasePaths.helper,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: childEnv,
      },
    );
    const admission = await waitForLeaseAdmission({
      receiptDir: createdReceiptDir,
      childPid: child.pid,
    });
    if (!admission.ok) {
      cleanupFailedReceipt(createdReceiptDir);
      return { ok: false, detail: admission.detail };
    }
    child.unref();
    return {
      ok: true,
      pid: child.pid ?? undefined,
      cancel: () => cancelAdmittedHandoff(createdReceiptDir),
    };
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
