import { describe, expect, it } from "vitest";
import { normalizeGatewayExposureSafety } from "./onboard-gateway-exposure.js";

describe("normalizeGatewayExposureSafety", () => {
  it("forces loopback when tailscale exposure is enabled", () => {
    const result = normalizeGatewayExposureSafety({
      bind: "lan",
      authMode: "token",
      tailscaleMode: "serve",
    });

    expect(result.bind).toBe("loopback");
    expect(result.authMode).toBe("token");
    expect(result.adjustments.bindForcedToLoopback).toBe(true);
    expect(result.adjustments.authForcedToPassword).toBe(false);
  });

  it("forces password auth for tailscale funnel", () => {
    const result = normalizeGatewayExposureSafety({
      bind: "loopback",
      authMode: "token",
      tailscaleMode: "funnel",
    });

    expect(result.bind).toBe("loopback");
    expect(result.authMode).toBe("password");
    expect(result.adjustments.bindForcedToLoopback).toBe(false);
    expect(result.adjustments.authForcedToPassword).toBe(true);
  });

  it("clears custom bind host when a custom bind is forced back to loopback", () => {
    const result = normalizeGatewayExposureSafety({
      bind: "custom",
      customBindHost: "192.168.1.20",
      authMode: "token",
      tailscaleMode: "serve",
    });

    expect(result.bind).toBe("loopback");
    expect(result.customBindHost).toBeUndefined();
  });
});
