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
  let reservationRoot: string;
  let worktree: string;
  const token = "12345:test-token";

  const tokenHash = () => crypto.createHash("sha256").update(token).digest("hex");

  beforeEach(async () => {
    leaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-lease-"));
    reservationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-reservation-"));
    worktree = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-worktree-"));
    pidAliveMock.mockReset();
    startTimeMock.mockReset();
    pidAliveMock.mockReturnValue(false);
    startTimeMock.mockReturnValue(12345);
  });

  afterEach(async () => {
    await fs.rm(leaseRoot, { recursive: true, force: true });
    await fs.rm(reservationRoot, { recursive: true, force: true });
    await fs.rm(worktree, { recursive: true, force: true });
    vi.resetModules();
  });

  it("creates and releases a lease file", async () => {
    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const lease = await acquireTelegramTokenLease({
      token,
      accountId: "default",
      leaseRoot,
      reservationRoot,
    });

    const raw = await fs.readFile(lease.leasePath, "utf8");
    expect(raw).toContain('"accountId": "default"');
    expect(raw).toContain('"botId": "12345"');

    await lease.release();
    await expect(fs.readFile(lease.leasePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create scenario artifacts for an unreserved production token", async () => {
    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const lease = await acquireTelegramTokenLease({
      token,
      accountId: "default",
      leaseRoot,
      reservationRoot,
    });

    expect(await fs.readdir(reservationRoot)).toEqual([]);
    await lease.release();
    expect(await fs.readdir(reservationRoot)).toEqual([]);
  });

  it("keeps same-process reentrant acquires until the final release", async () => {
    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const first = await acquireTelegramTokenLease({
      token,
      leaseRoot,
      reservationRoot,
    });
    const second = await acquireTelegramTokenLease({
      token,
      leaseRoot,
      reservationRoot,
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
        reservationRoot,
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
      reservationRoot,
    });

    const next = JSON.parse(await fs.readFile(leasePath, "utf8")) as {
      pid: number;
      accountId: string;
    };
    expect(next.pid).toBe(currentPid);
    expect(next.accountId).toBe("default");

    await lease.release();
  });

  it("rejects a reserved tester token when runtime ownership metadata is missing", async () => {
    const existingHash = tokenHash();
    await fs.writeFile(
      path.join(reservationRoot, `12345-${existingHash}.json`),
      JSON.stringify({
        version: 1,
        tokenHash: existingHash,
        scenarioId: "scenario-a",
        worktreePath: worktree,
        generation: "generation-a",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const { TelegramTesterScenarioReservationConflictError } =
      await import("./telegram-tester-scenario-reservation.js");
    await expect(
      acquireTelegramTokenLease({
        token,
        leaseRoot,
        reservationRoot,
        worktree,
      }),
    ).rejects.toBeInstanceOf(TelegramTesterScenarioReservationConflictError);
  });

  it("rejects tester metadata when its durable reservation is absent", async () => {
    const existingHash = tokenHash();
    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const { TelegramTesterScenarioReservationConflictError } =
      await import("./telegram-tester-scenario-reservation.js");

    await expect(
      acquireTelegramTokenLease({
        token,
        leaseRoot,
        reservationRoot,
        worktree,
        scenarioId: "scenario-from-stale-env",
        scenarioGeneration: "generation-from-stale-env",
        scenarioTokenHash: existingHash,
      }),
    ).rejects.toBeInstanceOf(TelegramTesterScenarioReservationConflictError);
    expect(await fs.readdir(leaseRoot)).toEqual([]);
  });

  it("allows only the exact scenario generation and worktree to acquire the token lease", async () => {
    const existingHash = tokenHash();
    await fs.writeFile(
      path.join(reservationRoot, `12345-${existingHash}.json`),
      JSON.stringify({
        version: 1,
        tokenHash: existingHash,
        scenarioId: "scenario-a",
        worktreePath: worktree,
        generation: "generation-a",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const lease = await acquireTelegramTokenLease({
      token,
      leaseRoot,
      reservationRoot,
      worktree,
      scenarioId: "scenario-a",
      scenarioGeneration: "generation-a",
      scenarioTokenHash: existingHash,
    });
    expect(lease.owner.worktree).toBe(worktree);
    await lease.release();
  });

  it("scopes process-global tester metadata without blocking an unrelated named account", async () => {
    const defaultHash = tokenHash();
    await fs.writeFile(
      path.join(reservationRoot, `12345-${defaultHash}.json`),
      JSON.stringify({
        version: 1,
        tokenHash: defaultHash,
        scenarioId: "scenario-a",
        worktreePath: worktree,
        generation: "generation-a",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const namedToken = "67890:named-token";
    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const defaultLease = await acquireTelegramTokenLease({
      token,
      leaseRoot,
      reservationRoot,
      worktree,
      scenarioId: "scenario-a",
      scenarioGeneration: "generation-a",
      scenarioTokenHash: defaultHash,
    });
    const namedLease = await acquireTelegramTokenLease({
      token: namedToken,
      leaseRoot,
      reservationRoot,
      worktree,
      scenarioId: "scenario-a",
      scenarioGeneration: "generation-a",
      scenarioTokenHash: defaultHash,
    });

    expect(namedLease.owner.botId).toBe("67890");
    expect(await fs.readdir(reservationRoot)).toEqual([`12345-${defaultHash}.json`]);
    await namedLease.release();
    await defaultLease.release();
  });

  it("fails closed on partial tester metadata for its matching token", async () => {
    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const { TelegramTesterScenarioReservationConflictError } =
      await import("./telegram-tester-scenario-reservation.js");
    await expect(
      acquireTelegramTokenLease({
        token,
        leaseRoot,
        reservationRoot,
        worktree,
        scenarioId: "scenario-a",
        scenarioTokenHash: tokenHash(),
      }),
    ).rejects.toBeInstanceOf(TelegramTesterScenarioReservationConflictError);
  });

  it("fails closed when tester reservation state is malformed", async () => {
    const existingHash = tokenHash();
    await fs.writeFile(path.join(reservationRoot, `12345-${existingHash}.json`), "{ malformed\n");

    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const { TelegramTesterScenarioReservationConflictError } =
      await import("./telegram-tester-scenario-reservation.js");
    await expect(
      acquireTelegramTokenLease({
        token,
        leaseRoot,
        reservationRoot,
        worktree,
        scenarioId: "scenario-a",
        scenarioGeneration: "generation-a",
        scenarioTokenHash: existingHash,
      }),
    ).rejects.toBeInstanceOf(TelegramTesterScenarioReservationConflictError);
  });

  it("fails closed when a reservation has a blank worktree owner", async () => {
    const existingHash = tokenHash();
    await fs.writeFile(
      path.join(reservationRoot, `12345-${existingHash}.json`),
      JSON.stringify({
        version: 1,
        tokenHash: existingHash,
        scenarioId: "scenario-a",
        worktreePath: "",
        generation: "generation-a",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const { acquireTelegramTokenLease } = await import("./telegram-token-lease.js");
    const { TelegramTesterScenarioReservationConflictError } =
      await import("./telegram-tester-scenario-reservation.js");
    await expect(
      acquireTelegramTokenLease({
        token,
        leaseRoot,
        reservationRoot,
        worktree,
        scenarioId: "scenario-a",
        scenarioGeneration: "generation-a",
        scenarioTokenHash: existingHash,
      }),
    ).rejects.toBeInstanceOf(TelegramTesterScenarioReservationConflictError);
  });
});
