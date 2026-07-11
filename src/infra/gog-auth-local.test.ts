import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireAuthOperationLock,
  AUTH_KEYRING_OPEN_TIMEOUT,
  classifyGoogleAuthFailure,
  DEFAULT_CONSUMER_GOOGLE_SERVICES,
  gogSubprocessEnv,
  VERIFICATION_KEYRING_OPEN_TIMEOUT,
} from "../../skills/gog/scripts/gog-auth-local.ts";

describe("gog auth local helper", () => {
  const temporaryRoots: string[] = [];

  async function temporaryRoot() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gog-auth-lock-test-"));
    temporaryRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })),
    );
  });

  it("defaults Google setup to the broad workspace surface bundle", () => {
    expect(DEFAULT_CONSUMER_GOOGLE_SERVICES).toBe("gmail,calendar,drive,contacts,docs,sheets");
  });

  it("classifies missing Google test-user access clearly", () => {
    const result = classifyGoogleAuthFailure({
      combinedText:
        "Error 403: access_denied. The developer hasn't given you access to this app. This app is in testing.",
      email: "demo@example.com",
      hasAuthUrl: true,
    });

    expect(result.diagnosticKind).toBe("oauth_test_user_missing");
    expect(result.message).toContain("demo@example.com");
    expect(result.nextStep).toContain("test user");
  });

  it("classifies disabled Google APIs clearly", () => {
    const result = classifyGoogleAuthFailure({
      combinedText:
        "Google Drive API has not been used in project 123 before or it is disabled. Enable it by visiting the Google Cloud Console.",
      email: "demo@example.com",
      hasAuthUrl: false,
    });

    expect(result.diagnosticKind).toBe("api_not_enabled");
    expect(result.nextStep).toContain("Enable");
  });

  it("classifies local callback misses after consent", () => {
    const result = classifyGoogleAuthFailure({
      combinedText: "",
      email: "demo@example.com",
      hasAuthUrl: true,
      exitedSuccessfullyWithoutVerification: true,
    });

    expect(result.diagnosticKind).toBe("callback_missed");
    expect(result.message).toContain("could not confirm the local callback");
    expect(result.nextStep).toContain("Reopen");
  });

  it("classifies keychain approval blockers clearly", () => {
    const result = classifyGoogleAuthFailure({
      combinedText: "keyring open timeout while SecurityAgent waited for approval",
      email: "demo@example.com",
      hasAuthUrl: false,
    });

    expect(result.diagnosticKind).toBe("keychain_approval_needed");
    expect(result.message).toContain("stopped safely");
    expect(result.nextStep).toContain("Unlock this Mac");
    expect(result.nextStep).toContain("Mac login password");
    expect(result.nextStep).toContain("Always Allow");
  });

  it("allows only one cross-process auth owner at a time", async () => {
    const rootDir = await temporaryRoot();
    const contenders = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        acquireAuthOperationLock({
          rootDir,
          sessionId: `session-${index}`,
          ownerPid: 10_000 + index,
          isProcessRunning: () => true,
        }),
      ),
    );

    const winners = contenders.filter((result) => result.acquired);
    const blocked = contenders.filter((result) => !result.acquired);
    expect(winners).toHaveLength(1);
    expect(blocked).toHaveLength(7);
    expect(new Set(blocked.map((result) => result.activeSessionId))).toEqual(
      new Set([winners[0]?.sessionId]),
    );
    await winners[0]?.release();
  });

  it("recovers ownership when the previous worker is stale", async () => {
    const rootDir = await temporaryRoot();
    const first = await acquireAuthOperationLock({
      rootDir,
      sessionId: "stale-session",
      ownerPid: 10_001,
      isProcessRunning: () => true,
    });
    expect(first.acquired).toBe(true);

    const recovered = await acquireAuthOperationLock({
      rootDir,
      sessionId: "replacement-session",
      ownerPid: 10_002,
      isProcessRunning: () => false,
    });
    expect(recovered.acquired).toBe(true);
    expect(recovered.acquired && recovered.sessionId).toBe("replacement-session");

    // A late release from the stale owner must not delete replacement ownership.
    if (first.acquired) {
      await first.release();
    }
    const stillBlocked = await acquireAuthOperationLock({
      rootDir,
      sessionId: "third-session",
      ownerPid: 10_003,
      isProcessRunning: () => true,
    });
    expect(stillBlocked.acquired).toBe(false);
    if (recovered.acquired) {
      await recovered.release();
    }
  });

  it("recovers a live but expired owner after its bounded auth window", async () => {
    const rootDir = await temporaryRoot();
    let now = Date.parse("2026-07-11T00:00:00.000Z");
    await acquireAuthOperationLock({
      rootDir,
      sessionId: "expired-session",
      ownerPid: 10_001,
      now: () => now,
      isProcessRunning: () => true,
      staleAfterMs: 1_000,
    });

    now += 1_001;
    const recovered = await acquireAuthOperationLock({
      rootDir,
      sessionId: "replacement-session",
      ownerPid: 10_002,
      now: () => now,
      isProcessRunning: () => true,
    });
    expect(recovered.acquired).toBe(true);
    if (recovered.acquired) {
      await recovered.release();
    }
  });

  it("sets bounded Keychain waits and preserves a deliberate override", () => {
    expect(gogSubprocessEnv("auth", {}).GOG_KEYRING_OPEN_TIMEOUT).toBe(AUTH_KEYRING_OPEN_TIMEOUT);
    expect(gogSubprocessEnv("verification", {}).GOG_KEYRING_OPEN_TIMEOUT).toBe(
      VERIFICATION_KEYRING_OPEN_TIMEOUT,
    );
    expect(
      gogSubprocessEnv("verification", { GOG_KEYRING_OPEN_TIMEOUT: " 45s " })
        .GOG_KEYRING_OPEN_TIMEOUT,
    ).toBe("45s");
    expect(
      gogSubprocessEnv("verification", { GOG_KEYRING_OPEN_TIMEOUT: "   " })
        .GOG_KEYRING_OPEN_TIMEOUT,
    ).toBe(VERIFICATION_KEYRING_OPEN_TIMEOUT);
  });
});
