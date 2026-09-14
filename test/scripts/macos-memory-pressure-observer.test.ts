import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const observer = path.resolve("scripts/macos-memory-pressure-observer.mjs");
const installer = path.resolve("scripts/install-macos-memory-pressure-observer.sh");
const tempDirs: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-observer-"));
  tempDirs.push(root);
  return {
    root,
    state: path.join(root, "state.json"),
    sample: path.join(root, "sample.json"),
    notifier: path.join(root, "notify.sh"),
    notification: path.join(root, "notification.txt"),
  };
}

async function run(
  paths: Awaited<ReturnType<typeof fixture>>,
  sample: Record<string, number>,
  nowMs = Date.parse("2026-08-02T10:30:00+08:00"),
  options: { dryRun?: boolean; notifyCommand?: string } = {},
) {
  await fs.writeFile(paths.sample, JSON.stringify(sample));
  await fs.rm(paths.notification, { force: true });
  if (!options.notifyCommand) {
    await fs.writeFile(
      paths.notifier,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${paths.notification}"\n`,
      { mode: 0o700 },
    );
  }
  const args = [
    observer,
    "--state-path",
    paths.state,
    "--sample-json",
    paths.sample,
    "--now-ms",
    String(nowMs),
    "--notify-command",
    options.notifyCommand ?? paths.notifier,
  ];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  const result = await execFileAsync(process.execPath, args);
  const notification = await fs.readFile(paths.notification, "utf8").catch(() => "");
  return { ...result, stdout: `${result.stdout}${notification}` };
}

