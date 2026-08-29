import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveSessionStore, type SessionEntry } from "../sessions.js";
import {
  clearPendingRestartConfirmation,
  consumePendingRestartConfirmationForSession,
  createPendingRestartConfirmation,
  expirePendingRestartConfirmation,
  getPendingRestartConfirmationStatus,
  readPendingRestartConfirmation,
  recordPendingRestartConfirmationForSession,
  writePendingRestartConfirmation,
} from "./restart-confirmation.js";

describe("restart confirmation helpers", () => {
  it("creates and reads a valid pending confirmation", () => {
    const pending = createPendingRestartConfirmation({ now: 1_000, ttlMs: 5_000 });
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 500,
      pendingRestartConfirmation: pending,
    };

    expect(readPendingRestartConfirmation(entry, 2_000)).toEqual(pending);
  });

  it("clears an expired pending confirmation", () => {
    const pending = createPendingRestartConfirmation({ now: 1_000, ttlMs: 500 });
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 500,
      pendingRestartConfirmation: pending,
    };

    const next = expirePendingRestartConfirmation(entry, 2_000);
    expect(next.pendingRestartConfirmation).toBeUndefined();
    expect(clearPendingRestartConfirmation(next)).toBe(next);
  });

  it("requires a later user turn before the confirmation is consumable", () => {
    const pending = createPendingRestartConfirmation({ now: 1_000, ttlMs: 5_000 });

    expect(
      getPendingRestartConfirmationStatus(
        {
          sessionId: "session-1",
          updatedAt: pending.requestedAt,
          pendingRestartConfirmation: pending,
        },
        2_000,
      ),
    ).toBe("awaiting-next-user-turn");

    expect(
      getPendingRestartConfirmationStatus(
        {
          sessionId: "session-1",
          updatedAt: pending.requestedAt + 1,
          pendingRestartConfirmation: pending,
        },
        2_000,
      ),
    ).toBe("ready");
  });
});

describe("restart confirmation store lifecycle", () => {
  async function createStore(): Promise<{ storePath: string; sessionKey: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-confirm-"));
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:dm:+15555550123";
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "session-1",
        updatedAt: 1_000,
      },
    });
    return { storePath, sessionKey };
  }

  it("records a pending confirmation without touching session activity timestamps", async () => {
    const { storePath, sessionKey } = await createStore();

    const entry = await recordPendingRestartConfirmationForSession({
      storePath,
      sessionKey,
      now: 5_000,
    });

    expect(entry?.updatedAt).toBe(1_000);
    expect(entry?.pendingRestartConfirmation).toMatchObject({
      scope: "gateway-restart-capable",
      requestedAt: 5_000,
    });
  });

  it("consumes a valid pending confirmation and clears it from the store", async () => {
    const { storePath, sessionKey } = await createStore();
    const pending = createPendingRestartConfirmation({ now: 5_000 });
    await saveSessionStore(storePath, {
      [sessionKey]: writePendingRestartConfirmation(
        {
          sessionId: "session-1",
          updatedAt: pending.requestedAt + 250,
        },
        pending,
      ),
    });

    const result = await consumePendingRestartConfirmationForSession({
      storePath,
      sessionKey,
      now: pending.requestedAt + 500,
    });

    expect(result.status).toBe("ready");
    expect(result.entry?.pendingRestartConfirmation).toBeUndefined();
  });

  it("expires and clears stale confirmations", async () => {
    const { storePath, sessionKey } = await createStore();
    const pending = createPendingRestartConfirmation({ now: 5_000, ttlMs: 100 });
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "session-1",
        updatedAt: pending.requestedAt + 250,
        pendingRestartConfirmation: pending,
      },
    });

    const result = await consumePendingRestartConfirmationForSession({
      storePath,
      sessionKey,
      now: pending.expiresAt + 1,
    });

    expect(result.status).toBe("expired");
    expect(result.entry?.pendingRestartConfirmation).toBeUndefined();
  });
});
