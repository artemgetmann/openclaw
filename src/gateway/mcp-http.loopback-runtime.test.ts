import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  registerMcpLoopbackConfigOverride,
  resolveMcpLoopbackConfigOverride,
} from "./mcp-http.loopback-runtime.js";

describe("mcp loopback config overrides", () => {
  it("resolves and cleans up per token and session key", () => {
    const config = { agents: { defaults: { workspace: "/tmp/openclaw-smoke" } } } as OpenClawConfig;
    const unregister = registerMcpLoopbackConfigOverride({
      ownerToken: "owner-token",
      nonOwnerToken: "non-owner-token",
      sessionKey: "main",
      config,
    });

    expect(
      resolveMcpLoopbackConfigOverride({
        ownerToken: "owner-token",
        nonOwnerToken: "non-owner-token",
        senderIsOwner: true,
        rawSessionKey: "",
      }),
    ).toBe(config);
    expect(
      resolveMcpLoopbackConfigOverride({
        ownerToken: "owner-token",
        nonOwnerToken: "non-owner-token",
        senderIsOwner: false,
        rawSessionKey: "main",
      }),
    ).toBe(config);
    expect(
      resolveMcpLoopbackConfigOverride({
        ownerToken: "owner-token",
        nonOwnerToken: "non-owner-token",
        senderIsOwner: true,
        rawSessionKey: "other",
      }),
    ).toBeUndefined();

    unregister();

    expect(
      resolveMcpLoopbackConfigOverride({
        ownerToken: "owner-token",
        nonOwnerToken: "non-owner-token",
        senderIsOwner: true,
        rawSessionKey: "main",
      }),
    ).toBeUndefined();
  });
});
