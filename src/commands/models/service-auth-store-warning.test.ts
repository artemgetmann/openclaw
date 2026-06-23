import { describe, expect, it } from "vitest";
import { resolveServiceAuthStoreProbeWarning } from "./service-auth-store-warning.js";

const home = "/Users/tester";
const plistPath = `${home}/Library/LaunchAgents/ai.openclaw.gateway.plist`;
const jarvisPlistPath = `${home}/Library/LaunchAgents/ai.jarvis.gateway.plist`;
const appStateDir = `${home}/Library/Application Support/OpenClaw/.openclaw`;
const appConfigPath = `${appStateDir}/openclaw.json`;
const appAuthStorePath = `${appStateDir}/agents/main/agent/auth-profiles.json`;

function createDeps(
  values: Record<string, string | undefined>,
  options: {
    env?: NodeJS.ProcessEnv;
    plistPaths?: string[];
    valuesByPlist?: Record<string, Record<string, string | undefined>>;
  } = {},
) {
  const plistPaths = options.plistPaths ?? [plistPath];
  return {
    platform: "darwin" as const,
    homedir: () => home,
    env: options.env,
    existsSync: (filePath: string) => plistPaths.includes(filePath),
    readPlistValue: (filePath: string, keyPath: string) =>
      options.valuesByPlist?.[filePath]?.[keyPath] ?? values[keyPath],
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

  it("uses the configured Jarvis LaunchAgent label before the default OpenClaw label", () => {
    const jarvisStateDir = `${home}/Library/Application Support/Jarvis/.jarvis`;
    const jarvisConfigPath = `${jarvisStateDir}/openclaw.json`;
    const jarvisAuthStorePath = `${jarvisStateDir}/agents/main/agent/auth-profiles.json`;

    const warning = resolveServiceAuthStoreProbeWarning(
      {
        probe: true,
        configPath: appConfigPath,
        authStorePath: appAuthStorePath,
      },
      createDeps(
        {},
        {
          env: { OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway" },
          plistPaths: [jarvisPlistPath, plistPath],
          valuesByPlist: {
            [jarvisPlistPath]: {
              "EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL": "ai.jarvis.gateway",
              "EnvironmentVariables:OPENCLAW_STATE_DIR": jarvisStateDir,
              "EnvironmentVariables:OPENCLAW_CONFIG_PATH": jarvisConfigPath,
            },
            [plistPath]: {
              "EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL": "ai.openclaw.gateway",
              "EnvironmentVariables:OPENCLAW_STATE_DIR": appStateDir,
              "EnvironmentVariables:OPENCLAW_CONFIG_PATH": appConfigPath,
            },
          },
        },
      ),
    );

    expect(warning?.service.label).toBe("ai.jarvis.gateway");
    expect(warning?.service.plistPath).toBe(jarvisPlistPath);
    expect(warning?.service.authStorePath).toBe(jarvisAuthStorePath);
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
