import fs from "node:fs";
import path from "node:path";
import { GATEWAY_LAUNCH_AGENT_LABEL, normalizeGatewayProfile } from "../../daemon/constants.js";
import { resolveGatewayRuntimeIdentityEnv } from "../../daemon/service-env.js";
import type {
  GatewayService,
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
} from "../../daemon/service.js";
import { formatCliCommand } from "../command-format.js";
import { filterDaemonEnv, parsePortFromArgs } from "./shared.js";

type GatewayInstallOwnershipSnapshot = {
  entrypoint: string | null;
  workingDirectory: string | null;
  daemonEnv: Record<string, string>;
  port: number | null;
};

export type GatewayInstallOwnershipConflict = {
  message: string;
  hints: string[];
};

function resolveGatewayEntrypoint(programArguments: string[] | undefined): string | null {
  if (!programArguments?.length) {
    return null;
  }
  return (
    programArguments.find((arg) => /(^|[\\/])(dist[\\/]index\.js|openclaw\.mjs)$/.test(arg)) ?? null
  );
}

function normalizeWorkingDirectory(workingDirectory: string | undefined): string | null {
  const trimmed = workingDirectory?.trim();
  return trimmed ? trimmed : null;
}

function normalizePathForComparison(filePath: string | null | undefined): string | null {
  const trimmed = filePath?.trim();
  if (!trimmed) {
    return null;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function resolveCanonicalSharedGatewayEntrypoint(env: GatewayServiceEnv): string | null {
  const home = env.HOME?.trim() || process.env.HOME?.trim() || "";
  const explicitRoot = env.OPENCLAW_MAIN_REPO?.trim() ?? "";
  const candidates: string[] = [
    explicitRoot,
    home ? path.join(home, "Programming_Projects", "openclaw") : "",
    home ? path.join(home, "Projects", "openclaw") : "",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const entrypoint = normalizePathForComparison(path.join(candidate, "dist", "index.js"));
    if (entrypoint && fs.existsSync(entrypoint)) {
      return entrypoint;
    }
  }

  return null;
}

function resolveMacCanonicalSharedGatewayState(env: GatewayServiceEnv): {
  home: string;
  stateDir: string;
  configPath: string;
} | null {
  if (process.platform !== "darwin") {
    return null;
  }
  const home = env.HOME?.trim() || process.env.HOME?.trim() || "";
  if (!home) {
    return null;
  }
  const appHome = path.join(home, "Library", "Application Support", "OpenClaw");
  const stateDir = path.join(appHome, ".openclaw");
  return {
    home: appHome,
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
  };
}

function isPackagedConsumerGatewayEntrypoint(entrypoint: string | null): boolean {
  const normalized = normalizePathForComparison(entrypoint);
  if (!normalized) {
    return false;
  }

  // The consolidated consumer app is now allowed to own the canonical
  // ai.openclaw.gateway service. Keep this narrow so arbitrary worktrees still
  // cannot replace the shared gateway by pointing at any dist/index.js.
  const expectedSuffix = path.join(
    "Contents",
    "Resources",
    "OpenClawRuntime",
    "openclaw",
    "dist",
    "index.js",
  );
  const packagedAppNames = ["OpenClaw.app", "Jarvis.app"];
  return (
    packagedAppNames.some((appName) => normalized.includes(`${path.sep}${appName}${path.sep}`)) &&
    normalized.endsWith(expectedSuffix)
  );
}

function buildOwnershipSnapshot(args: {
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
}): GatewayInstallOwnershipSnapshot {
  const daemonEnv = resolveGatewayRuntimeIdentityEnv(args.environment ?? {});
  return {
    entrypoint: resolveGatewayEntrypoint(args.programArguments),
    workingDirectory: normalizeWorkingDirectory(args.workingDirectory),
    daemonEnv: filterDaemonEnv(daemonEnv as Record<string, string>),
    port: parsePortFromArgs(args.programArguments),
  };
}

function isDefaultSharedGatewayInstallTarget(env: GatewayServiceEnv): boolean {
  const daemonEnv = resolveGatewayRuntimeIdentityEnv(env);
  if (normalizeGatewayProfile(daemonEnv.OPENCLAW_PROFILE)) {
    return false;
  }
  const launchdLabel = daemonEnv.OPENCLAW_LAUNCHD_LABEL?.trim();
  if (
    process.platform === "darwin" &&
    launchdLabel &&
    launchdLabel !== GATEWAY_LAUNCH_AGENT_LABEL
  ) {
    return false;
  }
  return true;
}

function formatValue(value: string | number | null): string {
  return value === null ? "unset" : `${value}`;
}

function formatEnv(env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (!entries.length) {
    return "unset";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

function collectOwnershipDiffs(
  current: GatewayInstallOwnershipSnapshot,
  proposed: GatewayInstallOwnershipSnapshot,
): string[] {
  const diffs: string[] = [];
  if (current.entrypoint !== proposed.entrypoint) {
    diffs.push(
      `Current entrypoint: ${formatValue(current.entrypoint)}; requested: ${formatValue(proposed.entrypoint)}`,
    );
  }
  if (current.workingDirectory !== proposed.workingDirectory) {
    diffs.push(
      `Current working directory: ${formatValue(current.workingDirectory)}; requested: ${formatValue(proposed.workingDirectory)}`,
    );
  }
  if (current.port !== proposed.port) {
    diffs.push(
      `Current port: ${formatValue(current.port)}; requested: ${formatValue(proposed.port)}`,
    );
  }
  const currentEnv = formatEnv(current.daemonEnv);
  const proposedEnv = formatEnv(proposed.daemonEnv);
  if (currentEnv !== proposedEnv) {
    diffs.push(`Current service env: ${currentEnv}; requested: ${proposedEnv}`);
  }
  return diffs;
}

function collectCanonicalSharedGatewayStateDiffs(
  proposed: GatewayInstallOwnershipSnapshot,
  expected: { home: string; stateDir: string; configPath: string },
): string[] {
  const diffs: string[] = [];
  const proposedHome = normalizePathForComparison(proposed.daemonEnv.OPENCLAW_HOME);
  const proposedStateDir = normalizePathForComparison(proposed.daemonEnv.OPENCLAW_STATE_DIR);
  const proposedConfigPath = normalizePathForComparison(proposed.daemonEnv.OPENCLAW_CONFIG_PATH);
  const expectedHome = normalizePathForComparison(expected.home);
  const expectedStateDir = normalizePathForComparison(expected.stateDir);
  const expectedConfigPath = normalizePathForComparison(expected.configPath);

  if (proposedHome !== expectedHome) {
    diffs.push(
      `Requested OPENCLAW_HOME: ${formatValue(proposed.daemonEnv.OPENCLAW_HOME ?? null)}; expected: ${expected.home}`,
    );
  }
  if (proposedStateDir !== expectedStateDir) {
    diffs.push(
      `Requested OPENCLAW_STATE_DIR: ${formatValue(proposed.daemonEnv.OPENCLAW_STATE_DIR ?? null)}; expected: ${expected.stateDir}`,
    );
  }
  if (proposedConfigPath !== expectedConfigPath) {
    diffs.push(
      `Requested OPENCLAW_CONFIG_PATH: ${formatValue(proposed.daemonEnv.OPENCLAW_CONFIG_PATH ?? null)}; expected: ${expected.configPath}`,
    );
  }

  return diffs;
}

export async function detectSharedGatewayInstallOwnershipConflict(args: {
  env: GatewayServiceEnv;
  service: GatewayService;
  allowSharedServiceTakeover?: boolean;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
}): Promise<GatewayInstallOwnershipConflict | null> {
  if (!isDefaultSharedGatewayInstallTarget(args.env)) {
    return null;
  }

  const proposed = buildOwnershipSnapshot({
    programArguments: args.programArguments,
    workingDirectory: args.workingDirectory,
    environment: args.environment,
  });
  const canonicalEntrypoint = resolveCanonicalSharedGatewayEntrypoint(args.env);
  if (canonicalEntrypoint) {
    const requestedEntrypoint = normalizePathForComparison(proposed.entrypoint);
    if (
      requestedEntrypoint !== canonicalEntrypoint &&
      !isPackagedConsumerGatewayEntrypoint(proposed.entrypoint)
    ) {
      return {
        message:
          "Gateway install blocked: the default shared gateway service must target the canonical main runtime.",
        hints: [
          `Requested entrypoint: ${formatValue(proposed.entrypoint)}`,
          `Expected shared entrypoint: ${canonicalEntrypoint}`,
          `Run the shared-service install from ${path.dirname(path.dirname(canonicalEntrypoint))}.`,
          `For isolated runtimes, use ${formatCliCommand(
            "openclaw --profile tester gateway install",
            args.env,
          )}.`,
        ],
      };
    }
  }

  const canonicalState = resolveMacCanonicalSharedGatewayState(args.env);
  if (
    args.allowSharedServiceTakeover &&
    canonicalState &&
    !isPackagedConsumerGatewayEntrypoint(proposed.entrypoint)
  ) {
    const stateDiffs = collectCanonicalSharedGatewayStateDiffs(proposed, canonicalState);
    if (stateDiffs.length > 0) {
      return {
        message:
          "Gateway install blocked: the default shared gateway service must use the canonical app-owned config root.",
        hints: [
          ...stateDiffs,
          `Use ${formatCliCommand("pnpm openclaw gateway install", args.env)} from the main checkout, or export OPENCLAW_HOME="${canonicalState.home}" before installing.`,
          `For isolated runtimes, use ${formatCliCommand(
            "openclaw --profile tester gateway install",
            args.env,
          )}.`,
        ],
      };
    }
  }

  if (args.allowSharedServiceTakeover) {
    return null;
  }

  let currentCommand: GatewayServiceCommandConfig | null = null;
  try {
    currentCommand = await args.service.readCommand(args.env);
  } catch {
    currentCommand = null;
  }
  if (!currentCommand) {
    return null;
  }

  const current = buildOwnershipSnapshot({
    programArguments: currentCommand.programArguments,
    workingDirectory: currentCommand.workingDirectory,
    environment: currentCommand.environment,
  });
  const diffs = collectOwnershipDiffs(current, proposed);
  if (diffs.length === 0) {
    return null;
  }

  return {
    message:
      "Gateway install blocked: the default shared gateway service already belongs to another runtime/config.",
    hints: [
      ...diffs,
      `Use ${formatCliCommand(
        "openclaw --profile tester gateway install",
        args.env,
      )} for tester/consumer/rescue gateways.`,
      `If you intentionally want to replace the shared main service, rerun with ${formatCliCommand(
        "openclaw gateway install --force --allow-shared-service-takeover",
        args.env,
      )}.`,
    ],
  };
}
