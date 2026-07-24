import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn(),
  readQwenCliCredentialsCached: vi.fn(() => null),
  readMiniMaxCliCredentialsCached: vi.fn(() => null),
}));

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
  readQwenCliCredentialsCached: mocks.readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached: mocks.readMiniMaxCliCredentialsCached,
}));

const { syncExternalCliCredentials } = await import("./auth-profiles/external-cli-sync.js");
const { CODEX_CLI_PROFILE_ID } = await import("./auth-profiles/constants.js");

const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";

describe("syncExternalCliCredentials", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("syncs Codex CLI credentials into the supported default auth profile", () => {
    const expires = Date.now() + 60_000;
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires,
      accountId: "acct_123",
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {},
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMs: expect.any(Number) }),
    );
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires,
      accountId: "acct_123",
    });
    expect(store.profiles[CODEX_CLI_PROFILE_ID]).toBeUndefined();
  });

  it("replaces a stale copied Codex profile with fresher live CLI credentials", () => {
    const copiedExpires = Date.now() + 60_000;
    const cliExpires = Date.now() + 10 * 60_000;
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-cli-access",
      refresh: "fresh-cli-refresh",
      expires: cliExpires,
      accountId: "acct_123",
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-copied-access",
          refresh: "stale-copied-refresh",
          expires: copiedExpires,
        },
      },
    };
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];

    try {
      const mutated = syncExternalCliCredentials(store);

      expect(mutated).toBe(true);
      expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalled();
      expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
        expires: cliExpires,
        accountId: "acct_123",
      });
      const printed = consoleSpies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .join("\n");
      expect(printed).not.toContain("fresh-cli-access");
      expect(printed).not.toContain("fresh-cli-refresh");
      expect(printed).not.toContain("stale-copied-refresh");
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });

  it("does not replace a locally rotated Codex credential with stale CLI state", () => {
    const sharedExpires = Date.now() + 60 * 60_000;
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "stale-cli-access",
      refresh: "stale-cli-refresh",
      expires: sharedExpires,
      accountId: "acct_123",
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          type: "oauth",
          provider: "openai-codex",
          access: "jarvis-rotated-access",
          refresh: "jarvis-rotated-refresh",
          expires: sharedExpires,
          accountId: "acct_123",
        },
      },
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(false);
    expect(mocks.readCodexCliCredentialsCached).not.toHaveBeenCalled();
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      access: "jarvis-rotated-access",
      refresh: "jarvis-rotated-refresh",
      expires: sharedExpires,
      accountId: "acct_123",
    });
  });

  it("does not recover a stale Codex profile from a different external account", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "other-account-access",
      refresh: "other-account-refresh",
      expires: Date.now() + 10 * 60_000,
      accountId: "acct_other",
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [OPENAI_CODEX_DEFAULT_PROFILE_ID]: {
          type: "oauth",
          provider: "openai-codex",
          access: "local-near-expiry-access",
          refresh: "local-near-expiry-refresh",
          expires: Date.now() + 60_000,
          accountId: "acct_local",
        },
      },
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(false);
    expect(mocks.readCodexCliCredentialsCached).toHaveBeenCalled();
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      access: "local-near-expiry-access",
      refresh: "local-near-expiry-refresh",
      accountId: "acct_local",
    });
  });
});
