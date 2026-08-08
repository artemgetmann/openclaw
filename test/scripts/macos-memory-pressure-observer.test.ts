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
  };
}

async function run(
  paths: Awaited<ReturnType<typeof fixture>>,
  sample: Record<string, number>,
  nowMs = Date.parse("2026-08-02T10:30:00+08:00"),
  options: { dryRun?: boolean; notifyCommand?: string } = { dryRun: true },
) {
  await fs.writeFile(paths.sample, JSON.stringify(sample));
  const args = [
    observer,
    "--state-path",
    paths.state,
    "--sample-json",
    paths.sample,
    "--now-ms",
    String(nowMs),
  ];
  if (options.notifyCommand) {
    args.push("--notify-command", options.notifyCommand);
  }
  if (options.dryRun !== false) {
    args.push("--dry-run");
  }
  return execFileAsync(process.execPath, args);
}

const healthy = {
  pressureLevel: 1,
  freePercent: 60,
  swapUsedMiB: 2200,
  pageouts: 100,
  swapouts: 200,
};
const warn = { ...healthy, pressureLevel: 2, freePercent: 24, pageouts: 120 };
const critical = { ...warn, pressureLevel: 4, swapouts: 250 };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("macOS memory pressure observer", () => {
  it("requires two pressure samples and sends one alert per episode", async () => {
    const paths = await fixture();
    const first = await run(paths, warn);
    expect(first.stdout).not.toContain("MEMORY_OBSERVER_NOTIFICATION");
    const second = await run(paths, warn);
    expect(second.stdout).toContain("Mac memory pressure has stayed high");
    const third = await run(paths, warn);
    expect(third.stdout).not.toContain("MEMORY_OBSERVER_NOTIFICATION");
  });

  it("escalates critical once and recovers after two healthy samples", async () => {
    const paths = await fixture();
    await run(paths, warn);
    await run(paths, warn);
    await run(paths, critical);
    const escalated = await run(paths, critical);
    expect(escalated.stdout).toContain("memory pressure is critical");
    const recovering = await run(paths, healthy);
    expect(recovering.stdout).not.toContain("Mac memory recovered");
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

  it("sends only one weekly Sunday health report", async () => {
    const paths = await fixture();
    const first = await run(paths, healthy);
    expect(first.stdout).toContain("Weekly Mac memory check: healthy");
    const second = await run(paths, healthy, Date.parse("2026-08-02T10:35:00+08:00"));
    expect(second.stdout).not.toContain("MEMORY_OBSERVER_NOTIFICATION");
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

  it("retries an alert when the notification command fails", async () => {
    const paths = await fixture();
    const notifier = path.join(paths.root, "notify.sh");
    await fs.writeFile(notifier, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await run(paths, warn, Date.now(), { dryRun: false, notifyCommand: notifier });
    await expect(
      run(paths, warn, Date.now(), { dryRun: false, notifyCommand: notifier }),
    ).rejects.toMatchObject({ code: 1 });
    await fs.writeFile(notifier, "#!/bin/sh\nprintf 'sent\\n'\n", { mode: 0o700 });
    const retried = await run(paths, warn, Date.now(), {
      dryRun: false,
      notifyCommand: notifier,
    });
    expect(retried.stdout).toContain("notification=sent");
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
});
