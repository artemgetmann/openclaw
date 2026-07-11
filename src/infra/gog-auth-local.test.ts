import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_KEYRING_OPEN_TIMEOUT,
  classifyGoogleAuthFailure,
  DEFAULT_CONSUMER_GOOGLE_SERVICES,
  gogSubprocessEnv,
  reserveAuthSessionDirectory,
  resolveAuthWorkerLaunch,
  spawnAuthWorkerProcess,
  VERIFICATION_KEYRING_OPEN_TIMEOUT,
  waitForAuthWorkerReadiness,
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

  it("preserves an active explicit session when the same session is retried", async () => {
    const rootDir = await temporaryRoot();
    const sessionId = "active-session";
    const sessionDir = await reserveAuthSessionDirectory(rootDir, sessionId);
    const originalStatus = {
      sessionId,
      phase: "authorizing",
      pid: 41_001,
      workerPid: 41_002,
      lockPid: 41_003,
      logPath: path.join(sessionDir, "gog-auth.log"),
    };
    await fsp.writeFile(
      path.join(sessionDir, "status.json"),
      JSON.stringify(originalStatus, null, 2),
    );
    await fsp.writeFile(originalStatus.logPath, "original auth output\n");

    await expect(reserveAuthSessionDirectory(rootDir, sessionId)).rejects.toThrow("already exists");

    // wait/stop still see the original phase and process ownership; the retry
    // did not truncate the log or relabel the active session as an error.
    expect(JSON.parse(await fsp.readFile(path.join(sessionDir, "status.json"), "utf8"))).toEqual(
      originalStatus,
    );
    expect(await fsp.readFile(originalStatus.logPath, "utf8")).toBe("original auth output\n");
  });

  it("atomically gives a new explicit session to only one concurrent start", async () => {
    const rootDir = await temporaryRoot();
    const results = await Promise.allSettled([
      reserveAuthSessionDirectory(rootDir, "shared-session"),
      reserveAuthSessionDirectory(rootDir, "shared-session"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("launches the requested worker directly outside macOS", () => {
    const launch = resolveAuthWorkerLaunch({
      platform: "linux",
      lockPath: "/tmp/ignored.lock",
      command: "/usr/bin/node",
      args: ["worker.js", "--session", "demo"],
    });

    expect(launch).toEqual({
      command: "/usr/bin/node",
      args: ["worker.js", "--session", "demo"],
      usesMacosLock: false,
    });
    expect(launch.command).not.toBe("/usr/bin/lockf");
  });

  it("wraps the requested worker with persistent lockf ownership on macOS", () => {
    const launch = resolveAuthWorkerLaunch({
      platform: "darwin",
      lockPath: "/tmp/auth.lock",
      command: "/usr/bin/node",
      args: ["worker.js"],
    });

    expect(launch).toEqual({
      command: "/usr/bin/lockf",
      args: ["-s", "-t", "0", "-k", "/tmp/auth.lock", "/usr/bin/node", "worker.js"],
      usesMacosLock: true,
    });
  });

  it("allows healthy worker readiness beyond the old two-second window", async () => {
    let now = 0;
    let polls = 0;
    const status = await waitForAuthWorkerReadiness({
      readStatus: async () => {
        polls += 1;
        return polls >= 4
          ? { phase: "waiting_for_browser", workerPid: 42_001 }
          : { phase: "starting", workerPid: null };
      },
      getSpawnError: () => null,
      getExitCode: () => null,
      usesMacosLock: true,
      timeoutMs: 30_000,
      pollIntervalMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(now).toBe(3_000);
    expect(status).toEqual({ phase: "waiting_for_browser", workerPid: 42_001 });
  });

  it("keeps the worker readiness deadline bounded", async () => {
    let now = 0;
    await expect(
      waitForAuthWorkerReadiness({
        readStatus: async () => ({ phase: "starting", workerPid: null }),
        getSpawnError: () => null,
        getExitCode: () => null,
        usesMacosLock: false,
        timeoutMs: 3_000,
        pollIntervalMs: 1_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow("did not report ready state in time");
    expect(now).toBe(3_000);
  });

  it.runIf(process.platform === "darwin")(
    "keeps one stable lock inode across contention and crashed-owner recovery",
    async () => {
      const rootDir = await temporaryRoot();
      const lockPath = path.join(rootDir, "active-auth.lock");
      const holder = spawnAuthWorkerProcess({
        platform: "darwin",
        lockPath,
        command: "/bin/sh",
        args: ["-c", 'printf "ready\\n"; while :; do sleep 1; done'],
        options: { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      }).child;
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.stdout?.once("data", () => resolve());
      });
      const originalInode = (await fsp.stat(lockPath)).ino;

      const contender = spawnAuthWorkerProcess({
        platform: "darwin",
        lockPath,
        command: "/usr/bin/true",
        args: [],
        options: { stdio: "ignore" },
      }).child;
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

      const replacement = spawnAuthWorkerProcess({
        platform: "darwin",
        lockPath,
        command: "/usr/bin/true",
        args: [],
        options: { stdio: "ignore" },
      }).child;
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
