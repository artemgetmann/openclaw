import { describe, expect, it, vi } from "vitest";
import { disableActiveCronJob, setActiveCronJobDisabler } from "./active-runtime.js";

describe("active cron runtime", () => {
  it("routes an exact disable through the Gateway-owned scheduler seam", async () => {
    const disable = vi.fn(async () => {});
    setActiveCronJobDisabler(disable);

    await disableActiveCronJob(" cron-monitor ");

    expect(disable).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledWith("cron-monitor");
  });
});
