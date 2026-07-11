import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverTelegramUserRuntimeEnv } from "./runtime-env.js";

const home = "/Users/test";
const jarvisHome = path.join(home, "Library", "Application Support", "Jarvis");
const jarvisState = path.join(jarvisHome, ".jarvis");
const packagedEnvironment = {
  OPENCLAW_HOME: jarvisHome,
  OPENCLAW_STATE_DIR: jarvisState,
  OPENCLAW_CONFIG_PATH: path.join(jarvisState, "openclaw.json"),
  OPENCLAW_LOG_DIR: path.join(jarvisState, "logs"),
  OPENCLAW_PROFILE: "consumer",
  OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway",
  TELEGRAM_API_HASH: "must-not-be-copied",
};

describe("discoverTelegramUserRuntimeEnv", () => {
  it("discovers packaged Jarvis from the user LaunchAgent independent of cwd", async () => {
    const env: NodeJS.ProcessEnv = {};
    const readLaunchAgent = vi.fn().mockResolvedValue({
      programArguments: ["/Applications/Jarvis.app/Contents/MacOS/openclaw"],
      environment: packagedEnvironment,
    });

    await expect(
      discoverTelegramUserRuntimeEnv({
        env,
        homedir: () => home,
        platform: "darwin",
        readLaunchAgent,
      }),
    ).resolves.toBe(true);

    expect(readLaunchAgent).toHaveBeenCalledWith(
      path.join(home, "Library", "LaunchAgents", "ai.jarvis.gateway.plist"),
    );
    expect(env).toMatchObject({
      OPENCLAW_HOME: jarvisHome,
      OPENCLAW_STATE_DIR: jarvisState,
      OPENCLAW_PROFILE: "consumer",
    });
    expect(env.TELEGRAM_API_HASH).toBeUndefined();
  });

  it.each(["OPENCLAW_STATE_DIR", "OPENCLAW_PROFILE", "CLAWDBOT_STATE_DIR"] as const)(
    "preserves explicit %s and skips packaged discovery",
    async (key) => {
      const env: NodeJS.ProcessEnv = { [key]: "/explicit/runtime" };
      const readLaunchAgent = vi.fn();

      await expect(
        discoverTelegramUserRuntimeEnv({
          env,
          homedir: () => home,
          platform: "darwin",
          readLaunchAgent,
        }),
      ).resolves.toBe(false);

      expect(readLaunchAgent).not.toHaveBeenCalled();
      expect(env).toEqual({ [key]: "/explicit/runtime" });
    },
  );

  it("rejects a plist that does not self-identify as packaged Jarvis", async () => {
    const env: NodeJS.ProcessEnv = {};
    const readLaunchAgent = vi.fn().mockResolvedValue({
      programArguments: ["openclaw"],
      environment: { ...packagedEnvironment, OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" },
    });

    await expect(
      discoverTelegramUserRuntimeEnv({
        env,
        homedir: () => home,
        platform: "darwin",
        readLaunchAgent,
      }),
    ).resolves.toBe(false);
    expect(env).toEqual({});
  });

  it("rejects incomplete packaged runtime metadata", async () => {
    const env: NodeJS.ProcessEnv = {};
    const readLaunchAgent = vi.fn().mockResolvedValue({
      programArguments: ["openclaw"],
      environment: { OPENCLAW_LAUNCHD_LABEL: "ai.jarvis.gateway" },
    });

    await expect(
      discoverTelegramUserRuntimeEnv({
        env,
        homedir: () => home,
        platform: "darwin",
        readLaunchAgent,
      }),
    ).resolves.toBe(false);
    expect(env).toEqual({});
  });
});
