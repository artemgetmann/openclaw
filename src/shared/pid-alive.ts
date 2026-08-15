import { spawnSync } from "node:child_process";
import fsSync from "node:fs";

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Check if a process is a zombie on Linux by reading /proc/<pid>/status.
 * Returns false on non-Linux platforms or if the proc file can't be read.
 */
function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (isZombieProcess(pid)) {
    return false;
  }
  return true;
}

/**
 * Read a stable process-generation timestamp for Linux or macOS.
 * Linux exposes clock ticks in /proc; macOS exposes a long-form birth time
 * through ps. The values are opaque identities and are only compared when the
 * platform and PID are unchanged.
 *
 * This is used to detect PID recycling: if two readings for the same PID
 * return different starttimes, the PID has been reused by a different process.
 */
export function getProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  if (process.platform === "darwin") {
    // Fix the locale and timezone so the ps timestamp parses identically in
    // every packaged Jarvis environment. A failed lookup stays conservative:
    // callers preserve rather than reclaim an owner they cannot identify.
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 1_000,
    });
    const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
    const startedAtMs = startedAt ? Date.parse(`${startedAt} UTC`) : Number.NaN;
    return Number.isInteger(startedAtMs) && startedAtMs >= 0 ? startedAtMs : null;
  }
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) {
      return null;
    }
    // The comm field (field 2) is wrapped in parens and can contain spaces,
    // so split after the last ")" to get fields 3..N reliably.
    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    // field 22 (starttime) = index 19 after the comm-split (field 3 is index 0).
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}
