import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_KEYRING_OPEN_TIMEOUT,
  classifyGoogleAuthFailure,
  DEFAULT_CONSUMER_GOOGLE_SERVICES,
  gogSubprocessEnv,
  spawnWithAuthOperationLock,
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

  it("keeps Keychain timeout evidence ahead of the missing-verification fallback", () => {
    const result = classifyGoogleAuthFailure({
      combinedText: "keyring open timeout while waiting for macOS Keychain interaction",
      email: "demo@example.com",
      hasAuthUrl: true,
      exitedSuccessfullyWithoutVerification: true,
    });

    expect(result.diagnosticKind).toBe("keychain_approval_needed");
    expect(result.nextStep).toContain("Always Allow");
    expect(result.nextStep).not.toContain("Reopen");
  });

  it.runIf(process.platform === "darwin")(
    "keeps one stable lock inode across contention and crashed-owner recovery",
    async () => {
      const rootDir = await temporaryRoot();
      const lockPath = path.join(rootDir, "active-auth.lock");
      const holder = spawnWithAuthOperationLock({
        lockPath,
        command: "/bin/sh",
        args: ["-c", 'printf "ready\\n"; while :; do sleep 1; done'],
        options: { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      });
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.stdout?.once("data", () => resolve());
      });
      const originalInode = (await fsp.stat(lockPath)).ino;

      const contender = spawnWithAuthOperationLock({
        lockPath,
        command: "/usr/bin/true",
        args: [],
        options: { stdio: "ignore" },
      });
      const contenderCode = await new Promise<number | null>((resolve) => {
        contender.once("close", resolve);
      });
      expect(contenderCode).toBe(75);
      expect((await fsp.stat(lockPath)).ino).toBe(originalInode);

      // A forced process-group exit models a stale/crashed auth worker. lockf
      // releases in the kernel; no observer renames or deletes the pathname.
      const holderClosed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
      expect(holder.pid).toBeTypeOf("number");
      process.kill(-(holder.pid ?? 0), "SIGKILL");
      await holderClosed;

      const replacement = spawnWithAuthOperationLock({
        lockPath,
        command: "/usr/bin/true",
        args: [],
        options: { stdio: "ignore" },
      });
      const replacementCode = await new Promise<number | null>((resolve) => {
        replacement.once("close", resolve);
      });
      expect(replacementCode).toBe(0);
      expect((await fsp.stat(lockPath)).ino).toBe(originalInode);
    },
  );

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
