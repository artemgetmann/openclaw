import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  buildHeartbeatSourceReceiptPayload,
  buildTelegramSourceLink,
  deliverHeartbeatSourceReceipt,
  resolveHeartbeatSourceReceiptContext,
} from "./source-receipt.js";

describe("heartbeat source receipts", () => {
  it("builds a private Telegram topic link when chat and thread metadata are available", () => {
    expect(
      buildTelegramSourceLink({
        to: "telegram:group:-1003841603622",
        threadId: 928,
      }),
    ).toBe("https://t.me/c/3841603622/928");
  });

  it("preserves source labels and ids when no exact Telegram link can be built", () => {
    const payload = buildHeartbeatSourceReceiptPayload({
      source: {
        kind: "heartbeat",
        sourceChannel: "telegram",
        sourceTo: "-1003841603622",
        sourceThreadId: undefined,
        sourceLabel: "Warm Leads",
      },
      sentChannel: "whatsapp",
      sentTo: "+15555550123",
      message: "Confirmed for Tuesday.",
    });

    expect(payload.text).toContain("Artem approved/sent this exact message via WhatsApp");
    expect(payload.text).toContain("Confirmed for Tuesday.");
    expect(payload.text).toContain("Warm Leads");
    expect(payload.text).toContain("telegram:-1003841603622");
  });

  it("uses runtime session origin as the source and skips same-surface heartbeat deliveries", () => {
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      displayName: "Warm Leads",
      origin: {
        provider: "telegram",
        to: "telegram:group:-1003841603622",
        accountId: "default",
        threadId: 928,
      },
    } as SessionEntry;

    expect(
      resolveHeartbeatSourceReceiptContext({
        entry,
        sessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
        agentId: "jarvis",
        heartbeatDelivery: {
          channel: "telegram",
          to: "telegram:123456",
        },
      }),
    ).toMatchObject({
      sourceChannel: "telegram",
      sourceTo: "telegram:group:-1003841603622",
      sourceThreadId: 928,
      sourceLabel: "Warm Leads",
      sourceSessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
      agentId: "jarvis",
    });

    expect(
      resolveHeartbeatSourceReceiptContext({
        entry,
        sessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
        agentId: "jarvis",
        heartbeatDelivery: {
          channel: "telegram",
          to: "telegram:group:-1003841603622",
          threadId: 928,
        },
      }),
    ).toBeUndefined();

    expect(
      resolveHeartbeatSourceReceiptContext({
        entry,
        sessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
        agentId: "jarvis",
        heartbeatDelivery: {
          channel: "telegram",
          to: "-1003841603622",
          threadId: 928,
        },
      }),
    ).toBeUndefined();
  });

  it("scopes receipt mirror idempotency to the source topic", async () => {
    const deliver = vi.fn(async () => []);

    await deliverHeartbeatSourceReceipt({
      cfg: {} as Parameters<typeof deliverHeartbeatSourceReceipt>[0]["cfg"],
      toolContext: {
        sourceReceipt: {
          kind: "heartbeat",
          sourceChannel: "telegram",
          sourceTo: "telegram:group:-1003841603622",
          sourceThreadId: 928,
          sourceSessionKey: "agent:jarvis:telegram:-1003841603622:topic:928",
          agentId: "jarvis",
        },
      },
      sentChannel: "whatsapp",
      sentTo: "+15555550123",
      message: "Confirmed for Tuesday.",
      deliver,
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          idempotencyKey: expect.stringContaining("heartbeat-source-receipt:-1003841603622:928:"),
        }),
      }),
    );
  });
});
