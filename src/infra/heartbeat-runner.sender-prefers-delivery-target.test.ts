import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  addHeartbeatSessionStoreEntry,
  seedMainSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

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
          return {
            text: `<heartbeat_attention>
{"items":[{"key":"passport-photo","fingerprint":"still-missing","title":"Passport photo needed","text":"Still waiting for the passport photo.","urgency":"normal","category":"personal","destination":{"kind":"telegram_topic","chatId":"-1003841603622","threadId":928}}]}
</heartbeat_attention>`,
          };
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

  it("fans out mixed heartbeat items to silent task topics and one compact DM pager", async () => {
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
        });
        await addHeartbeatSessionStoreEntry(storePath, "agent:main:telegram:topic:3030", {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "-1003783709877",
          origin: {
            provider: "telegram",
            to: "-1003783709877",
            accountId: "default",
            threadId: 3030,
          },
        });
        await addHeartbeatSessionStoreEntry(storePath, "agent:main:telegram:topic:3188", {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "-1003783709877",
          origin: {
            provider: "telegram",
            to: "-1003783709877",
            accountId: "default",
            threadId: 3188,
          },
        });

        replySpy.mockImplementation(async (ctx: Record<string, unknown>) => {
          expect(ctx.Body).toContain("Heartbeat attention delivery contract:");
          expect(ctx.Body).toContain("Return a maximum of 3 items.");
          expect(ctx.Body).toContain("chatId=-1003783709877 | threadId=3030");
          return {
            text: `<heartbeat_attention>
{"items":[
{"key":"ten-call","fingerprint":"confirmed-11:00","title":"Ten call","text":"Starts at 11:00 Bali.","urgency":"urgent","category":"commitment","destination":{"kind":"pager"}},
{"key":"empower","fingerprint":"monitor-expired","title":"Empower","text":"Choose whether to continue the settlement escalation.","urgency":"normal","category":"build","destination":{"kind":"telegram_topic","chatId":"-1003783709877","threadId":3030}},
{"key":"dld","fingerprint":"case-closed-again","title":"RDC/DLD","text":"Choose whether to reopen or escalate.","urgency":"normal","category":"build","destination":{"kind":"telegram_topic","chatId":"-1003783709877","threadId":3188}}
]}
</heartbeat_attention>`,
          };
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
            nowMs: () => 10_000,
          },
        });

        expect(sendTelegram).toHaveBeenCalledTimes(3);
        expect(sendTelegram).toHaveBeenNthCalledWith(
          1,
          "-1003783709877",
          "Choose whether to continue the settlement escalation.",
          expect.objectContaining({ messageThreadId: 3030, silent: true }),
        );
        expect(sendTelegram).toHaveBeenNthCalledWith(
          2,
          "-1003783709877",
          "Choose whether to reopen or escalate.",
          expect.objectContaining({ messageThreadId: 3188, silent: true }),
        );
        expect(sendTelegram).toHaveBeenNthCalledWith(
          3,
          "123456",
          expect.stringContaining("Ten call"),
          expect.not.objectContaining({ silent: true }),
        );
        expect(sendTelegram.mock.calls[2]?.[1]).toContain("https://t.me/c/3783709877/3030");
        expect(sendTelegram.mock.calls[2]?.[1]).toContain("https://t.me/c/3783709877/3188");

        const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
          string,
          { heartbeatAttentionState?: Array<{ key?: string }> }
        >;
        const mainEntry = Object.values(store)[0];
        expect(mainEntry?.heartbeatAttentionState?.map((entry) => entry.key)).toEqual([
          "ten-call",
          "empower",
          "dld",
        ]);
      },
      { prefix: "openclaw-hb-" },
    );
  });

  it("does not enter typed fan-out when Telegram alerts are hidden", async () => {
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
          channels: {
            telegram: {
              botToken: "telegram-test",
              heartbeat: { showOk: false, showAlerts: false, useIndicator: true },
            },
          },
          session: { store: storePath },
        };
        await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "telegram:123456",
        });
        replySpy.mockImplementation(async (ctx: Record<string, unknown>) => {
          expect(ctx.Body).not.toContain("Heartbeat attention delivery contract:");
          return {
            text: `<heartbeat_attention>
{"items":[{"key":"hidden-alert","fingerprint":"new","title":"Hidden","text":"Do not send.","urgency":"normal","category":"other","destination":{"kind":"pager"}}]}
</heartbeat_attention>`,
          };
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
            nowMs: () => 10_000,
          },
        });

        expect(sendTelegram).not.toHaveBeenCalled();
      },
      { prefix: "openclaw-hb-" },
    );
  });

  it("keeps the existing reasoning delivery path when reasoning is enabled", async () => {
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
                includeReasoning: true,
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
        });
        replySpy.mockImplementation(async (ctx: Record<string, unknown>) => {
          expect(ctx.Body).not.toContain("Heartbeat attention delivery contract:");
          return [{ text: "Reasoning:\n_Because it helps_" }, { text: "Final alert" }];
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
            nowMs: () => 10_000,
          },
        });

        expect(sendTelegram).toHaveBeenNthCalledWith(
          1,
          "123456",
          "Reasoning:\n_Because it helps_",
          expect.any(Object),
        );
        expect(sendTelegram).toHaveBeenNthCalledWith(
          2,
          "123456",
          "Final alert",
          expect.any(Object),
        );
      },
      { prefix: "openclaw-hb-" },
    );
  });

  it("suppresses unchanged typed items without emitting a shorter repeat", async () => {
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
          heartbeatAttentionState: [
            {
              key: "empower",
              fingerprint: "monitor-expired",
              title: "Empower",
              deliveredAt: 1,
              urgency: "normal",
              destination: "telegram:-1003783709877:topic:3030",
            },
          ],
        });

        replySpy.mockResolvedValue({
          text: `<heartbeat_attention>
{"items":[{"key":"empower","fingerprint":"monitor-expired","title":"Empower, still waiting","text":"No reply yet.","urgency":"normal","category":"build","destination":{"kind":"telegram_topic","chatId":"-1003783709877","threadId":3030}}]}
</heartbeat_attention>`,
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
            nowMs: () => 10_000,
          },
        });

        expect(sendTelegram).not.toHaveBeenCalled();
      },
      { prefix: "openclaw-hb-" },
    );
  });

  it("fails malformed typed output back to the configured DM pager, not the source topic", async () => {
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
        replySpy.mockResolvedValue({
          text: "<heartbeat_attention>{bad json}</heartbeat_attention>",
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
            nowMs: () => 10_000,
          },
        });

        expect(sendTelegram).toHaveBeenCalledTimes(1);
        expect(sendTelegram).toHaveBeenCalledWith(
          "123456",
          "<heartbeat_attention>{bad json}</heartbeat_attention>",
          expect.not.objectContaining({ messageThreadId: 928 }),
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