const healthy = {
  pressureLevel: 1,
  freePercent: 60,
  swapUsedMiB: 2200,
  pageouts: 100,
  swapouts: 200,
};
const warn = { ...healthy, pressureLevel: 2, freePercent: 24, pageouts: 120 };
const transientKernelWarning = { ...healthy, pressureLevel: 2, freePercent: 46 };
const critical = { ...warn, pressureLevel: 4, swapouts: 250 };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("macOS memory pressure observer", () => {
  it("requires thirty minutes of low headroom and sends one alert per episode", async () => {
    const paths = await fixture();
    for (let index = 0; index < 5; index += 1) {
      const pending = await run(paths, warn);
      expect(pending.stdout).not.toContain("MEMORY_OBSERVER_NOTIFICATION");
    }
    const confirmed = await run(paths, warn);
    expect(confirmed.stdout).toContain("Mac memory pressure has stayed high");
    const deduplicated = await run(paths, warn);
    expect(deduplicated.stdout).not.toContain("MEMORY_OBSERVER_NOTIFICATION");
  });

  it("ignores transient kernel warnings when measured headroom remains ample", async () => {
    const paths = await fixture();
    for (let index = 0; index < 12; index += 1) {
      const result = await run(paths, transientKernelWarning);
      expect(result.stdout).toContain("observed=healthy");
      expect(result.stdout).not.toContain("MEMORY_OBSERVER_NOTIFICATION");
    }
  });

  it("escalates critical once and recovers after one stable hour", async () => {
    const paths = await fixture();
    await run(paths, critical);
    const escalated = await run(paths, critical);
    expect(escalated.stdout).toContain("memory pressure is critical");
    for (let index = 0; index < 11; index += 1) {
      const recovering = await run(paths, healthy);
      expect(recovering.stdout).not.toContain("Mac memory recovered");
    }
    const recovered = await run(paths, healthy);
    expect(recovered.stdout).toContain("Mac memory recovered");
  });

  it("does not downgrade or re-notify a critical episode on warn samples", async () => {
    const paths = await fixture();
    await run(paths, critical);
    await run(paths, critical);
    const lowerPressure = await run(paths, warn);
    expect(lowerPressure.stdout).toContain("state=critical");
    expect(lowerPressure.stdout).not.toContain("MEMORY_OBSERVER_NOTIFICATION");
  });

  it("treats high historical swap and rising paging counters as telemetry only", async () => {
    const paths = await fixture();
    const first = await run(paths, { ...healthy, swapUsedMiB: 14000 });
    expect(first.stdout).toContain("observed=healthy");
    const second = await run(paths, {
      ...healthy,
      swapUsedMiB: 14000,
      pageouts: 5000,
      swapouts: 9000,
    });
    expect(second.stdout).toContain("observed=healthy");
  });

  it("resets paging history when cumulative counters decrease", async () => {
    const paths = await fixture();
    await run(paths, { ...healthy, pageouts: 500, swapouts: 900 });
    const reset = await run(paths, { ...healthy, pageouts: 1, swapouts: 2 });
    expect(reset.stdout).toContain("paging_reset=1");
  });

  it("does not emit routine weekly healthy reports", async () => {
    const paths = await fixture();
    const result = await run(paths, healthy);
    expect(result.stdout).not.toContain("MEMORY_OBSERVER_NOTIFICATION");
  });

  it("does not let a dry run advance or consume live notification state", async () => {
    const paths = await fixture();
    for (let index = 0; index < 5; index += 1) {
      await run(paths, warn);
    }
    const before = await fs.readFile(paths.state, "utf8");
    const preview = await run(paths, warn, Date.now(), { dryRun: true });
    expect(preview.stdout).toContain("Mac memory pressure has stayed high");
    expect(await fs.readFile(paths.state, "utf8")).toBe(before);
    const delivered = await run(paths, warn);
    expect(delivered.stdout).toContain("Mac memory pressure has stayed high");
  });

  it("fails closed when durable state is corrupt", async () => {
    const paths = await fixture();
    await fs.mkdir(path.dirname(paths.state), { recursive: true });
    await fs.writeFile(paths.state, "not-json");
    await fs.writeFile(paths.sample, JSON.stringify(warn));
    await expect(
      execFileAsync(process.execPath, [
        observer,
        "--state-path",
        paths.state,
        "--sample-json",
        paths.sample,
        "--dry-run",
      ]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("does not replay an FYI alert after an ambiguous notification failure", async () => {
    const paths = await fixture();
    const notifier = path.join(paths.root, "notify.sh");
    await fs.writeFile(notifier, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    for (let index = 0; index < 5; index += 1) {
      await run(paths, warn, Date.now(), { dryRun: false, notifyCommand: notifier });
    }
    await expect(
      run(paths, warn, Date.now(), { dryRun: false, notifyCommand: notifier }),
    ).rejects.toMatchObject({
      code: 1,
    });
    await fs.writeFile(notifier, "#!/bin/sh\nprintf 'sent\\n'\n", { mode: 0o700 });
    const deduplicated = await run(paths, warn, Date.now(), {
      dryRun: false,
      notifyCommand: notifier,
    });
    expect(deduplicated.stdout).toContain("notification=none");
  });

  it("does not replay a recovery after an ambiguous notification failure", async () => {
    const paths = await fixture();
    const notifier = path.join(paths.root, "notify.sh");
    await fs.writeFile(
      notifier,
      '#!/bin/sh\ncase "$*" in *recovered*) exit 1 ;; *) exit 0 ;; esac\n',
      { mode: 0o700 },
    );
    for (let index = 0; index < 6; index += 1) {
      await run(paths, warn, Date.now(), { dryRun: false, notifyCommand: notifier });
    }
    for (let index = 0; index < 11; index += 1) {
      await run(paths, healthy, Date.now(), { dryRun: false, notifyCommand: notifier });
    }
    await expect(
      run(paths, healthy, Date.now(), { dryRun: false, notifyCommand: notifier }),
    ).rejects.toMatchObject({ code: 1 });
    await fs.writeFile(notifier, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const deduplicated = await run(paths, healthy, Date.now(), {
      dryRun: false,
      notifyCommand: notifier,
    });
    expect(deduplicated.stdout).toContain("notification=none");
  });

  it("migrates legacy pending recovery state without replaying it", async () => {
    const paths = await fixture();
    await fs.writeFile(
      paths.state,
      JSON.stringify({
        schemaVersion: 1,
        severity: "healthy",
        episodeId: 259,
        recoveryNotificationPending: true,
        lastSample: healthy,
      }),
    );
    const result = await run(paths, healthy);
    expect(result.stdout).toContain("notification=none");
    const state = JSON.parse(await fs.readFile(paths.state, "utf8"));
    expect(state.schemaVersion).toBe(2);
    expect(state).not.toHaveProperty("recoveryNotificationPending");
  });

  it("preserves legacy active-episode dedupe while dropping stale recovery state", async () => {
    const paths = await fixture();
    await fs.writeFile(
      paths.state,
      JSON.stringify({
        schemaVersion: 1,
        severity: "warn",
        pendingSeverity: "warn",
        pendingCount: 8,
        recoveryCount: 0,
        episodeId: 7,
        notifiedLevels: ["warn"],
        recoveryNotificationPending: false,
        lastSample: warn,
      }),
    );
    for (let index = 0; index < 6; index += 1) {
      const result = await run(paths, warn);
      expect(result.stdout).toContain("state=warn");
      expect(result.stdout).not.toContain("Mac memory pressure has stayed high");
    }
    const state = JSON.parse(await fs.readFile(paths.state, "utf8"));
    expect(state.episodeId).toBe(7);
    expect(state.notifiedLevels).toEqual(["warn"]);
  });

  it("passes the configured FYI topic to the notification wrapper", async () => {
    const paths = await fixture();
    const notifier = path.join(paths.root, "notify.sh");
    const argsFile = path.join(paths.root, "notify-args.txt");
    await fs.writeFile(notifier, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, {
      mode: 0o700,
    });
    for (let index = 0; index < 6; index += 1) {
      await fs.writeFile(paths.sample, JSON.stringify(warn));
      await execFileAsync(process.execPath, [
        observer,
        "--state-path",
        paths.state,
        "--sample-json",
        paths.sample,
        "--notify-command",
        notifier,
        "--thread-id",
        "31792",
      ]);
    }
    expect(await fs.readFile(argsFile, "utf8")).toContain("--thread-id\n31792\n");
  });
});

describe("macOS memory pressure observer installer", () => {
  it("renders a scheduled one-shot job anchored to stable owner-only app support", async () => {
    const paths = await fixture();
    const repoRoot = path.resolve(".");
    const validatedNode = path.join(paths.root, "node");
    await fs.writeFile(
      validatedNode,
      '#!/bin/sh\nif [ "$1" = "-p" ]; then printf \'22.22.1\\n\'; else exit 0; fi\n',
      { mode: 0o700 },
    );
    const result = await execFileAsync("/bin/bash", [installer, "install", "--dry-run"], {
      env: {
        ...process.env,
        OPENCLAW_MAIN_REPO: repoRoot,
        OPENCLAW_NODE_BIN: validatedNode,
        OPENCLAW_MEMORY_OBSERVER_PLIST_PATH: path.join(paths.root, "observer.plist"),
        OPENCLAW_MEMORY_OBSERVER_STATE_PATH: path.join(paths.root, "state.json"),
        OPENCLAW_MEMORY_OBSERVER_INSTALL_DIR: path.join(paths.root, "installed"),
        OPENCLAW_MEMORY_OBSERVER_THREAD_ID: "31792",
      },
    });
    expect(result.stdout).toContain("<key>StartInterval</key><integer>300</integer>");
    expect(result.stdout).toContain(`<string>${validatedNode}</string>`);
    expect(result.stdout).toContain(
      path.join(paths.root, "installed/macos-memory-pressure-observer.mjs"),
    );
    expect(result.stdout).not.toContain("<key>KeepAlive</key>");
    expect(result.stdout).not.toMatch(/token|secret/i);
  });

  it("renders an explicit Telegram FYI topic when configured", async () => {
    const paths = await fixture();
    const repoRoot = path.resolve(".");
    const validatedNode = path.join(paths.root, "node");
    await fs.writeFile(
      validatedNode,
      '#!/bin/sh\nif [ "$1" = "-p" ]; then printf \'22.22.1\\n\'; else exit 0; fi\n',
      { mode: 0o700 },
    );
    const result = await execFileAsync("/bin/bash", [installer, "install", "--dry-run"], {
      env: {
        ...process.env,
        OPENCLAW_MAIN_REPO: repoRoot,
        OPENCLAW_NODE_BIN: validatedNode,
        OPENCLAW_MEMORY_OBSERVER_PLIST_PATH: path.join(paths.root, "observer.plist"),
        OPENCLAW_MEMORY_OBSERVER_STATE_PATH: path.join(paths.root, "state.json"),
        OPENCLAW_MEMORY_OBSERVER_INSTALL_DIR: path.join(paths.root, "installed"),
        OPENCLAW_MEMORY_OBSERVER_THREAD_ID: "31792",
      },
    });
    expect(result.stdout).toContain("<string>--thread-id</string><string>31792</string>");
  });

  it("reuses the installed FYI topic for manual run-now executions", async () => {
    const paths = await fixture();
    const fakeBin = path.join(paths.root, "bin");
    const fakeUname = path.join(fakeBin, "uname");
    const fakeNode = path.join(fakeBin, "node");
    const fakePlistBuddy = path.join(fakeBin, "PlistBuddy");
    const nodeArgs = path.join(paths.root, "node-args.txt");
    const plist = path.join(paths.root, "observer.plist");
    await fs.mkdir(fakeBin);
    await fs.writeFile(fakeUname, "#!/bin/sh\nprintf 'Darwin\\n'\n", { mode: 0o700 });
    await fs.writeFile(
      fakeNode,
      `#!/bin/sh\nif [ "$1" = "-p" ]; then printf '22.22.1\\n'; exit 0; fi\nprintf '%s\\n' "$@" > "${nodeArgs}"\n`,
      { mode: 0o700 },
    );
    await fs.writeFile(
      fakePlistBuddy,
      "#!/bin/sh\nprintf 'Array {\\n  /usr/bin/node\\n  observer.mjs\\n  --thread-id\\n  31792\\n}\\n'\n",
      { mode: 0o700 },
    );
    await fs.writeFile(plist, "fixture");
    await execFileAsync("/bin/bash", [installer, "run-now", "--dry-run"], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        OPENCLAW_MAIN_REPO: path.resolve("."),
        OPENCLAW_NODE_BIN: fakeNode,
        OPENCLAW_MEMORY_OBSERVER_PLIST_BUDDY_BIN: fakePlistBuddy,
        OPENCLAW_MEMORY_OBSERVER_PLIST_PATH: plist,
        OPENCLAW_MEMORY_OBSERVER_INSTALL_DIR: path.join(paths.root, "installed"),
        OPENCLAW_MEMORY_OBSERVER_STATE_PATH: path.join(paths.root, "state.json"),
      },
    });
    expect(await fs.readFile(nodeArgs, "utf8")).toContain("--thread-id\n31792\n");
  });
});
