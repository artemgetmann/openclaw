import { describe, expect, it } from "vitest";
import { resolveGatewaySidecarStartupPolicy } from "./server-startup.js";

describe("resolveGatewaySidecarStartupPolicy", () => {
  it("keeps browser control enabled for consumer minimal startup", () => {
    const policy = resolveGatewaySidecarStartupPolicy({
      OPENCLAW_CONSUMER_MINIMAL_STARTUP: "1",
    });

    expect(policy.consumerMinimalStartup).toBe(true);
    expect(policy.skipBrowserControl).toBe(false);
    expect(policy.skipSessionLockCleanup).toBe(true);
    expect(policy.skipGmailWatcher).toBe(true);
    expect(policy.skipInternalHookLoading).toBe(true);
    expect(policy.skipPluginServices).toBe(true);
    expect(policy.skipMemoryBackendStartup).toBe(true);
  });

  it("still respects an explicit browser-control skip override", () => {
    const policy = resolveGatewaySidecarStartupPolicy({
      OPENCLAW_CONSUMER_MINIMAL_STARTUP: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    });

    expect(policy.skipBrowserControl).toBe(true);
  });
});
