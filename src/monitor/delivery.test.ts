import { describe, expect, it } from "vitest";
import {
  resolveMonitorActionTarget,
  resolveMonitorExecutionPlan,
  resolveMonitorWatchDelivery,
} from "./delivery.js";

describe("resolveMonitorWatchDelivery", () => {
  it("infers a watched-surface delivery target from deliverable channel source metadata", () => {
    expect(
      resolveMonitorWatchDelivery({
        sourceType: "whatsapp",
        sourceTarget: {
          target: "74333133234289@lid",
          accountId: "default",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "whatsapp",
      to: "74333133234289@lid",
      accountId: "default",
    });
  });

  it("fails closed for gmail thread monitors because email replies need dynamic message metadata", () => {
    expect(
      resolveMonitorWatchDelivery({
        sourceType: "gmail",
        sourceTarget: {
          account: "me@example.com",
          threadId: "thread-1",
        },
      }),
    ).toBeUndefined();
  });
});

describe("resolveMonitorActionTarget", () => {
  it("captures the future Gmail reply contract while still failing closed on transport", () => {
    expect(
      resolveMonitorActionTarget({
        sourceType: "gmail",
        sourceTarget: {
          account: "me@example.com",
          threadId: "thread-1",
          replyToMessageId: "msg-1",
          toRecipients: ["friend@example.com"],
          ccRecipients: ["cc@example.com"],
        },
      }),
    ).toEqual({
      kind: "email-reply",
      provider: "gmail",
      accountId: "me@example.com",
      threadId: "thread-1",
      replyToMessageId: "msg-1",
      recipients: {
        to: ["friend@example.com"],
        cc: ["cc@example.com"],
      },
    });
  });
});

describe("resolveMonitorExecutionPlan", () => {
  it("routes auto_send monitors through the shared runtime seam with a watched message target", () => {
    expect(
      resolveMonitorExecutionPlan({
        actionPolicy: "auto_send",
        sourceType: "whatsapp",
        sourceTarget: { target: "74333133234289@lid" },
        originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
        watchDelivery: { mode: "announce", channel: "whatsapp", to: "74333133234289@lid" },
      }),
    ).toEqual({
      actionTarget: { kind: "message", channel: "whatsapp", to: "74333133234289@lid" },
      originDelivery: { mode: "announce", channel: "telegram", to: "user-1", accountId: undefined },
      fallbackDelivery: { mode: "announce", channel: "whatsapp", to: "74333133234289@lid" },
      deliveryPromptMode: "reply",
      deliveryContract: "shared",
      watchDeliveryConfigured: true,
      messageToolTarget: { kind: "message", channel: "whatsapp", to: "74333133234289@lid" },
      requireExplicitMessageTarget: false,
    });
  });

  it("keeps origin-chat delivery semantics for notify_only monitors", () => {
    expect(
      resolveMonitorExecutionPlan({
        actionPolicy: "notify_only",
        sourceType: "whatsapp",
        sourceTarget: { target: "74333133234289@lid" },
        originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
        watchDelivery: { mode: "announce", channel: "whatsapp", to: "74333133234289@lid" },
      }),
    ).toEqual({
      actionTarget: { kind: "message", channel: "whatsapp", to: "74333133234289@lid" },
      originDelivery: { mode: "announce", channel: "telegram", to: "user-1", accountId: undefined },
      fallbackDelivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
        accountId: undefined,
      },
      deliveryPromptMode: "summary",
      deliveryContract: "cron-owned",
      watchDeliveryConfigured: true,
      requireExplicitMessageTarget: false,
    });
  });

  it("fails closed for Gmail auto_send monitors until a real outbound transport exists", () => {
    expect(
      resolveMonitorExecutionPlan({
        actionPolicy: "auto_send",
        sourceType: "gmail",
        sourceTarget: {
          account: "me@example.com",
          threadId: "thread-1",
          replyToMessageId: "msg-1",
          toRecipients: ["friend@example.com"],
        },
        originDelivery: { mode: "announce", channel: "telegram", to: "user-1" },
      }),
    ).toEqual({
      actionTarget: {
        kind: "email-reply",
        provider: "gmail",
        accountId: "me@example.com",
        threadId: "thread-1",
        replyToMessageId: "msg-1",
        recipients: { to: ["friend@example.com"] },
      },
      originDelivery: { mode: "announce", channel: "telegram", to: "user-1", accountId: undefined },
      fallbackDelivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
        accountId: undefined,
      },
      deliveryPromptMode: "summary",
      deliveryContract: "cron-owned",
      watchDeliveryConfigured: true,
      requireExplicitMessageTarget: false,
    });
  });
});
