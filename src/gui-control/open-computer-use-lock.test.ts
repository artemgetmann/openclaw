import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
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

  it("serializes separate executable copies that share one app-agent bundle identity", async () => {
    const directory = await temporaryDirectory();
    const firstCommand = path.join(directory, "copy-a", "OpenComputerUse");
    const secondCommand = path.join(directory, "copy-b", "OpenComputerUse");
    const appAgentIdentity = "bundle:com.ifuryst.opencomputeruse";
    const target = await resolveOpenComputerUseLockTarget(firstCommand, appAgentIdentity);
    cleanupPaths.add(`${target}.lock`);
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
      appAgentIdentity,
      command: firstCommand,
      timeoutMs: 1_000,
      run: async () => {
        events.push("first:start");
        markFirstStarted();
        await firstCanFinish;
      },
    });
    await firstStarted;
    const second = withOpenComputerUseLock({
      appAgentIdentity,
      command: secondCommand,
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

  it("reclaims a lock left by a dead OpenClaw caller", async () => {
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
      withOpenComputerUseLock({ command, timeoutMs: 500, run: async () => "recovered" }),
    ).resolves.toBe("recovered");
  });

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
      withOpenComputerUseLock({ command, timeoutMs: 60, run: async () => "must-not-run" }),
    ).rejects.toBeInstanceOf(OpenComputerUseLockTimeoutError);
    await expect(fs.readFile(`${target}.lock`, "utf8")).resolves.toContain(`"pid":${process.pid}`);
  });

  it("bounds lock waiting by the caller timeout", async () => {
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
      withOpenComputerUseLock({ command, timeoutMs: 60, run: async () => "must-not-run" }),
    ).rejects.toBeInstanceOf(OpenComputerUseLockTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(300);

    releaseOwner();
    await owner;
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
