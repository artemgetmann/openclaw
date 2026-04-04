import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  applyPermissionModeToSessionEntry,
  buildPermissionModePromptHint,
  ensureDefaultPermissionModeOnSessionEntry,
  resolveDefaultPermissionMode,
  resolvePermissionMode,
} from "./permissions-mode.js";

describe("permissions mode", () => {
  it("defaults Telegram chats to normal mode", () => {
    expect(resolveDefaultPermissionMode({ channel: "telegram" })).toBe("normal");
    expect(resolvePermissionMode({ channel: "telegram" })).toMatchObject({
      kind: "normal",
      execSecurity: "allowlist",
      execAsk: "off",
    });
  });

  it("keeps non-Telegram chats on the broader existing default", () => {
    expect(resolveDefaultPermissionMode({ channel: "discord" })).toBe("full");
    expect(resolvePermissionMode({ channel: "discord" })).toMatchObject({
      kind: "full",
      execSecurity: "full",
      execAsk: "off",
    });
  });

  it("applies named permission modes onto session exec fields", () => {
    const entry = { sessionId: "s1", updatedAt: 1 } satisfies SessionEntry;
    expect(applyPermissionModeToSessionEntry(entry, "normal")).toEqual({ updated: true });
    expect(entry.execSecurity).toBe("allowlist");
    expect(entry.execAsk).toBe("off");

    expect(applyPermissionModeToSessionEntry(entry, "full")).toEqual({ updated: true });
    expect(entry.execSecurity).toBe("full");
    expect(entry.execAsk).toBe("off");
  });

  it("seeds Telegram session entries with normal mode only when unset", () => {
    const entry = { sessionId: "s1", updatedAt: 1 } satisfies SessionEntry;
    expect(ensureDefaultPermissionModeOnSessionEntry({ entry, channel: "telegram" })).toEqual({
      updated: true,
    });
    expect(entry.execSecurity).toBe("allowlist");
    expect(entry.execAsk).toBe("off");

    expect(ensureDefaultPermissionModeOnSessionEntry({ entry, channel: "telegram" })).toEqual({
      updated: false,
    });
  });

  it("reports custom mode for legacy non-named exec combinations", () => {
    expect(
      resolvePermissionMode({
        channel: "telegram",
        execSecurity: "allowlist",
        execAsk: "always",
      }),
    ).toMatchObject({
      kind: "custom",
      execSecurity: "allowlist",
      execAsk: "always",
    });
  });

  it("builds prompt guidance that explicitly steers away from Terminal detours", () => {
    expect(buildPermissionModePromptHint({ channel: "telegram" })).toContain(
      "If a shell wrapper is blocked, try the direct command form instead of telling the user to use Terminal.",
    );
    expect(
      buildPermissionModePromptHint({ channel: "telegram", execSecurity: "full", execAsk: "off" }),
    ).toContain("Full Permissions");
  });
});
