import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { telegramUserMonitorPollCommand } from "../commands/telegram-user.js";
import { whatsappMonitorPollCommand } from "../commands/whatsapp-monitor.js";
import type { RuntimeEnv } from "../runtime.js";
import { readListenerHealth, resolveListenerHealthStorePath } from "./listener-health.js";

async function createEmptyMonitorStore(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-listener-health-loop-"));
  const monitorStorePath = path.join(root, "monitors.json");
  await fs.writeFile(monitorStorePath, JSON.stringify({ monitors: [], version: 1 }), "utf8");
  return monitorStorePath;
}

const runtime = { error: vi.fn(), log: vi.fn() } as unknown as RuntimeEnv;

describe("managed listener loop health integration", () => {
  it("writes a healthy Telegram idle poll that the status reader can consume", async () => {
    const monitorStorePath = await createEmptyMonitorStore();
    await telegramUserMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        maxRuns: 1,
        monitorStore: monitorStorePath,
        pollIntervalMs: 1_000,
        watch: true,
      },
      runtime,
    );

    const snapshot = await readListenerHealth({
      pollIntervalMs: 1_000,
      service: "telegram-user",
      storePath: resolveListenerHealthStorePath({ monitorStorePath }),
    });
    expect(snapshot).toMatchObject({
      state: "healthy",
      record: { consecutiveFailures: 0, owner: { pid: process.pid } },
    });
  });

  it("writes a healthy WhatsApp idle poll that the status reader can consume", async () => {
    const monitorStorePath = await createEmptyMonitorStore();
    await whatsappMonitorPollCommand(
      {
        commitWithoutDispatch: true,
        dbPath: path.join(path.dirname(monitorStorePath), "wacli.db"),
        maxRuns: 1,
        monitorStore: monitorStorePath,
        pollIntervalMs: 1_000,
        watch: true,
      },
      runtime,
    );

    const snapshot = await readListenerHealth({
      pollIntervalMs: 1_000,
      service: "whatsapp",
      storePath: resolveListenerHealthStorePath({ monitorStorePath }),
    });
    expect(snapshot).toMatchObject({
      state: "healthy",
      record: { consecutiveFailures: 0, owner: { pid: process.pid } },
    });
  });
});
