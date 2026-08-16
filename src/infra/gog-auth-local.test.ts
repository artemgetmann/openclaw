import { spawn as spawnChild } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_KEYRING_OPEN_TIMEOUT,
  authOperationStatusPids,
  authWorkerTerminalExitCode,
  authorizedAccountMessage,
  classifyGoogleAuthFailure,
  DEFAULT_CONSUMER_GOOGLE_SERVICES,
  gogSubprocessEnv,
  reserveAuthSessionDirectory,
  resolveAuthWorkerLaunch,
  resolveGogAuthOperationCommand,
  spawnAuthOperationProcess,
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

  it("does not present stored OAuth scopes as Google API readiness", () => {
    const message = authorizedAccountMessage(
      "demo@example.com",
      "gmail,calendar,drive,contacts,docs,sheets",
    );

    expect(message).toContain("authorization is stored for demo@example.com");
    expect(message).toContain("does not verify that each Google API is enabled");
    expect(message).toContain("read-only check");
    expect(message).toContain("before any write");
  });

  it("starts outside the repository without the development-only tsx loader", async () => {
    const rootDir = await temporaryRoot();
    const sourceDir = path.resolve("skills/gog/scripts");
    const helperDir = path.join(rootDir, "packaged-skill");
    await fsp.mkdir(helperDir);
    await Promise.all(
      ["gog-auth-local.sh", "gog-auth-local.ts"].map((name) =>
        fsp.copyFile(path.join(sourceDir, name), path.join(helperDir, name)),
      ),
    );

    // A copied helper models the packaged workspace: it has the managed Node
    // binary but no repository node_modules tree from which `tsx` could load.
    const child = spawnChild("/bin/bash", [path.join(helperDir, "gog-auth-local.sh")], {
      cwd: rootDir,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(1);
    expect(stderr).toContain("Usage:");
    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(await fsp.readFile(path.join(helperDir, "gog-auth-local.ts"), "utf8")).not.toContain(
      '"tsx"',
    );
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

  it("distinguishes supervisor, locked group, and direct gog PIDs", () => {
    expect(authOperationStatusPids(true, 52_001, 52_002)).toEqual({
      pid: null,
      workerPid: 52_002,
      lockPid: 52_001,
    });
    expect(authOperationStatusPids(false, 52_003, 52_004)).toEqual({
      pid: 52_003,
      workerPid: 52_004,
      lockPid: null,
    });
  });

  it("passes user-derived gog values as argv instead of shell source", () => {
    const hostileEmail = 'demo@example.com"; touch /tmp/not-allowed; #';
    const operation = resolveGogAuthOperationCommand({
      platform: "darwin",
      readyPath: "/tmp/ready path",
      verificationPath: "/tmp/verification path",
      verificationTimeout: "15s",
      gogArgs: ["auth", "add", hostileEmail, "--services", "gmail,calendar"],
    });

    expect(operation.command).toBe("/bin/sh");
    expect(operation.args[1]).not.toContain(hostileEmail);
    expect(operation.args.slice(-5)).toEqual([
      "auth",
      "add",
      hostileEmail,
      "--services",
      "gmail,calendar",
    ]);
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

  it("accepts first-poll authorization after the worker clears its PID", async () => {
    const authorized = {
      phase: "authorized",
      workerPid: null,
      message: "Google Workspace is connected.",
    };
    const status = await waitForAuthWorkerReadiness({
      readStatus: async () => authorized,
      getSpawnError: () => null,
      getExitCode: () => 0,
      usesMacosLock: false,
    });

    expect(status).toBe(authorized);
    expect(authWorkerTerminalExitCode(status.phase)).toBe(0);
  });

  it("returns the classified terminal error without replacing its status", async () => {
    const classifiedError = {
      phase: "error",
      workerPid: null,
      diagnosticKind: "keychain_approval_needed",
      nextStep: "Choose Always Allow.",
    };
    const status = await waitForAuthWorkerReadiness({
      readStatus: async () => classifiedError,
      getSpawnError: () => null,
      getExitCode: () => 1,
      usesMacosLock: false,
    });

    expect(status).toBe(classifiedError);
    expect(status.nextStep).toBe("Choose Always Allow.");
    expect(authWorkerTerminalExitCode(status.phase)).toBe(1);
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
      const holder = spawnAuthOperationProcess({
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

      const contender = spawnAuthOperationProcess({
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

      const replacement = spawnAuthOperationProcess({
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

  it.runIf(process.platform === "darwin")(
    "keeps normal auth and verification inside one successful lock command",
    async () => {
      const rootDir = await temporaryRoot();
      const fakeGogPath = path.join(rootDir, "gog");
      const readyPath = path.join(rootDir, "ready");
      const verificationPath = path.join(rootDir, "verification.json");
      await fsp.writeFile(
        fakeGogPath,
        `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then
  printf '{"accounts":[{"email":"demo@example.com","services":["gmail"]}]}'
fi
exit 0
`,
        { mode: 0o755 },
      );
      const operation = resolveGogAuthOperationCommand({
        platform: "darwin",
        readyPath,
        verificationPath,
        verificationTimeout: "15s",
        gogArgs: ["auth", "add", "demo@example.com", "--services", "gmail"],
      });
      const child = spawnAuthOperationProcess({
        platform: "darwin",
        lockPath: path.join(rootDir, "active-auth.lock"),
        command: operation.command,
        args: operation.args,
        options: {
          stdio: "ignore",
          env: { ...process.env, PATH: `${rootDir}:${process.env.PATH ?? ""}` },
        },
      }).child;
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

      expect(code).toBe(0);
      await expect(fsp.access(readyPath)).resolves.toBeUndefined();
      expect(JSON.parse(await fsp.readFile(verificationPath, "utf8"))).toEqual({
        accounts: [{ email: "demo@example.com", services: ["gmail"] }],
      });
    },
  );

  it.runIf(process.platform === "darwin")(
    "keeps the auth lock after its Node-like supervisor is killed",
    async () => {
      const rootDir = await temporaryRoot();
      const lockPath = path.join(rootDir, "active-auth.lock");
      const readyPath = path.join(rootDir, "fake-gog-ready");
      const lockPidPath = path.join(rootDir, "lock-pid");
      const holderLaunch = resolveAuthWorkerLaunch({
        platform: "darwin",
        lockPath,
        command: "/bin/sh",
        args: ["-c", 'printf ready > "$1"; while :; do sleep 1; done', "fake-gog", readyPath],
      });
      const supervisorScript = `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const launch = JSON.parse(process.argv[1]);
        const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
        if (!child.pid) process.exit(2);
        fs.writeFileSync(process.argv[2], String(child.pid));
        setInterval(() => {}, 1000);
      `;
      const supervisor = spawnChild(
        process.execPath,
        ["-e", supervisorScript, JSON.stringify(holderLaunch), lockPidPath],
        { stdio: "ignore" },
      );
      let lockPid: number | undefined;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            lockPid = Number.parseInt(await fsp.readFile(lockPidPath, "utf8"), 10);
            await fsp.access(readyPath);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        expect(lockPid).toBeTypeOf("number");
        const originalInode = (await fsp.stat(lockPath)).ino;

        const supervisorClosed = new Promise<void>((resolve) =>
          supervisor.once("close", () => resolve()),
        );
        expect(supervisor.pid).toBeTypeOf("number");
        process.kill(supervisor.pid ?? 0, "SIGKILL");
        await supervisorClosed;

        const contender = spawnAuthOperationProcess({
          platform: "darwin",
          lockPath,
          command: "/usr/bin/true",
          args: [],
          options: { stdio: "ignore" },
        }).child;
        const contenderCode = await new Promise<number | null>((resolve) =>
          contender.once("close", resolve),
        );
        expect(contenderCode).toBe(75);
        expect((await fsp.stat(lockPath)).ino).toBe(originalInode);

        process.kill(-(lockPid ?? 0), "SIGKILL");
        let replacementCode: number | null = 75;
        for (let attempt = 0; attempt < 100 && replacementCode === 75; attempt += 1) {
          const replacement = spawnAuthOperationProcess({
            platform: "darwin",
            lockPath,
            command: "/usr/bin/true",
            args: [],
            options: { stdio: "ignore" },
          }).child;
          replacementCode = await new Promise<number | null>((resolve) =>
            replacement.once("close", resolve),
          );
          if (replacementCode === 75) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        expect(replacementCode).toBe(0);
        expect((await fsp.stat(lockPath)).ino).toBe(originalInode);
      } finally {
        if (supervisor.pid) {
          try {
            process.kill(supervisor.pid, "SIGKILL");
          } catch {
            // Already stopped by the test.
          }
        }
        if (lockPid) {
          try {
            process.kill(-lockPid, "SIGKILL");
          } catch {
            // Already stopped by the test.
          }
        }
      }
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
