import os from "node:os";
import path from "node:path";
import { PUBLIC_JARVIS_GATEWAY_LAUNCHD_LABEL } from "../consumer/runtime-identity.js";
import { readLaunchAgentProgramArgumentsFromFile } from "../daemon/launchd-plist.js";

const runtimeEnvKeys = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_LOG_DIR",
  "OPENCLAW_PROFILE",
  "OPENCLAW_LAUNCHD_LABEL",
] as const;

type DiscoveryDeps = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  readLaunchAgent?: typeof readLaunchAgentProgramArgumentsFromFile;
};

/**
 * Makes packaged Jarvis state visible before the Telegram backend is imported.
 * The backend resolves its default paths at module load, so this intentionally
 * runs at the CLI boundary and copies only known, non-secret runtime selectors.
 */
export async function discoverTelegramUserRuntimeEnv(deps: DiscoveryDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if ((deps.platform ?? process.platform) !== "darwin") {
    return false;
  }

  // Any explicit runtime selection is authoritative. Mixing a caller's profile
  // or state path with packaged defaults could silently target the wrong account.
  if (runtimeEnvKeys.some((key) => env[key]?.trim()) || env.CLAWDBOT_STATE_DIR?.trim()) {
    return false;
  }

  const homedir = deps.homedir ?? os.homedir;
  const plistPath = path.join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${PUBLIC_JARVIS_GATEWAY_LAUNCHD_LABEL}.plist`,
  );
  const launchAgent = await (deps.readLaunchAgent ?? readLaunchAgentProgramArgumentsFromFile)(
    plistPath,
  );
  const discovered = launchAgent?.environment;
  if (
    discovered?.OPENCLAW_LAUNCHD_LABEL?.trim() !== PUBLIC_JARVIS_GATEWAY_LAUNCHD_LABEL ||
    !discovered.OPENCLAW_STATE_DIR?.trim() ||
    !discovered.OPENCLAW_CONFIG_PATH?.trim()
  ) {
    return false;
  }

  for (const key of runtimeEnvKeys) {
    const value = discovered[key]?.trim();
    if (value) {
      env[key] = value;
    }
  }
  return true;
}
