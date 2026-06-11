import { describe, expect, it } from "vitest";
import { resolveServiceAuthStoreProbeWarning } from "./service-auth-store-warning.js";

const home = "/Users/tester";
const plistPath = `${home}/Library/LaunchAgents/ai.openclaw.gateway.plist`;
const appStateDir = `${home}/Library/Application Support/OpenClaw/.openclaw`;
const appConfigPath = `${appStateDir}/openclaw.json`;
const appAuthStorePath = `${appStateDir}/agents/main/agent/auth-profiles.json`;

function createDeps(values: Record<string, string | undefined>) {
  return {
    platform: "darwin" as const,
    homedir: () => home,
    existsSync: (filePath: string) => filePath === plistPath,
    readPlistValue: (_filePath: string, keyPath: string) => values[keyPath],
  };
}

describe("resolveServiceAuthStoreProbeWarning", () => {
  it("warns when a probe targets the default CLI store while the LaunchAgent uses app state", () => {
    const warning = resolveServiceAuthStoreProbeWarning(
      {
        probe: true,
        configPath: `${home}/.openclaw/openclaw.json`,
        authStorePath: `${home}/.openclaw/agents/main/agent/auth-profiles.json`,
      },
      createDeps({
        "EnvironmentVariables:OPENCLAW_HOME": `${home}/Library/Application Support/OpenClaw`,
        "EnvironmentVariables:OPENCLAW_STATE_DIR": appStateDir,
        "EnvironmentVariables:OPENCLAW_CONFIG_PATH": appConfigPath,
      }),
    );

    expect(warning?.message).toContain("You are not probing the active service store");
    expect(warning?.command.authStorePath).toBe(
      `${home}/.openclaw/agents/main/agent/auth-profiles.json`,
    );
    expect(warning?.service.authStorePath).toBe(appAuthStorePath);
    expect(warning?.service.configPath).toBe(appConfigPath);
  });

  it("stays quiet when the command probes the same store as the LaunchAgent", () => {
    const warning = resolveServiceAuthStoreProbeWarning(
      {
        probe: true,
        configPath: appConfigPath,
        authStorePath: appAuthStorePath,
      },
      createDeps({
        "EnvironmentVariables:OPENCLAW_STATE_DIR": appStateDir,
        "EnvironmentVariables:OPENCLAW_CONFIG_PATH": appConfigPath,
      }),
    );

    expect(warning).toBeUndefined();
  });

  it("does not warn for status output without --probe", () => {
    const warning = resolveServiceAuthStoreProbeWarning(
      {
        probe: false,
        configPath: `${home}/.openclaw/openclaw.json`,
        authStorePath: `${home}/.openclaw/agents/main/agent/auth-profiles.json`,
      },
      createDeps({
        "EnvironmentVariables:OPENCLAW_STATE_DIR": appStateDir,
        "EnvironmentVariables:OPENCLAW_CONFIG_PATH": appConfigPath,
      }),
    );

    expect(warning).toBeUndefined();
  });
});
