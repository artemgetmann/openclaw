import { describe, expect, it, vi } from "vitest";
import { disableActiveCronJob, setActiveCronJobDisabler } from "./active-runtime.js";

describe("active cron runtime", () => {
  it("routes an exact disable through the Gateway-owned scheduler seam", async () => {
    const disable = vi.fn(async () => {});
    const release = setActiveCronJobDisabler(disable);

    await disableActiveCronJob(" cron-monitor ");

    expect(disable).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledWith("cron-monitor");
    release();
    await expect(disableActiveCronJob("cron-monitor")).rejects.toThrow(
      "active Gateway cron service is unavailable",
    );
  });

  it("shares the Gateway seam across independently evaluated module copies", async () => {
    // Production emits Gateway and plugin entrypoints as separate bundles. A
    // module reset models that split: the publisher and consumer do not share
    // module-local state, but they do share the process-global symbol registry.
    vi.resetModules();
    const gatewayBundleCopy = await import("./active-runtime.js");
    const disable = vi.fn(async () => {});
    const release = gatewayBundleCopy.setActiveCronJobDisabler(disable);

    vi.resetModules();
    const codexBundleCopy = await import("./active-runtime.js");
    await codexBundleCopy.disableActiveCronJob(" bundled-monitor ");

    expect(disable).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledWith("bundled-monitor");
    release();
  });

  it("does not let an old publisher clear a replacement scheduler", async () => {
    const firstDisable = vi.fn(async () => {});
    const secondDisable = vi.fn(async () => {});
    const releaseFirst = setActiveCronJobDisabler(firstDisable);
    const releaseSecond = setActiveCronJobDisabler(secondDisable);

    releaseFirst();
    await disableActiveCronJob("replacement-monitor");

    expect(firstDisable).not.toHaveBeenCalled();
    expect(secondDisable).toHaveBeenCalledWith("replacement-monitor");
    releaseSecond();
  });
});
