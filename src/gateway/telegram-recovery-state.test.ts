import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTelegramRecoveryStateStore,
  resolveTelegramRecoveryStatePath,
} from "./telegram-recovery-state.js";

describe("Telegram recovery durable state", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-recovery-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("survives store replacement atomically without persisting error text or secrets", async () => {
    const now = Date.parse("2026-07-16T08:00:00.000Z");
    const first = createTelegramRecoveryStateStore({ stateDir });
    await first.set("default", {
      phase: "gateway-restart-requested",
      providerRestartAttempts: 2,
      reason: "token=123456:SECRET",
      updatedAt: now,
    });

    const statePath = resolveTelegramRecoveryStatePath(stateDir, "default");
    const raw = await fs.readFile(statePath, "utf8");
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("reason");
    expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(statePath))).mode & 0o777).toBe(0o700);

    // A new instance has no process memory from the writer, matching external
    // gateway process replacement rather than monitor-only hot reload.
    const replacement = createTelegramRecoveryStateStore({ stateDir });
    const restored = await replacement.load(now + 1_000);
    expect(restored.incidents.get("default")).toMatchObject({
      phase: "gateway-restart-requested",
      providerRestartAttempts: 2,
      updatedAt: now,
    });

    await replacement.clear("default");
    expect((await first.load(now + 2_000)).incidents.size).toBe(0);
  });

  it("expires stale restart authority to terminal exhausted instead of resetting its budget", async () => {
    const now = Date.parse("2026-07-16T08:00:00.000Z");
    const store = createTelegramRecoveryStateStore({ stateDir, maxRecordAgeMs: 1_000 });
    await store.set("default", {
      phase: "gateway-restart-requested",
      providerRestartAttempts: 2,
      updatedAt: now - 1_001,
    });

    const restored = await store.load(now);
    expect(restored.incidents.get("default")).toMatchObject({
      phase: "exhausted",
      providerRestartAttempts: 2,
      // Keep the original incident boundary so a later successful getUpdates
      // remains capable of clearing the terminal record.
      updatedAt: now - 1_001,
    });

    const replacement = createTelegramRecoveryStateStore({ stateDir, maxRecordAgeMs: 1_000 });
    expect((await replacement.load(now + 1)).incidents.get("default")?.phase).toBe("exhausted");
  });

  it("normalizes attributable malformed state to a fresh terminal record", async () => {
    const now = Date.parse("2026-07-16T08:00:00.000Z");
    const statePath = resolveTelegramRecoveryStatePath(stateDir, "default");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 99,
        accountId: "default",
        phase: "restart-again",
        providerRestartAttempts: -1,
        updatedAt: now + 60 * 60_000,
      }),
    );

    const store = createTelegramRecoveryStateStore({ stateDir });
    expect((await store.load(now)).incidents.get("default")).toMatchObject({
      phase: "exhausted",
      providerRestartAttempts: 0,
      updatedAt: now,
    });
  });

  it("rejects every ASCII control character in account ids", async () => {
    const store = createTelegramRecoveryStateStore({ stateDir });
    const incident = {
      phase: "provider-restart" as const,
      providerRestartAttempts: 0,
      updatedAt: Date.parse("2026-07-16T08:00:00.000Z"),
    };

    for (const codePoint of [...Array.from({ length: 0x20 }, (_, index) => index), 0x7f]) {
      await expect(
        store.set(`account${String.fromCodePoint(codePoint)}`, incident),
      ).rejects.toThrow("invalid Telegram recovery account id");
    }

    // Adjacent printable ASCII and non-ASCII Unicode remain valid identifiers.
    await expect(store.set("account ~é", incident)).resolves.toBeUndefined();
  });
});
