import { describe, expect, test } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import { validateConnectParams } from "./protocol/index.js";

function makeConnectParams(clientId: string) {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: clientId,
      version: "dev",
      platform: "ios",
      mode: GATEWAY_CLIENT_MODES.NODE,
    },
    role: "node",
    scopes: [],
    caps: ["canvas"],
    commands: ["system.notify"],
    permissions: {},
  };
}

describe("connect params client id validation", () => {
  test("accepts native app identity metadata on client connect", () => {
    const base = makeConnectParams(GATEWAY_CLIENT_IDS.MACOS_APP);
    const params = {
      ...base,
      client: {
        ...base.client,
        platform: "macOS 26.5.1",
        bundleIdentifier: "ai.jarvis.mac",
        bundlePath: "/Applications/Jarvis.app",
        executablePath: "/Applications/Jarvis.app/Contents/MacOS/OpenClaw",
      },
    };

    const ok = validateConnectParams(params);
    expect(ok).toBe(true);
    expect(validateConnectParams.errors ?? []).toHaveLength(0);
  });

  test.each([GATEWAY_CLIENT_IDS.IOS_APP, GATEWAY_CLIENT_IDS.ANDROID_APP])(
    "accepts %s as a valid gateway client id",
    (clientId) => {
      const ok = validateConnectParams(makeConnectParams(clientId));
      expect(ok).toBe(true);
      expect(validateConnectParams.errors ?? []).toHaveLength(0);
    },
  );

  test("rejects unknown client ids", () => {
    const ok = validateConnectParams(makeConnectParams("openclaw-mobile"));
    expect(ok).toBe(false);
  });
});
