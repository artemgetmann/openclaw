import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pidAliveMock = vi.fn<(pid: number) => boolean>();
const startTimeMock = vi.fn<(pid: number) => number | null>();

vi.mock("../shared/pid-alive.js", () => ({
  isPidAlive: pidAliveMock,
  getProcessStartTime: startTimeMock,
}));

describe("telegram token lease", () => {
  let leaseRoot: string;
  const token = "12345:test-token";

  const tokenHash = () => crypto.createHash("sha256").update(token).digest("hex");

  beforeEach(async () => {
    leaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-lease-"));
    pidAliveMock.mockReset();
    startTimeMock.mockReset();
    pidAliveMock.mockReturnValue(false);
    startTimeMock.mockReturnValue(12345);
  });

  afterEach(async () => {
    await fs.rm(leaseRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("creates and releases a lease file", async () => {
    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const lease = await acquireTelegramTokenLease({
      token,
      accountId: "default",
      leaseRoot,
    });

    const raw = await fs.readFile(lease.leasePath, "utf8");
    expect(raw).toContain('"accountId": "default"');
    expect(raw).toContain('"botId": "12345"');

    await lease.release();
    await expect(fs.readFile(lease.leasePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps same-process reentrant acquires until the final release", async () => {
    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const first = await acquireTelegramTokenLease({
      token,
      leaseRoot,
    });
    const second = await acquireTelegramTokenLease({
      token,
      leaseRoot,
    });

    await first.release();
    expect(await fs.readFile(second.leasePath, "utf8")).toContain('"pid"');

    await second.release();
    await expect(fs.readFile(second.leasePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects when another active runtime owns the token", async () => {
    const currentPid = process.pid;
    pidAliveMock.mockImplementation((pid) => pid === 99991);
    startTimeMock.mockImplementation((pid) => (pid === currentPid ? 12345 : 22222));

    const existingHash = tokenHash();
    const leasePath = path.join(leaseRoot, `12345-${existingHash}.json`);
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(
      leasePath,
      JSON.stringify(
        {
          version: 1,
          pid: 99991,
          starttime: 22222,
          createdAt: new Date().toISOString(),
          tokenHash: existingHash,
          tokenFingerprint: "deadbeefcafe",
          botId: "12345",
          accountId: "finance",
          configPath: "/tmp/other.json",
          worktree: "/tmp/other-worktree",
        },
        null,
        2,
      ),
    );

    const { acquireTelegramTokenLease, TelegramTokenLeaseConflictError } =
      await import("./telegram-token-lease.js");
    await expect(
      acquireTelegramTokenLease({
        token,
        accountId: "default",
        leaseRoot,
      }),
    ).rejects.toBeInstanceOf(TelegramTokenLeaseConflictError);
  });

  it("reclaims stale leases and replaces them with the current runtime", async () => {
    const currentPid = process.pid;
    pidAliveMock.mockReturnValue(false);
    startTimeMock.mockReturnValue(12345);

    const existingHash = tokenHash();
    const leasePath = path.join(leaseRoot, `12345-${existingHash}.json`);
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(
      leasePath,
      JSON.stringify(
        {
          version: 1,
          pid: 99991,
          starttime: 22222,
          createdAt: new Date().toISOString(),
          tokenHash: existingHash,
          tokenFingerprint: "stalelease01",
          botId: "12345",
          accountId: "finance",
          configPath: "/tmp/stale.json",
          worktree: "/tmp/stale-worktree",
        },
        null,
        2,
      ),
    );

    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const lease = await acquireTelegramTokenLease({
      token,
      accountId: "default",
      leaseRoot,
    });

    const next = JSON.parse(await fs.readFile(leasePath, "utf8")) as {
      pid: number;
      accountId: string;
    };
    expect(next.pid).toBe(currentPid);
    expect(next.accountId).toBe("default");

    await lease.release();
  });
});
