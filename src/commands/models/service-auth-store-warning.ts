import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUserPath } from "../../utils.js";

const DEFAULT_SHARED_GATEWAY_LABEL = "ai.openclaw.gateway";
const AUTH_PROFILE_FILENAME = "auth-profiles.json";

type LaunchAgentEnv = {
  label: string;
  plistPath: string;
  openclawHome?: string;
  stateDir?: string;
  configPath?: string;
};

export type ServiceAuthStoreProbeWarning = {
  message: string;
  command: {
    configPath: string;
    authStorePath: string;
  };
  service: {
    label: string;
    plistPath: string;
    configPath?: string;
    authStorePath?: string;
    stateDir?: string;
  };
};

type ResolveWarningParams = {
  probe: boolean;
  agentId?: string;
  configPath: string;
  authStorePath: string;
};

type ResolveWarningDeps = {
  platform?: NodeJS.Platform;
  homedir?: () => string;
  existsSync?: (filePath: string) => boolean;
  readPlistValue?: (plistPath: string, keyPath: string) => string | undefined;
};

function normalizePathForCompare(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  return path.resolve(resolveUserPath(filePath));
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizePathForCompare(left);
  const normalizedRight = normalizePathForCompare(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function defaultReadPlistValue(plistPath: string, keyPath: string): string | undefined {
  try {
    const value = execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${keyPath}`, plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function resolveLaunchAgentEnv(deps: ResolveWarningDeps = {}): LaunchAgentEnv | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    return undefined;
  }

  const homedir = deps.homedir ?? os.homedir;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readPlistValue = deps.readPlistValue ?? defaultReadPlistValue;
  const label = DEFAULT_SHARED_GATEWAY_LABEL;
  const plistPath = path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  if (!existsSync(plistPath)) {
    return undefined;
  }

  const launchdLabel = readPlistValue(plistPath, "EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL");
  return {
    label: launchdLabel?.trim() || label,
    plistPath,
    openclawHome: readPlistValue(plistPath, "EnvironmentVariables:OPENCLAW_HOME"),
    stateDir: readPlistValue(plistPath, "EnvironmentVariables:OPENCLAW_STATE_DIR"),
    configPath: readPlistValue(plistPath, "EnvironmentVariables:OPENCLAW_CONFIG_PATH"),
  };
}

function resolveServiceStateDir(service: LaunchAgentEnv): string | undefined {
  const explicitStateDir = normalizePathForCompare(service.stateDir);
  if (explicitStateDir) {
    return explicitStateDir;
  }

  const openclawHome = normalizePathForCompare(service.openclawHome);
  if (!openclawHome) {
    return undefined;
  }
  return path.join(openclawHome, ".openclaw");
}

export function resolveServiceAuthStoreProbeWarning(
  params: ResolveWarningParams,
  deps: ResolveWarningDeps = {},
): ServiceAuthStoreProbeWarning | undefined {
  if (!params.probe) {
    return undefined;
  }

  const service = resolveLaunchAgentEnv(deps);
  if (!service) {
    return undefined;
  }

  const serviceStateDir = resolveServiceStateDir(service);
  const serviceConfigPath =
    normalizePathForCompare(service.configPath) ??
    (serviceStateDir ? path.join(serviceStateDir, "openclaw.json") : undefined);
  const serviceAuthStorePath = serviceStateDir
    ? path.join(
        serviceStateDir,
        "agents",
        params.agentId?.trim() || "main",
        "agent",
        AUTH_PROFILE_FILENAME,
      )
    : undefined;

  const configMatches = !serviceConfigPath || samePath(params.configPath, serviceConfigPath);
  const authStoreMatches =
    !serviceAuthStorePath || samePath(params.authStorePath, serviceAuthStorePath);
  if (configMatches && authStoreMatches) {
    return undefined;
  }

  return {
    message: `You are not probing the active service store. This command is probing ${params.authStorePath}; ${service.label} uses ${serviceAuthStorePath ?? "an unknown auth store"}.`,
    command: {
      configPath: params.configPath,
      authStorePath: params.authStorePath,
    },
    service: {
      label: service.label,
      plistPath: service.plistPath,
      configPath: serviceConfigPath,
      authStorePath: serviceAuthStorePath,
      stateDir: serviceStateDir,
    },
  };
}
