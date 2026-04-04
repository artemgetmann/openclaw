import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const { handlePermissionsCommand } = await import("./commands-session.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("/permissions", () => {
  it("shows the default Telegram chat mode as Normal", async () => {
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      channel: "telegram",
    } satisfies SessionEntry;
    const sessionStore = { "agent:main:main": sessionEntry };
    const result = await handlePermissionsCommand(
      {
        ...buildCommandTestParams("/permissions", baseCfg, {
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
        }),
        sessionEntry,
        sessionStore,
      },
      true,
    );

    expect(result?.reply?.text).toContain("Permissions: Normal");
    expect(result?.reply?.text).toContain("Direct commands are allowed");
  });

  it("switches the current chat to Full Permissions", async () => {
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      channel: "telegram",
      execSecurity: "allowlist",
      execAsk: "off",
    } satisfies SessionEntry;
    const sessionStore = { "agent:main:main": sessionEntry };
    const result = await handlePermissionsCommand(
      {
        ...buildCommandTestParams("/permissions full", baseCfg, {
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
        }),
        sessionEntry,
        sessionStore,
      },
      true,
    );

    expect(sessionEntry.execSecurity).toBe("full");
    expect(sessionEntry.execAsk).toBe("off");
    expect(result?.reply?.text).toContain("Permissions set to Full Permissions");
  });

  it("reports custom mode when legacy exec settings do not match named modes", async () => {
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      channel: "telegram",
      execSecurity: "allowlist",
      execAsk: "always",
    } satisfies SessionEntry;
    const sessionStore = { "agent:main:main": sessionEntry };
    const result = await handlePermissionsCommand(
      {
        ...buildCommandTestParams("/permissions", baseCfg, {
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
        }),
        sessionEntry,
        sessionStore,
      },
      true,
    );

    expect(result?.reply?.text).toContain("Permissions: Custom");
    expect(result?.reply?.text).toContain("security=allowlist ask=always");
  });
});
