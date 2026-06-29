import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../../extensions/telegram/src/runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const cfg = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
    msteams: {},
  },
  tools: {
    message: {
      crossContext: {
        allowAcrossProviders: true,
      },
    },
  },
} as OpenClawConfig;

describe("runMessageAction heartbeat source receipt", () => {
  let sendExternal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const runtime = createPluginRuntime();
    setTelegramRuntime(runtime);
    sendExternal = vi.fn().mockResolvedValue({ messageId: "external-1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "msteams",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ to, text }) => {
                await (sendExternal as (to: string, text: string) => Promise<unknown>)(to, text);
                return { channel: "msteams", messageId: "external-1" };
              },
            },
            messaging: {
              targetResolver: {
                looksLikeId: () => true,
                resolveTarget: async ({ input }) => ({
                  to: input,
                  kind: "channel",
                  source: "normalized",
                }),
              },
            },
          }),
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("posts a Telegram source receipt after a successful source-linked external send", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "-100999" });

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "msteams",
        target: "room-1",
        message: "Confirmed for Tuesday.",
      },
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:123456",
        sourceReceipt: {
          kind: "heartbeat",
          sourceChannel: "telegram",
          sourceTo: "telegram:group:-1003841603622",
          sourceThreadId: 928,
          sourceAccountId: "default",
          sourceLabel: "Warm Leads",
          sourceSessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
          agentId: "jarvis",
        },
      },
      deps: { sendTelegram },
    });

    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(result.sourceReceipt).toMatchObject({ status: "sent" });
    expect(sendExternal).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "-1003841603622",
      expect.stringContaining("Confirmed for Tuesday."),
      expect.objectContaining({
        accountId: "default",
        messageThreadId: 928,
      }),
    );
    expect(sendTelegram.mock.calls[0]?.[1]).toContain("Warm Leads");
    expect(sendTelegram.mock.calls[0]?.[1]).toContain("https://t.me/c/3841603622/928");
  });

  it("does not post receipts without runtime source metadata", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "-100999" });

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "msteams",
        target: "room-1",
        message: "Confirmed for Tuesday.",
      },
      deps: { sendTelegram },
    });

    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(result.sourceReceipt).toMatchObject({
      status: "skipped",
      reason: "missing-source",
    });
    expect(sendExternal).toHaveBeenCalledTimes(1);
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("does not post a source receipt when best-effort delivery has no confirmed send", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "-100999" });
    sendExternal.mockRejectedValueOnce(new Error("external down"));

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "msteams",
        target: "room-1",
        message: "Confirmed for Tuesday.",
        bestEffort: true,
      },
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:123456",
        sourceReceipt: {
          kind: "heartbeat",
          sourceChannel: "telegram",
          sourceTo: "telegram:group:-1003841603622",
          sourceThreadId: 928,
          sourceAccountId: "default",
          sourceSessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
          agentId: "jarvis",
        },
      },
      deps: { sendTelegram },
    });

    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(result.sourceReceipt).toMatchObject({
      status: "skipped",
      reason: "unconfirmed-send",
    });
    expect(sendExternal).toHaveBeenCalledTimes(1);
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("does not post a source receipt for hook-cancelled delivery sentinels", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "-100999" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "msteams",
            outbound: {
              deliveryMode: "direct",
              sendText: async () => ({
                channel: "msteams",
                messageId: "cancelled-by-hook",
                meta: { cancelled: true },
              }),
            },
            messaging: {
              targetResolver: {
                looksLikeId: () => true,
                resolveTarget: async ({ input }) => ({
                  to: input,
                  kind: "channel",
                  source: "normalized",
                }),
              },
            },
          }),
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "msteams",
        target: "room-1",
        message: "Confirmed for Tuesday.",
      },
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:123456",
        sourceReceipt: {
          kind: "heartbeat",
          sourceChannel: "telegram",
          sourceTo: "telegram:group:-1003841603622",
          sourceThreadId: 928,
          sourceAccountId: "default",
          sourceSessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
          agentId: "jarvis",
        },
      },
      deps: { sendTelegram },
    });

    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(result.sourceReceipt).toMatchObject({
      status: "skipped",
      reason: "unconfirmed-send",
    });
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("posts a source receipt after a successful plugin-handled send", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "-100999" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "msteams",
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "msteams", messageId: "unused" }),
              },
              messaging: {
                targetResolver: {
                  looksLikeId: () => true,
                  resolveTarget: async ({ input }) => ({
                    to: input,
                    kind: "channel",
                    source: "normalized",
                  }),
                },
              },
            }),
            actions: {
              supportsAction: ({ action }: { action: string }) => action === "send",
              handleAction: async () => ({
                content: [{ type: "text", text: JSON.stringify({ ok: true, messageId: "p-1" }) }],
              }),
            },
          },
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "msteams",
        target: "room-1",
        message: "Confirmed for Tuesday.",
      },
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:123456",
        sourceReceipt: {
          kind: "heartbeat",
          sourceChannel: "telegram",
          sourceTo: "telegram:group:-1003841603622",
          sourceThreadId: 928,
          sourceAccountId: "default",
          sourceSessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
          agentId: "jarvis",
        },
      },
      deps: { sendTelegram },
    });

    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(result.sourceReceipt).toMatchObject({ status: "sent" });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("does not post a source receipt after a plugin-handled cancelled send", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "-100999" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "msteams",
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "msteams", messageId: "unused" }),
              },
              messaging: {
                targetResolver: {
                  looksLikeId: () => true,
                  resolveTarget: async ({ input }) => ({
                    to: input,
                    kind: "channel",
                    source: "normalized",
                  }),
                },
              },
            }),
            actions: {
              supportsAction: ({ action }: { action: string }) => action === "send",
              handleAction: async () => ({
                details: { ok: false, cancelled: true, messageId: "cancelled-by-hook" },
              }),
            },
          },
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "msteams",
        target: "room-1",
        message: "Confirmed for Tuesday.",
      },
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:123456",
        sourceReceipt: {
          kind: "heartbeat",
          sourceChannel: "telegram",
          sourceTo: "telegram:group:-1003841603622",
          sourceThreadId: 928,
          sourceAccountId: "default",
          sourceSessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
          agentId: "jarvis",
        },
      },
      deps: { sendTelegram },
    });

    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(result.sourceReceipt).toMatchObject({
      status: "skipped",
      reason: "unconfirmed-send",
    });
    expect(sendTelegram).not.toHaveBeenCalled();
  });
});
