import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readListenerHealth,
  resolveListenerHealthStorePath,
  updateListenerHealth,
} from "./listener-health.js";

const OWNER = {
  instanceId: "a".repeat(48),
  profile: "test",
  pid: 1234,
  startedAtMs: 900,
};

async function tempStorePath(): Promise<{ root: string; storePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-listener-health-"));
  return { root, storePath: path.join(root, "listener-health.json") };
}

describe("listener health persistence", () => {
  it("resolves health state beside the isolated monitor store", () => {
    expect(
      resolveListenerHealthStorePath({
        monitorStorePath: "/tmp/openclaw-profile/monitors.json",
      }),
    ).toBe("/tmp/openclaw-profile/listener-health.json");
  });

  it("persists a healthy idle heartbeat and keeps it readable after the update", async () => {
    const { storePath } = await tempStorePath();

    const written = await updateListenerHealth({
      check: "success",
      owner: OWNER,
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
      nowMs: 10_000,
    });
    const read = await readListenerHealth({
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
      nowMs: 10_100,
    });

    expect(written.transition).toBeNull();
    expect(read.state).toBe("healthy");
    expect(read.record).toMatchObject({
      service: "telegram-user",
      owner: OWNER,
      lastSuccessfulCheckAtMs: 10_000,
      consecutiveFailures: 0,
    });
  });

  it("records the timestamp of a routed event independently from an idle poll", async () => {
    const { storePath } = await tempStorePath();

    await updateListenerHealth({
      check: "success",
      owner: OWNER,
      pollIntervalMs: 1_000,
      routedEvent: true,
      service: "whatsapp",
      storePath,
      nowMs: 20_000,
    });
    await updateListenerHealth({
      check: "success",
      owner: OWNER,
      pollIntervalMs: 1_000,
      routedEvent: false,
      service: "whatsapp",
      storePath,
      nowMs: 21_000,
    });

    const read = await readListenerHealth({
      pollIntervalMs: 1_000,
      service: "whatsapp",
      storePath,
      nowMs: 21_100,
    });
    expect(read.record).toMatchObject({
      lastSuccessfulCheckAtMs: 21_000,
      lastRoutedEventAtMs: 20_000,
    });
  });

  it("bounds and sanitizes failures without persisting secrets or message bodies", async () => {
    const { storePath } = await tempStorePath();
    const secret = "Authorization: Bearer super-secret-token";
    const body = "message body: customer private reply";

    await updateListenerHealth({
      check: "failure",
      error: `${secret}; ${body}; ${"x".repeat(2_000)}`,
      owner: OWNER,
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
      nowMs: 30_000,
    });

    const raw = await fs.readFile(storePath, "utf8");
    const read = await readListenerHealth({
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
      nowMs: 30_100,
    });
    expect(raw).not.toContain("super-secret-token");
    expect(raw).not.toContain(body);
    expect(read.record.lastError).toEqual(expect.any(String));
    expect((read.record.lastError ?? "").length).toBeLessThanOrEqual(512);
  });

  it("does not persist unlabeled backend text, selectors, tokens, or paths", async () => {
    const { storePath } = await tempStorePath();
    const privateFailure =
      "customer wrote swordfish in @private_chat using tok_live_123 from /Users/alice/account.session";

    await updateListenerHealth({
      check: "failure",
      error: privateFailure,
      owner: OWNER,
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
      nowMs: 35_000,
    });

    const raw = await fs.readFile(storePath, "utf8");
    expect(raw).not.toContain("swordfish");
    expect(raw).not.toContain("@private_chat");
    expect(raw).not.toContain("tok_live_123");
    expect(raw).not.toContain("account.session");
    expect(raw).toContain("listener_check_failed");
  });

  it("emits one degraded transition after consecutive failures and one recovery transition", async () => {
    const { storePath } = await tempStorePath();
    const options = {
      error: "backend unavailable",
      owner: OWNER,
      pollIntervalMs: 1_000,
      service: "whatsapp" as const,
      storePath,
    };

    const first = await updateListenerHealth({ ...options, check: "failure", nowMs: 40_000 });
    const second = await updateListenerHealth({ ...options, check: "failure", nowMs: 41_000 });
    const third = await updateListenerHealth({ ...options, check: "failure", nowMs: 42_000 });
    const fourth = await updateListenerHealth({ ...options, check: "failure", nowMs: 43_000 });
    const recovered = await updateListenerHealth({
      check: "success",
      owner: OWNER,
      pollIntervalMs: 1_000,
      service: "whatsapp",
      storePath,
      nowMs: 44_000,
    });
    const stable = await updateListenerHealth({
      check: "success",
      owner: OWNER,
      pollIntervalMs: 1_000,
      service: "whatsapp",
      storePath,
      nowMs: 45_000,
    });

    expect(first.transition).toBeNull();
    expect(second.transition).toBeNull();
    expect(third.transition).toBe("degraded");
    expect(fourth.transition).toBeNull();
    expect(recovered.transition).toBe("recovered");
    expect(stable.transition).toBeNull();
    expect(recovered.state).toBe("healthy");
    expect(recovered.record).toMatchObject({ consecutiveFailures: 0 });
  });

  it("marks an idle listener stale without conflating staleness with degraded failures", async () => {
    const { storePath } = await tempStorePath();
    await updateListenerHealth({
      check: "success",
      owner: OWNER,
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
      nowMs: 50_000,
    });

    const read = await readListenerHealth({
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
      nowMs: 81_000,
    });
    expect(read.state).toBe("stale");
    expect(read.record).toMatchObject({ consecutiveFailures: 0 });
  });

  it("writes a private health file atomically in a private directory", async () => {
    const { root } = await tempStorePath();
    const privateDir = path.join(root, "new-private-parent");
    const storePath = path.join(privateDir, "listener-health.json");
    await updateListenerHealth({
      check: "success",
      owner: OWNER,
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath,
      nowMs: 60_000,
    });

    expect((await fs.stat(privateDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(privateDir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
