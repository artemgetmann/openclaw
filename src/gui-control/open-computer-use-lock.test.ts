import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLock } from "../infra/file-lock.js";
import {
  OpenComputerUseLockTimeoutError,
  resolveOpenComputerUseLockTarget,
  withOpenComputerUseLock,
} from "./open-computer-use-lock.js";

const execFileAsync = promisify(execFile);
const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (cleanupPath) => {
      await fs.rm(cleanupPath, { recursive: true, force: true });
    }),
  );
  cleanupPaths.clear();
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ocu-lock-test-"));
  cleanupPaths.add(directory);
  return directory;
}

async function trackedLockTarget(command: string): Promise<string> {
  const target = await resolveOpenComputerUseLockTarget(command);
  cleanupPaths.add(`${target}.lock`);
  cleanupPaths.add(`${target}.queue`);
  return target;
}

describe("withOpenComputerUseLock", () => {
  it("serializes simultaneous callers inside one OpenClaw process", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    await trackedLockTarget(command);
    const events: string[] = [];
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withOpenComputerUseLock({
      command,
      timeoutMs: 1_000,
      run: async () => {
        events.push("first:start");
        markFirstStarted();
        await firstCanFinish;
        events.push("first:end");
      },
    });
    await firstStarted;
    const second = withOpenComputerUseLock({
      command,
      timeoutMs: 1_000,
      run: async () => {
        events.push("second:start");
        events.push("second:end");
      },
    });

    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("keeps publication order when contenders share the same wall-clock millisecond", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    await trackedLockTarget(command);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const first = withOpenComputerUseLock({
        command,
        timeoutMs: 1_000,
        run: async () => {
          events.push("first:start");
          await firstCanFinish;
          events.push("first:end");
        },
      });
      // Publish the second contender before the first contender's settlement
      // window ends. Date.now is identical; only the monotonic order key can
      // preserve the actual publication order.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = withOpenComputerUseLock({
        command,
        timeoutMs: 1_000,
        run: async () => {
          events.push("second:start");
        },
      });

      await vi.waitFor(() => expect(events).toEqual(["first:start"]));
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first:start", "first:end", "second:start"]);
    } finally {
      now.mockRestore();
    }
  });

  it("serializes separate executable copies that share one app-agent socket identity", async () => {
    const directory = await temporaryDirectory();
    const firstCommand = path.join(directory, "copy-a", "OpenComputerUse");
    const secondCommand = path.join(directory, "copy-b", "OpenComputerUse");
    const socketIdentity = "socket:bundle:com.ifuryst.opencomputeruse";
    const target = await resolveOpenComputerUseLockTarget(firstCommand, socketIdentity);
    cleanupPaths.add(`${target}.lock`);
    cleanupPaths.add(`${target}.queue`);
    const events: string[] = [];
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withOpenComputerUseLock({
      command: firstCommand,
      socketIdentity,
      timeoutMs: 1_000,
      run: async () => {
        events.push("first:start");
        markFirstStarted();
        await firstCanFinish;
      },
    });
    await firstStarted;
    const second = withOpenComputerUseLock({
      command: secondCommand,
      socketIdentity,
      timeoutMs: 1_000,
      run: async () => {
        events.push("second:start");
      },
    });

    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "second:start"]);
  });

  it("does not serialize commands that resolve to different app-agent sockets", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const releaseCallbacks: Array<() => void> = [];
    const started: string[] = [];

    const calls = ["socket:release", "socket:dev"].map((socketIdentity) =>
      withOpenComputerUseLock({
        command,
        socketIdentity,
        timeoutMs: 500,
        run: async () => {
          started.push(socketIdentity);
          await new Promise<void>((resolve) => releaseCallbacks.push(resolve));
        },
      }),
    );

    await vi.waitFor(() => expect(started).toHaveLength(2));
    for (const release of releaseCallbacks) {
      release();
    }
    await Promise.all(calls);
  });

  it("fails closed on a dead legacy lock without mutating its shared pathname", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      `${target}.lock`,
      JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() }),
      "utf8",
    );

    await expect(
      withOpenComputerUseLock({
        command,
        lockTimeoutMs: 60,
        timeoutMs: 500,
        run: async () => "must-not-run",
      }),
    ).rejects.toThrow("ownerState=dead");
    await expect(fs.readFile(`${target}.lock`, "utf8")).resolves.toContain("2147483647");
  });

  it("holds a v1-compatible sentinel so an old caller cannot overlap a v2 owner", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    let releaseOwner!: () => void;
    const ownerCanFinish = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = withOpenComputerUseLock({
      command,
      timeoutMs: 500,
      run: async () => {
        markOwnerStarted();
        await ownerCanFinish;
      },
    });
    await ownerStarted;

    await expect(
      acquireFileLock(target, {
        retries: { retries: 2, factor: 1, minTimeout: 10, maxTimeout: 10 },
        stale: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow("file lock timeout for");

    releaseOwner();
    await owner;
    const legacyCaller = await acquireFileLock(target, {
      retries: { retries: 0, factor: 1, minTimeout: 10, maxTimeout: 10 },
      stale: Number.MAX_SAFE_INTEGER,
    });
    await legacyCaller.release();
  });

  it("lets two successors idempotently reclaim a crashed child and run serially", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    const acquiredPath = path.join(directory, "child-acquired");
    const workerPath = path.join(directory, "crash-owner.mts");
    await fs.writeFile(
      workerPath,
      [
        `import fs from ${JSON.stringify("node:fs/promises")};`,
        `import { withOpenComputerUseLock } from ${JSON.stringify(new URL("./open-computer-use-lock.ts", import.meta.url).href)};`,
        "const [command, acquiredPath] = process.argv.slice(2);",
        "await withOpenComputerUseLock({",
        "  command,",
        "  timeoutMs: 5_000,",
        "  run: async () => {",
        "    await fs.writeFile(acquiredPath, 'acquired');",
        "    await new Promise(() => setInterval(() => {}, 1_000));",
        "  },",
        "});",
      ].join("\n"),
    );
    const child = execFile(process.execPath, [
      "--import",
      "tsx",
      workerPath,
      command,
      acquiredPath,
    ]);
    let childStderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      childStderr += chunk.toString();
    });
    const prematureExit = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `crash-owner exited before acquisition: code=${code ?? "none"} signal=${signal ?? "none"} stderr=${JSON.stringify(childStderr)}`,
          ),
        );
      });
    });
    await Promise.race([
      vi.waitFor(async () => expect(await fs.readFile(acquiredPath, "utf8")).toBe("acquired")),
      prematureExit,
    ]);
    expect((await fs.readdir(`${target}.lock`)).some((name) => name.startsWith("owner-"))).toBe(
      true,
    );

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const events: string[] = [];
    const successors = ["first", "second"].map((name) =>
      withOpenComputerUseLock({
        command,
        timeoutMs: 1_000,
        run: async () => {
          events.push(`${name}:start`);
          await new Promise((resolve) => setTimeout(resolve, 30));
          events.push(`${name}:end`);
          return name;
        },
      }),
    );
    await expect(Promise.all(successors)).resolves.toEqual(
      expect.arrayContaining(["first", "second"]),
    );
    expect(events).toMatchObject([
      expect.stringMatching(/^(first|second):start$/),
      expect.stringMatching(/^(first|second):end$/),
      expect.stringMatching(/^(first|second):start$/),
      expect.stringMatching(/^(first|second):end$/),
    ]);
    expect(events[0]?.split(":")[0]).toBe(events[1]?.split(":")[0]);
    expect(events[2]?.split(":")[0]).toBe(events[3]?.split(":")[0]);
    expect(events[0]?.split(":")[0]).not.toBe(events[2]?.split(":")[0]);
    await expect(fs.stat(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(`${target}.queue`)).filter((name) => name.endsWith(".json"))).toEqual(
      [],
    );
  });

  it("cleans its exact v2 sentinel when acquisition fails after legacy publication", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    const originalRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!injected && String(from).includes(".queue/") && String(from).endsWith(".acquired")) {
        injected = true;
        throw Object.assign(new Error("injected queue publication failure"), { code: "EIO" });
      }
      return await originalRename(from, to);
    });

    try {
      await expect(
        withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "must-not-run" }),
      ).rejects.toThrow("injected queue publication failure");
      await expect(fs.stat(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(`${target}.queue`)).filter((name) => name.endsWith(".json")),
      ).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  it("removes a published queue owner when candidate cleanup fails", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    const originalRm = fs.rm.bind(fs);
    let injected = false;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
      if (!injected && String(targetPath).endsWith(".candidate")) {
        injected = true;
        throw Object.assign(new Error("injected candidate cleanup failure"), { code: "EIO" });
      }
      return await originalRm(targetPath, options);
    });

    try {
      await expect(
        withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "must-not-run" }),
      ).rejects.toThrow("injected candidate cleanup failure");
    } finally {
      rm.mockRestore();
    }
    expect((await fs.readdir(`${target}.queue`)).filter((name) => name.endsWith(".json"))).toEqual(
      [],
    );
    await expect(
      withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "recovered" }),
    ).resolves.toBe("recovered");
    await expect(fs.stat(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans the token candidate when legacy marker publication fails", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    const originalRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!injected && String(from).includes(".lock/") && String(from).endsWith(".acquired")) {
        injected = true;
        throw Object.assign(new Error("injected legacy marker rename failure"), { code: "EIO" });
      }
      return await originalRename(from, to);
    });

    try {
      await expect(
        withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "must-not-run" }),
      ).rejects.toThrow("injected legacy marker rename failure");
      await expect(fs.stat(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(`${target}.queue`)).filter((name) => name.endsWith(".json")),
      ).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  it("retries partial release cleanup so a same-PID record cannot strand the queue", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    const originalRm = fs.rm.bind(fs);
    let injected = false;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
      if (
        !injected &&
        String(targetPath).includes(".queue/") &&
        String(targetPath).endsWith(".json")
      ) {
        injected = true;
        throw Object.assign(new Error("injected release failure"), { code: "EIO" });
      }
      return await originalRm(targetPath, options);
    });

    try {
      await expect(
        withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "first" }),
      ).resolves.toBe("first");
    } finally {
      rm.mockRestore();
    }
    await expect(
      withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "second" }),
    ).resolves.toBe("second");
    expect((await fs.readdir(`${target}.queue`)).filter((name) => name.endsWith(".json"))).toEqual(
      [],
    );
  });

  it.each(["marker-rm", "rmdir"])(
    "retries a transient %s failure without stranding the legacy sentinel",
    async (failureMode) => {
      const directory = await temporaryDirectory();
      const command = path.join(directory, "OpenComputerUse");
      const target = await trackedLockTarget(command);
      const originalRm = fs.rm.bind(fs);
      const originalRmdir = fs.rmdir.bind(fs);
      let injected = false;
      const rm = vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
        if (
          failureMode === "marker-rm" &&
          !injected &&
          String(targetPath).includes(".lock/owner-") &&
          String(targetPath).endsWith(".json")
        ) {
          injected = true;
          throw Object.assign(new Error("injected marker removal failure"), { code: "EIO" });
        }
        return await originalRm(targetPath, options);
      });
      const rmdir = vi.spyOn(fs, "rmdir").mockImplementation(async (targetPath, options) => {
        if (failureMode === "rmdir" && !injected && String(targetPath).endsWith(".lock")) {
          injected = true;
          throw Object.assign(new Error("injected rmdir failure"), { code: "EIO" });
        }
        return await originalRmdir(targetPath, options);
      });

      try {
        await expect(
          withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "first" }),
        ).resolves.toBe("first");
      } finally {
        rm.mockRestore();
        rmdir.mockRestore();
      }
      expect(injected).toBe(true);
      await expect(
        withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "second" }),
      ).resolves.toBe("second");
      await expect(fs.stat(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("never age-steals a lock from a live caller with a longer operation", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      `${target}.lock`,
      JSON.stringify({ pid: process.pid, createdAt: "1970-01-01T00:00:00.000Z" }),
      "utf8",
    );

    await expect(
      withOpenComputerUseLock({
        command,
        lockTimeoutMs: 60,
        timeoutMs: 500,
        run: async () => "must-not-run",
      }),
    ).rejects.toBeInstanceOf(OpenComputerUseLockTimeoutError);
    await expect(fs.readFile(`${target}.lock`, "utf8")).resolves.toContain(`"pid":${process.pid}`);
  });

  it("fails closed with bounded diagnostics for an invalid legacy lock", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(`${target}.lock`, "publication-incomplete", "utf8");

    const error = await withOpenComputerUseLock({
      command,
      lockTimeoutMs: 60,
      timeoutMs: 500,
      run: async () => "must-not-run",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenComputerUseLockTimeoutError);
    expect(String(error)).toContain(`lockPath=${target}.queue`);
    expect(String(error)).toContain("ownerState=invalid");
    expect(String(error)).toContain('ownerStartIdentity="unavailable"');
    expect(String(error)).toContain("waitBudgetMs=60");
    await expect(fs.readFile(`${target}.lock`, "utf8")).resolves.toBe("publication-incomplete");
  });

  it("reclaims only a token-bound contender when its PID generation was reused", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    const queuePath = `${target}.queue`;
    const stalePath = path.join(queuePath, `0-${process.pid}-stale-token.json`);
    await fs.mkdir(queuePath, { recursive: true });
    await fs.writeFile(
      stalePath,
      JSON.stringify({
        version: 2,
        pid: process.pid,
        token: "stale-token",
        identity: command,
        orderKey: "00000000000000000000",
        command,
        createdAt: new Date().toISOString(),
        phase: "acquired",
        processStartIdentity: "definitely-not-this-process-generation",
      }),
    );

    await expect(
      withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "recovered" }),
    ).resolves.toBe("recovered");
    await expect(fs.stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds lock waiting independently from the execution timeout", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    await trackedLockTarget(command);
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    let releaseOwner!: () => void;
    const ownerCanFinish = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = withOpenComputerUseLock({
      command,
      timeoutMs: 1_000,
      run: async () => {
        markOwnerStarted();
        await ownerCanFinish;
      },
    });
    await ownerStarted;

    const startedAt = Date.now();
    await expect(
      withOpenComputerUseLock({
        command,
        lockTimeoutMs: 60,
        timeoutMs: 500,
        run: async () => "must-not-run",
      }),
    ).rejects.toBeInstanceOf(OpenComputerUseLockTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(300);

    releaseOwner();
    await owner;
  });

  it("reproduces two timed-out waiters whose hidden owner later leaves no lock", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const target = await trackedLockTarget(command);
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    let releaseOwner!: () => void;
    const ownerCanFinish = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = withOpenComputerUseLock({
      command,
      timeoutMs: 500,
      run: async () => {
        markOwnerStarted();
        await ownerCanFinish;
      },
    });
    await ownerStarted;

    const waiter = () =>
      withOpenComputerUseLock({
        command,
        lockTimeoutMs: 60,
        timeoutMs: 500,
        run: async () => "must-not-run",
      }).catch((error: unknown) => error);
    const [firstError, secondError] = await Promise.all([waiter(), waiter()]);
    for (const error of [firstError, secondError]) {
      expect(error).toBeInstanceOf(OpenComputerUseLockTimeoutError);
      expect(String(error)).toContain(`command=${JSON.stringify(command)}`);
      expect(String(error)).toContain(`socketIdentity=${JSON.stringify(command)}`);
      expect(String(error)).toContain(`ownerPid=${process.pid}`);
      expect(String(error)).toContain("ownerState=live");
      expect(String(error)).toContain('"phase":"legacy-observed"');
    }

    releaseOwner();
    await owner;
    await vi.waitFor(async () => {
      const remaining = (await fs.readdir(`${target}.queue`)).filter((name) =>
        name.endsWith(".json"),
      );
      expect(remaining).toEqual([]);
    });
  });

  it("gives a waiter its full execution budget after a near-budget prior owner", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    await trackedLockTarget(command);
    let ownerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      ownerStarted = resolve;
    });
    const owner = withOpenComputerUseLock({
      command,
      timeoutMs: 120,
      run: async () => {
        ownerStarted();
        await new Promise((resolve) => setTimeout(resolve, 90));
      },
    });
    await started;

    let receivedExecutionBudget = 0;
    const waiter = withOpenComputerUseLock({
      command,
      lockTimeoutMs: 200,
      timeoutMs: 100,
      run: async (executionTimeoutMs) => {
        receivedExecutionBudget = executionTimeoutMs;
        await new Promise((resolve) => setTimeout(resolve, 70));
        return "completed";
      },
    });

    await expect(Promise.all([owner, waiter])).resolves.toEqual([undefined, "completed"]);
    expect(receivedExecutionBudget).toBe(100);
  });

  it("prevents duplicate startup across processes and lets one caller recover stale agent state", async () => {
    const directory = await temporaryDirectory();
    const command = path.join(directory, "OpenComputerUse");
    const statePath = path.join(directory, "agent-state.txt");
    const spawnPath = path.join(directory, "spawn-events.txt");
    // `.mts` keeps the child fixture in ESM mode so its top-level await matches
    // the production module path instead of depending on the temp directory's
    // absent package.json metadata.
    const workerPath = path.join(directory, "worker.mts");
    await trackedLockTarget(command);
    await fs.writeFile(statePath, "stale", "utf8");

    // Each worker models a separate `openclaw gui-control` process entering
    // OCU's connect-or-launch path. Without the outer lock both observe stale
    // state during the startup delay and record a duplicate app-agent spawn.
    await fs.writeFile(
      workerPath,
      [
        `import fs from ${JSON.stringify("node:fs/promises")};`,
        `import { withOpenComputerUseLock } from ${JSON.stringify(new URL("./open-computer-use-lock.ts", import.meta.url).href)};`,
        "const [command, statePath, spawnPath] = process.argv.slice(2);",
        "await withOpenComputerUseLock({",
        "  command,",
        "  timeoutMs: 2_000,",
        "  run: async () => {",
        "    const state = await fs.readFile(statePath, 'utf8').catch(() => 'missing');",
        "    if (state !== 'healthy') {",
        "      await fs.appendFile(spawnPath, 'spawn\\n');",
        "      await new Promise((resolve) => setTimeout(resolve, 150));",
        "      await fs.writeFile(statePath, 'healthy', 'utf8');",
        "    }",
        "  },",
        "});",
      ].join("\n"),
      "utf8",
    );

    const childArgs = ["--import", "tsx", workerPath, command, statePath, spawnPath];
    await Promise.all([
      execFileAsync(process.execPath, childArgs, { cwd: process.cwd() }),
      execFileAsync(process.execPath, childArgs, { cwd: process.cwd() }),
    ]);

    expect(await fs.readFile(statePath, "utf8")).toBe("healthy");
    expect((await fs.readFile(spawnPath, "utf8")).trim().split("\n")).toEqual(["spawn"]);
  });
});
