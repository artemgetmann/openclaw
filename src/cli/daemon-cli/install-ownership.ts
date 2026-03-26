import { GATEWAY_LAUNCH_AGENT_LABEL, normalizeGatewayProfile } from "../../daemon/constants.js";
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

function buildOwnershipSnapshot(args: {
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
}): GatewayInstallOwnershipSnapshot {
  return {
    entrypoint: resolveGatewayEntrypoint(args.programArguments),
    workingDirectory: normalizeWorkingDirectory(args.workingDirectory),
    daemonEnv: filterDaemonEnv(args.environment as Record<string, string> | undefined),
    port: parsePortFromArgs(args.programArguments),
  };
}

function isDefaultSharedGatewayInstallTarget(env: GatewayServiceEnv): boolean {
  if (normalizeGatewayProfile(env.OPENCLAW_PROFILE)) {
    return false;
  }
  const launchdLabel = env.OPENCLAW_LAUNCHD_LABEL?.trim();
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

export async function detectSharedGatewayInstallOwnershipConflict(args: {
  env: GatewayServiceEnv;
  service: GatewayService;
  allowSharedServiceTakeover?: boolean;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
}): Promise<GatewayInstallOwnershipConflict | null> {
  if (args.allowSharedServiceTakeover || !isDefaultSharedGatewayInstallTarget(args.env)) {
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
  const proposed = buildOwnershipSnapshot({
    programArguments: args.programArguments,
    workingDirectory: args.workingDirectory,
    environment: args.environment,
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
