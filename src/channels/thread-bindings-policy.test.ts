import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy.js";

describe("resolveThreadBindingSpawnPolicy", () => {
  it("enables unified thread-bound session spawns by default", () => {
    expect(
      resolveThreadBindingSpawnPolicy({
        cfg: {} as OpenClawConfig,
        channel: "discord",
        kind: "subagent",
      }),
    ).toMatchObject({
      enabled: true,
      spawnEnabled: true,
    });
  });

  it("uses spawnSessions for subagent and ACP spawn policy", () => {
    const cfg = {
      channels: {
        discord: {
          threadBindings: {
            spawnSessions: false,
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "discord",
        kind: "subagent",
      }).spawnEnabled,
    ).toBe(false);
    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "discord",
        kind: "acp",
      }).spawnEnabled,
    ).toBe(false);
  });

  it("keeps legacy split keys as compatibility overrides", () => {
    const cfg = {
      channels: {
        discord: {
          threadBindings: {
            spawnSessions: true,
            spawnAcpSessions: false,
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "discord",
        kind: "subagent",
      }).spawnEnabled,
    ).toBe(true);
    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "discord",
        kind: "acp",
      }).spawnEnabled,
    ).toBe(false);
  });

  it("lets account config override channel spawnSessions", () => {
    const cfg = {
      channels: {
        telegram: {
          threadBindings: {
            spawnSessions: false,
          },
          accounts: {
            work: {
              threadBindings: {
                spawnSessions: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "telegram",
        accountId: "work",
        kind: "acp",
      }).spawnEnabled,
    ).toBe(true);
  });
});
