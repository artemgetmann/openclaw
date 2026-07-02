import { describe, expect, it } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "./protocol/client-info.js";
import type { GatewayWsClient } from "./server/ws-types.js";

describe("NodeRegistry", () => {
  it("preserves native app identity metadata for connected nodes", () => {
    const registry = new NodeRegistry();
    registry.register(
      {
        connId: "conn-1",
        socket: {} as GatewayWsClient["socket"],
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: GATEWAY_CLIENT_NAMES.MACOS_APP,
            displayName: "JetBook",
            version: "2026.3.16",
            platform: "macOS 26.5.1",
            mode: GATEWAY_CLIENT_MODES.NODE,
            bundleIdentifier: "ai.jarvis.mac",
            bundlePath: "/Applications/Jarvis.app",
            executablePath: "/Applications/Jarvis.app/Contents/MacOS/OpenClaw",
          },
          role: "node",
          scopes: [],
          caps: ["screen"],
          commands: [],
          permissions: { screenRecording: false },
        },
      },
      {},
    );

    expect(registry.listConnected()[0]).toMatchObject({
      bundleIdentifier: "ai.jarvis.mac",
      bundlePath: "/Applications/Jarvis.app",
      executablePath: "/Applications/Jarvis.app/Contents/MacOS/OpenClaw",
    });
  });
});
