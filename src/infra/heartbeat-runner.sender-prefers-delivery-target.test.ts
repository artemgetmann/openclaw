import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

installHeartbeatRunnerTestRuntime({ includeSlack: true });

describe("runHeartbeatOnce", () => {
  it("uses the delivery target as sender when lastTo differs", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "slack",
                to: "C0A9P2N8QHY",
              },
            },
          },
          session: { store: storePath },
        };

        await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "1644620762",
        });

        replySpy.mockImplementation(async (ctx: { To?: string; From?: string }) => {
          expect(ctx.To).toBe("C0A9P2N8QHY");
          expect(ctx.From).toBe("C0A9P2N8QHY");
          return { text: "ok" };
        });

        const sendSlack = vi.fn().mockResolvedValue({
          messageId: "m1",
          channelId: "C0A9P2N8QHY",
        });

        await runHeartbeatOnce({
          cfg,
          deps: {
            slack: sendSlack,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(sendSlack).toHaveBeenCalled();
      },
      { prefix: "openclaw-hb-" },
    );
  });

  it("routes actionable heartbeat nudges to the source topic while preserving pager/source metadata", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "telegram",
                to: "telegram:123456",
              },
            },
          },
          channels: { telegram: { botToken: "telegram-test" } },
          session: { store: storePath },
        };

        await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "telegram:123456",
          origin: {
            provider: "telegram",
            to: "telegram:group:-1003841603622",
            accountId: "default",
            threadId: 928,
          },
        });

        replySpy.mockImplementation(async (ctx: Record<string, unknown>) => {
          expect(ctx.To).toBe("-1003841603622");
          expect(ctx.From).toBe("-1003841603622");
          expect(ctx.OriginatingChannel).toBe("telegram");
          expect(ctx.OriginatingTo).toBe("telegram:group:-1003841603622");
          expect(ctx.MessageThreadId).toBe(928);
          expect(ctx.AccountId).toBe("default");
          expect(ctx.Body).toContain("Task topic is the workbench; DM is only a pager");
          expect(ctx.Body).toContain("https://t.me/c/3841603622/928");
          expect(ctx.SourceReceipt).toMatchObject({
            sourceTo: "telegram:group:-1003841603622",
            sourceThreadId: 928,
            sourceAccountId: "default",
          });
          return { text: "Still waiting for the passport photo." };
        });

        const sendTelegram = vi.fn().mockResolvedValue({
          messageId: "m1",
          chatId: "123456",
        });

        await runHeartbeatOnce({
          cfg,
          deps: {
            telegram: sendTelegram,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(sendTelegram).toHaveBeenCalledWith(
          "-1003841603622",
          "Still waiting for the passport photo.",
          expect.objectContaining({ messageThreadId: 928, accountId: "default" }),
        );
      },
      { prefix: "openclaw-hb-" },
    );
  });

  it("keeps HEARTBEAT_OK delivery off the source topic when topic-first alert routing is available", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "telegram",
                to: "telegram:123456",
              },
            },
          },
          channels: { telegram: { botToken: "telegram-test", heartbeat: { showOk: true } } },
          session: { store: storePath },
        };

        await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "telegram:123456",
          origin: {
            provider: "telegram",
            to: "telegram:group:-1003841603622",
            accountId: "default",
            threadId: 928,
          },
        });

        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        const sendTelegram = vi.fn().mockResolvedValue({
          messageId: "m1",
          chatId: "123456",
        });

        await runHeartbeatOnce({
          cfg,
          deps: {
            telegram: sendTelegram,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(sendTelegram).toHaveBeenCalledTimes(1);
        expect(sendTelegram).toHaveBeenCalledWith(
          "123456",
          "HEARTBEAT_OK",
          expect.not.objectContaining({ messageThreadId: 928 }),
        );
      },
      { prefix: "openclaw-hb-" },
    );
  });
});
