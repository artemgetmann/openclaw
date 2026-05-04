import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSourceReplyDeliveryMode,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";

const emptyConfig = {} as OpenClawConfig;

const groupMessageToolOnlyConfig = {
  messages: {
    groupChat: {
      visibleReplies: "message_tool",
    },
  },
} as OpenClawConfig;

describe("resolveSourceReplyDeliveryMode", () => {
  it("keeps native command replies automatic in groups", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: groupMessageToolOnlyConfig,
        ctx: { ChatType: "group", CommandSource: "native" },
      }),
    ).toBe("automatic");
  });

  it("falls back to automatic when message tool delivery is unavailable", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: groupMessageToolOnlyConfig,
        ctx: { ChatType: "group" },
        messageToolAvailable: false,
      }),
    ).toBe("automatic");
  });

  it("keeps message-tool-only mode when the message tool is available", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: groupMessageToolOnlyConfig,
        ctx: { ChatType: "group" },
        messageToolAvailable: true,
      }),
    ).toBe("message_tool_only");
  });
});

describe("resolveSourceReplyVisibilityPolicy", () => {
  it("keeps native command replies visible in groups", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: groupMessageToolOnlyConfig,
        ctx: { ChatType: "group", CommandSource: "native" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressTyping: false,
    });
  });

  it("suppresses automatic source delivery only when message-tool mode can run", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: groupMessageToolOnlyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
        messageToolAvailable: true,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      suppressAutomaticSourceDelivery: true,
      suppressDelivery: true,
      deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
    });
  });

  it("uses automatic source delivery when message-tool mode cannot run", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: groupMessageToolOnlyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      deliverySuppressionReason: "",
    });
  });

  it("still honors send policy denial", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "deny",
      }),
    ).toMatchObject({
      sendPolicyDenied: true,
      suppressDelivery: true,
      suppressTyping: true,
      deliverySuppressionReason: "sendPolicy: deny",
    });
  });
});
