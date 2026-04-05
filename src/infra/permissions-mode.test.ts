import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  applyPermissionModeToSessionEntry,
  buildPermissionModePromptHint,
  ensureDefaultPermissionModeOnSessionEntry,
  resolvePermissionDefaults,
  resolveDefaultPermissionMode,
  resolvePermissionMode,
} from "./permissions-mode.js";

describe("permissions mode", () => {
  it("defaults to full/off when config does not narrow exec", () => {
    expect(resolvePermissionDefaults()).toEqual({
      execSecurity: "full",
      execAsk: "off",
    });
    expect(resolveDefaultPermissionMode()).toBe("full");
    expect(resolvePermissionMode({})).toMatchObject({
      kind: "full",
      execSecurity: "full",
      execAsk: "off",
    });
  });

  it("maps allowlist config to normal mode", () => {
    const config = {
      tools: {
        exec: {
          security: "allowlist",
          ask: "off",
        },
      },
    } satisfies OpenClawConfig;
    expect(resolveDefaultPermissionMode({ config })).toBe("normal");
    expect(resolvePermissionMode({ config })).toMatchObject({
      kind: "normal",
      execSecurity: "allowlist",
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

  it("seeds session entries from effective config defaults only when unset", () => {
    const config = {
      tools: {
        exec: {
          security: "allowlist",
          ask: "always",
        },
      },
    } satisfies OpenClawConfig;
    const entry = { sessionId: "s1", updatedAt: 1 } satisfies SessionEntry;
    expect(ensureDefaultPermissionModeOnSessionEntry({ entry, config })).toEqual({
      updated: true,
    });
    expect(entry.execSecurity).toBe("allowlist");
    expect(entry.execAsk).toBe("always");

    expect(ensureDefaultPermissionModeOnSessionEntry({ entry, config })).toEqual({
      updated: false,
    });
  });

  it("reports custom mode for legacy non-named exec combinations", () => {
    expect(
      resolvePermissionMode({
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
    expect(buildPermissionModePromptHint({ execSecurity: "allowlist", execAsk: "off" })).toContain(
      "If a shell wrapper is blocked, try the direct command form instead of telling the user to use Terminal.",
    );
    expect(buildPermissionModePromptHint({ execSecurity: "full", execAsk: "off" })).toContain(
      "Full Permissions",
    );
  });
});
