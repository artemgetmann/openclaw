import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import { resolveSnapshotPlan } from "./agent.snapshot.plan.js";

describe("resolveSnapshotPlan", () => {
  it("defaults existing-session snapshots to ai when format is omitted", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        user: { driver: "existing-session", attachOnly: true, color: "#00AA00" },
      },
    });
    const profile = resolveProfile(resolved, "user");
    expect(profile).toBeTruthy();
    expect(profile?.driver).toBe("existing-session");

    const plan = resolveSnapshotPlan({
      profile: profile as NonNullable<typeof profile>,
      query: {},
      hasPlaywright: true,
    });

    expect(plan.format).toBe("ai");
  });

  it("keeps ai snapshots for managed browsers when Playwright is available", () => {
    const resolved = resolveBrowserConfig({});
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile).toBeTruthy();

    const plan = resolveSnapshotPlan({
      profile: profile as NonNullable<typeof profile>,
      query: {},
      hasPlaywright: true,
    });

    expect(plan.format).toBe("ai");
  });

  it("normalizes labels/mode requests away from aria snapshots", () => {
    const resolved = resolveBrowserConfig({});
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile).toBeTruthy();

    const plan = resolveSnapshotPlan({
      profile: profile as NonNullable<typeof profile>,
      query: { format: "aria", mode: "efficient", labels: "1" },
      hasPlaywright: true,
    });

    expect(plan.format).toBe("ai");
    expect(plan.mode).toBe("efficient");
    expect(plan.labels).toBe(true);
  });
});
