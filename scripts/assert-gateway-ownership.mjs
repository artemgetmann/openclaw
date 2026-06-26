#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

function usage() {
  console.log(`Usage: node scripts/assert-gateway-ownership.mjs [options]

Read-only ownership assertion for a gateway runtime. This command never installs,
restarts, bootouts, or takes over a LaunchAgent.

Options:
  --expect-label <label>       Expected LaunchAgent label.
  --expect-port <port>         Expected gateway port.
  --expect-state-dir <path>    Expected OPENCLAW_STATE_DIR from service env.
  --expect-config-path <path>  Expected OPENCLAW_CONFIG_PATH from service env.
  --expect-home <path>         Expected OPENCLAW_HOME from service env.
  --status-cmd <command>       Status command. Default: pnpm openclaw:local gateway status --deep --require-rpc --json
  -h, --help                   Show help.
`);
}

function parseArgs(argv) {
  const result = {
    statusCmd: ["pnpm", "openclaw:local", "gateway", "status", "--deep", "--require-rpc", "--json"],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (arg === "--status-cmd") {
      if (!next) {
        throw new Error("--status-cmd requires a value");
      }
      result.statusCmd = next.split(/\s+/).filter(Boolean);
      index += 1;
      continue;
    }
    const key = {
      "--expect-label": "expectLabel",
      "--expect-port": "expectPort",
      "--expect-state-dir": "expectStateDir",
      "--expect-config-path": "expectConfigPath",
      "--expect-home": "expectHome",
    }[arg];
    if (!key) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (!next) {
      throw new Error(`${arg} requires a value`);
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function extractLastJsonObject(output) {
  for (const line of output.trim().split(/\n/).toReversed()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      // Status commands can print diagnostics before JSON. Keep scanning.
    }
  }
  throw new Error("gateway status did not print a parseable JSON object");
}

function normalizePathValue(value) {
  return typeof value === "string" && value.trim() ? path.resolve(value) : undefined;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Math.trunc(Number(value));
    }
  }
  return undefined;
}

function readServiceEnv(status) {
  return status?.service?.command?.environment ?? {};
}

function readListenerCount(status) {
  const candidates = [
    status?.gateway?.listeners,
    status?.portUsage?.listeners,
    status?.port?.listeners,
    status?.listeners,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
  }
  return undefined;
}

function check(status, args) {
  const failures = [];
  const serviceEnv = readServiceEnv(status);
  const loaded = status?.service?.loaded === true || status?.service?.runtime?.status === "running";
  if (!loaded) {
    failures.push("LaunchAgent is not loaded/running");
  }
  if (status?.rpc?.ok !== true) {
    failures.push(`RPC probe failed: ${status?.rpc?.error ?? "unknown"}`);
  }
  if (status?.canonicalDefaultGateway?.missing) {
    failures.push(status.canonicalDefaultGateway.reason ?? "canonical default gateway missing");
  }
  if (status?.portMismatch) {
    failures.push(`port/config mismatch: ${(status.portMismatch.issues ?? []).join("; ")}`);
  }
  if (args.expectLabel) {
    const actualLabel =
      serviceEnv.OPENCLAW_LAUNCHD_LABEL ?? status?.service?.launchdLabel ?? status?.service?.label;
    if (actualLabel !== args.expectLabel) {
      failures.push(
        `LaunchAgent label mismatch: expected ${args.expectLabel}, got ${actualLabel ?? "missing"}`,
      );
    }
  }
  if (args.expectPort) {
    const expectedPort = firstNumber(args.expectPort);
    const actualPort = firstNumber(
      serviceEnv.OPENCLAW_GATEWAY_PORT,
      status?.gateway?.port,
      status?.portUsage?.port,
    );
    if (actualPort !== expectedPort) {
      failures.push(`port mismatch: expected ${expectedPort}, got ${actualPort ?? "missing"}`);
    }
  }
  for (const [label, expectedRaw, actualRaw] of [
    ["OPENCLAW_HOME", args.expectHome, serviceEnv.OPENCLAW_HOME],
    ["OPENCLAW_STATE_DIR", args.expectStateDir, serviceEnv.OPENCLAW_STATE_DIR],
    ["OPENCLAW_CONFIG_PATH", args.expectConfigPath, serviceEnv.OPENCLAW_CONFIG_PATH],
  ]) {
    if (!expectedRaw) {
      continue;
    }
    const expected = normalizePathValue(expectedRaw);
    const actual = normalizePathValue(actualRaw);
    if (actual !== expected) {
      failures.push(`${label} mismatch: expected ${expected}, got ${actual ?? "missing"}`);
    }
  }
  const listenerCount = readListenerCount(status);
  if (listenerCount != null && listenerCount !== 1) {
    failures.push(`expected exactly one listener, got ${listenerCount}`);
  }
  return failures;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const [cmd, ...cmdArgs] = args.statusCmd;
  const proc = spawnSync(cmd, cmdArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf-8",
  });
  const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  if (proc.status !== 0) {
    process.stderr.write(output);
    throw new Error(`status command failed with exit code ${proc.status}`);
  }
  const status = extractLastJsonObject(output);
  const failures = check(status, args);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${failure}`);
    }
    process.exit(1);
  }
  console.log("gateway_ownership=ok");
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
