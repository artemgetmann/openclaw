import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireTelegramTesterScenarioReservation,
  findTelegramTesterScenarioReservation,
  releaseTelegramTesterScenarioReservation,
  resolveTelegramTesterScenarioReservationPath,
} from "../../scripts/lib/telegram-tester-scenario-reservations.mjs";

describe("Telegram tester scenario reservations", () => {
  const token = "12345:test-token";

  it("survives process restarts for the same scenario and worktree", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-resume-"));
    const first = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "booking-acceptance-1",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
    });
    const resumed = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "booking-acceptance-1",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
    });

    expect(first).toMatchObject({
      ok: true,
      action: "created",
      safeReuseRequired: true,
    });
    expect(resumed).toMatchObject({
      ok: true,
      action: "resumed",
      generation: first.generation,
      safeReuseRequired: false,
    });
  });

  it("fails closed when a scenario reservation filename or fingerprint is not canonical", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-identity-"));
    const scenarioId = "booking-acceptance-identity";
    const worktreePath = "/tmp/worktree-identity";
    const reservedToken = "222:reserved-token";
    const otherToken = "111:other-token";
    const acquired = await acquireTelegramTesterScenarioReservation({
      token: reservedToken,
      scenarioId,
      worktreePath,
      reservationRoot,
    });
    expect(acquired.ok).toBe(true);

    const canonicalPath = resolveTelegramTesterScenarioReservationPath({
      token: reservedToken,
      reservationRoot,
    });
    const wrongPath = resolveTelegramTesterScenarioReservationPath({
      token: otherToken,
      reservationRoot,
    });
    renameSync(canonicalPath, wrongPath);

    await expect(
      findTelegramTesterScenarioReservation({
        scenarioId,
        worktreePath,
        reservationRoot,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "reservation_identity_mismatch_manual_recovery_required",
      reservationPaths: [wrongPath],
    });

    // A canonical path is still not ownership proof when the fingerprint does
    // not bind to the payload's full token hash.
    renameSync(wrongPath, canonicalPath);
    const mismatchedFingerprint = JSON.parse(readFileSync(canonicalPath, "utf8"));
    mismatchedFingerprint.tokenFingerprint =
      mismatchedFingerprint.tokenFingerprint === "000000000000" ? "111111111111" : "000000000000";
    writeFileSync(canonicalPath, `${JSON.stringify(mismatchedFingerprint, null, 2)}\n`);

    await expect(
      findTelegramTesterScenarioReservation({
        scenarioId,
        worktreePath,
        reservationRoot,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "reservation_identity_mismatch_manual_recovery_required",
      reservationPaths: [canonicalPath],
    });
  });

  it("requires explicit release for an expired same-owner generation", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-expired-owner-"));
    const nowMs = Date.parse("2026-07-24T00:00:00.000Z");
    const first = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "booking-acceptance-expired",
      worktreePath: "/tmp/worktree-expired",
      reservationRoot,
      nowMs,
      ttlMs: 1_000,
    });
    expect(first.ok).toBe(true);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const stillPolling = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "booking-acceptance-expired",
      worktreePath: "/tmp/worktree-expired",
      reservationRoot,
      nowMs: nowMs + 2_000,
      ttlMs: 1_000,
      expectedGeneration: String(first.generation),
      expectedTokenHash: tokenHash,
      requireExpectedOwner: true,
      hasActivePollingLease: () => [
        {
          token,
          worktreePath: "/tmp/worktree-expired",
          pid: 1234,
        },
      ],
    });
    expect(stillPolling).toMatchObject({
      ok: false,
      reason: "expired_owner_release_required",
    });

    const stopped = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "booking-acceptance-expired",
      worktreePath: "/tmp/worktree-expired",
      reservationRoot,
      nowMs: nowMs + 2_000,
      ttlMs: 1_000,
      expectedGeneration: String(first.generation),
      expectedTokenHash: tokenHash,
      requireExpectedOwner: true,
      hasActivePollingLease: false,
    });
    expect(stopped).toMatchObject({
      ok: false,
      reason: "expired_owner_release_required",
    });
    const persisted = JSON.parse(
      readFileSync(
        resolveTelegramTesterScenarioReservationPath({ token, reservationRoot }),
        "utf8",
      ),
    );
    expect(persisted.generation).toBe(first.generation);
  });

  it("allows exactly one concurrent scenario to reserve a token", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-race-"));
    const contenders = await Promise.all([
      acquireTelegramTesterScenarioReservation({
        token,
        scenarioId: "scenario-a",
        worktreePath: "/tmp/worktree-a",
        reservationRoot,
      }),
      acquireTelegramTesterScenarioReservation({
        token,
        scenarioId: "scenario-b",
        worktreePath: "/tmp/worktree-b",
        reservationRoot,
      }),
    ]);

    expect(contenders.filter((result) => result.ok)).toHaveLength(1);
    expect(contenders.filter((result) => !result.ok)).toHaveLength(1);
  });

  it("rechecks a newly active PID lease while the reservation lock is held", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-lease-race-"));
    let leaseChecks = 0;

    const acquired = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-racing-runtime",
      worktreePath: "/tmp/worktree-racing-runtime",
      reservationRoot,
      hasActivePollingLease: async () => {
        leaseChecks += 1;
        return [
          {
            token,
            worktreePath: "/tmp/worktree-racing-runtime",
            pid: 1234,
          },
        ];
      },
    });

    expect(leaseChecks).toBe(1);
    expect(acquired).toMatchObject({ ok: false, reason: "leased_elsewhere" });
    expect(
      existsSync(resolveTelegramTesterScenarioReservationPath({ token, reservationRoot })),
    ).toBe(false);
  });

  it("resumes only when an active PID lease matches the durable scenario owner", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-owned-lease-"));
    const first = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
    });
    expect(first.ok).toBe(true);

    const resumed = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
      hasActivePollingLease: () => [
        {
          token,
          worktreePath: "/tmp/worktree-a",
          pid: 1234,
        },
      ],
    });
    expect(resumed).toMatchObject({
      ok: true,
      action: "resumed",
      generation: first.generation,
    });

    const foreignLease = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
      hasActivePollingLease: () => [
        {
          token,
          worktreePath: "/tmp/worktree-b",
          pid: 5678,
        },
      ],
    });
    expect(foreignLease).toMatchObject({ ok: false, reason: "leased_elsewhere" });
  });

  it("fails closed when the local restart credential does not match the durable owner", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-generation-aba-"));
    const first = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
    });
    expect(first.ok).toBe(true);

    const mismatched = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
      expectedGeneration: "stale-local-generation",
      expectedTokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      requireExpectedOwner: true,
    });
    expect(mismatched).toMatchObject({
      ok: false,
      reason: "owner_generation_mismatch",
    });
  });

  it("fails closed on a crash-persistent lock instead of unlinking ambiguous ownership", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-stale-lock-"));
    const reservationPath = resolveTelegramTesterScenarioReservationPath({
      token,
      reservationRoot,
    });
    mkdirSync(`${reservationPath}.lock`);
    writeFileSync(
      path.join(`${reservationPath}.lock`, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: 999_999_999,
        createdAt: new Date(0).toISOString(),
      })}\n`,
    );

    const acquired = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-after-crash",
      worktreePath: "/tmp/worktree-after-crash",
      reservationRoot,
    });

    expect(acquired).toMatchObject({
      ok: false,
      reason: "reservation_lock_present_manual_recovery_required",
    });
    expect(existsSync(`${reservationPath}.lock`)).toBe(true);
    expect(existsSync(reservationPath)).toBe(false);
  });

  it("fails closed on malformed reservation state", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-malformed-"));
    const reservationPath = resolveTelegramTesterScenarioReservationPath({
      token,
      reservationRoot,
    });
    writeFileSync(reservationPath, "{ definitely-not-json\n");

    const acquired = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-b",
      worktreePath: "/tmp/worktree-b",
      reservationRoot,
    });

    expect(acquired).toMatchObject({ ok: false, reason: "malformed_reservation" });
    expect(readFileSync(reservationPath, "utf8")).toBe("{ definitely-not-json\n");
  });

  it("fails closed on structurally malformed valid JSON instead of reclaiming it", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-structural-"));
    const reservationPath = resolveTelegramTesterScenarioReservationPath({
      token,
      reservationRoot,
    });
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    writeFileSync(
      reservationPath,
      `${JSON.stringify({
        version: 1,
        tokenHash,
        tokenFingerprint: tokenHash.slice(0, 12),
        botId: "12345",
        scenarioId: "",
        worktreePath: "",
        generation: "",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-07-02T00:00:00.000Z",
      })}\n`,
    );

    const acquired = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-b",
      worktreePath: "/tmp/worktree-b",
      reservationRoot,
      nowMs: Date.parse("2026-07-24T00:00:00.000Z"),
      hasActivePollingLease: false,
    });

    expect(acquired).toMatchObject({ ok: false, reason: "malformed_reservation" });
    expect(readFileSync(reservationPath, "utf8")).toContain('"scenarioId":""');
  });

  it("requires exact ownership for release before another scenario can acquire", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-release-"));
    const first = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
    });
    expect(first.ok).toBe(true);
    const envLocalPath = path.join(reservationRoot, ".env.local");
    writeFileSync(
      envLocalPath,
      [
        `TELEGRAM_BOT_TOKEN=${token}`,
        "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=scenario-a",
        `OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION=${String(first.generation)}`,
        `OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH=${crypto.createHash("sha256").update(token).digest("hex")}`,
        `OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION=${String(first.generation)}`,
        `OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH=${crypto.createHash("sha256").update(token).digest("hex")}`,
        "OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID=default",
        "KEEP_ME=yes",
        "",
      ].join("\n"),
    );

    const wrongOwnerRelease = await releaseTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      generation: "wrong-generation",
      reservationRoot,
      envLocalPath,
    });
    expect(wrongOwnerRelease).toMatchObject({ ok: false, reason: "owner_mismatch" });
    expect(readFileSync(envLocalPath, "utf8")).toContain(`TELEGRAM_BOT_TOKEN=${token}`);

    const blocked = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-b",
      worktreePath: "/tmp/worktree-b",
      reservationRoot,
    });
    expect(blocked).toMatchObject({ ok: false, reason: "reserved_elsewhere" });

    const released = await releaseTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      generation: String(first.generation),
      reservationRoot,
      envLocalPath,
    });
    expect(released).toMatchObject({ ok: true, reason: "released" });
    expect(readFileSync(envLocalPath, "utf8")).toBe("KEEP_ME=yes\n");

    const next = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-b",
      worktreePath: "/tmp/worktree-b",
      reservationRoot,
    });
    expect(next).toMatchObject({ ok: true, action: "created", safeReuseRequired: true });
    expect(next.generation).not.toBe(first.generation);
  });

  it("reclaims an expired reservation only with evidence that no polling lease is active", async () => {
    const reservationRoot = mkdtempSync(path.join(os.tmpdir(), "tg-scenario-expiry-"));
    const nowMs = Date.parse("2026-07-24T00:00:00.000Z");
    const first = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-a",
      worktreePath: "/tmp/worktree-a",
      reservationRoot,
      nowMs,
      ttlMs: 1_000,
    });
    expect(first.ok).toBe(true);

    const activeLease = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-b",
      worktreePath: "/tmp/worktree-b",
      reservationRoot,
      nowMs: nowMs + 2_000,
      ttlMs: 1_000,
      hasActivePollingLease: true,
    });
    expect(activeLease).toMatchObject({ ok: false, reason: "expired_but_leased" });

    const reclaimed = await acquireTelegramTesterScenarioReservation({
      token,
      scenarioId: "scenario-b",
      worktreePath: "/tmp/worktree-b",
      reservationRoot,
      nowMs: nowMs + 2_000,
      ttlMs: 1_000,
      hasActivePollingLease: false,
    });
    expect(reclaimed).toMatchObject({
      ok: true,
      action: "reclaimed_expired",
      safeReuseRequired: true,
    });
  });
});
