import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const transcribeFirstAudioMock = vi.fn();
const DEFAULT_MODEL = "anthropic/claude-opus-4-5";
const DEFAULT_WORKSPACE = "/tmp/openclaw";
const DEFAULT_MENTION_PATTERN = "\\bbot\\b";

vi.mock("../../../src/media-understanding/audio-preflight.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

async function buildGroupVoiceContext(params: {
  messageId: number;
  chatId: number;
  title: string;
  date: number;
  fromId: number;
  firstName: string;
  fileId: string;
  mediaPath: string;
  groupDisableAudioPreflight?: boolean;
  topicDisableAudioPreflight?: boolean;
}) {
  const groupConfig = {
    requireMention: true,
    ...(params.groupDisableAudioPreflight === undefined
      ? {}
      : { disableAudioPreflight: params.groupDisableAudioPreflight }),
  };
  const topicConfig =
    params.topicDisableAudioPreflight === undefined
      ? undefined
      : { disableAudioPreflight: params.topicDisableAudioPreflight };

  return buildTelegramMessageContextForTest({
    message: {
      message_id: params.messageId,
      chat: { id: params.chatId, type: "supergroup", title: params.title },
      date: params.date,
      text: undefined,
      from: { id: params.fromId, first_name: params.firstName },
      voice: { file_id: params.fileId },
    },
    allMedia: [{ path: params.mediaPath, contentType: "audio/ogg" }],
    options: { forceWasMentioned: true },
    cfg: {
      agents: { defaults: { model: DEFAULT_MODEL, workspace: DEFAULT_WORKSPACE } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [DEFAULT_MENTION_PATTERN] } },
    },
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => true,
    resolveTelegramGroupConfig: () => ({
      groupConfig,
      topicConfig,
    }),
  });
}

async function buildDirectVoiceContext(params: {
  messageId: number;
  chatId: number;
  date: number;
  fromId: number;
  firstName: string;
  fileId: string;
  mediaPath: string;
  mediaType?: string;
}) {
  return buildTelegramMessageContextForTest({
    message: {
      message_id: params.messageId,
      chat: { id: params.chatId, type: "private" },
      date: params.date,
      text: undefined,
      from: { id: params.fromId, first_name: params.firstName },
      voice: { file_id: params.fileId },
    },
    allMedia: [{ path: params.mediaPath, contentType: params.mediaType ?? "audio/ogg" }],
    cfg: {
      agents: { defaults: { model: DEFAULT_MODEL, workspace: DEFAULT_WORKSPACE } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [DEFAULT_MENTION_PATTERN] } },
      tools: {
        media: {
          audio: {
            enabled: true,
            models: [{ type: "provider", provider: "jarvis-managed-openai" }],
          },
        },
      },
    },
  });
}

function expectTranscriptRendered(
  ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>,
  transcript: string,
) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.Transcript).toBe(transcript);
  expect(ctx?.ctxPayload?.BodyForAgent).toBe(transcript);
  expect(ctx?.ctxPayload?.Body).toContain(transcript);
  expect(ctx?.ctxPayload?.Body).not.toContain("<media:audio>");
}

function expectAudioPlaceholderRendered(ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
}

function expectManagedVoiceUnavailableRendered(
  ctx: Awaited<ReturnType<typeof buildDirectVoiceContext>>,
) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.BodyForAgent).toContain(
    "Managed voice transcription is currently unavailable",
  );
  expect(ctx?.ctxPayload?.BodyForAgent).not.toBe("<media:audio>");
  expect(ctx?.ctxPayload?.Body).toContain("Managed voice transcription is currently unavailable");
  expect(ctx?.ctxPayload?.Body).not.toContain("<media:audio>");
  expect(ctx?.handledDirectReplyText).toBe(
    "Managed voice transcription is currently unavailable. Please try again later.",
  );
  expect(ctx?.ctxPayload?.Transcript).toBeUndefined();
  expect(ctx?.ctxPayload?.MediaPath).toBeUndefined();
  expect(ctx?.ctxPayload?.MediaType).toBeUndefined();
  expect(ctx?.ctxPayload?.MediaUrl).toBeUndefined();
  expect(ctx?.ctxPayload?.MediaPaths).toBeUndefined();
  expect(ctx?.ctxPayload?.MediaUrls).toBeUndefined();
  expect(ctx?.ctxPayload?.MediaTypes).toBeUndefined();
}

describe("buildTelegramMessageContext audio transcript body", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
  });

  it("uses preflight transcript as BodyForAgent for mention-gated group voice messages", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const ctx = await buildGroupVoiceContext({
      messageId: 1,
      chatId: -1001234567890,
      title: "Test Group",
      date: 1700000000,
      fromId: 42,
      firstName: "Alice",
      fileId: "voice-1",
      mediaPath: "/tmp/voice.ogg",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectTranscriptRendered(ctx, "hey bot please help");
  });

  it("preflights direct Telegram voice notes before agent execution", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("dm voice transcript");

    const ctx = await buildDirectVoiceContext({
      messageId: 5,
      chatId: 123456,
      date: 1700000400,
      fromId: 46,
      firstName: "Eve",
      fileId: "voice-5",
      mediaPath: "/tmp/dm-voice.ogg",
      mediaType: "audio/ogg",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: {
          MediaPaths: ["/tmp/dm-voice.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );
    expectTranscriptRendered(ctx, "dm voice transcript");
  });

  it("handles failed managed direct voice transcription without forwarding raw audio", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce(undefined);

    const ctx = await buildDirectVoiceContext({
      messageId: 6,
      chatId: 123457,
      date: 1700000500,
      fromId: 47,
      firstName: "Finn",
      fileId: "voice-6",
      mediaPath: "/tmp/dm-managed-unavailable.ogg",
      mediaType: "audio/ogg",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectManagedVoiceUnavailableRendered(ctx);
  });

  it("handles thrown managed direct voice transcription without forwarding raw audio", async () => {
    transcribeFirstAudioMock.mockRejectedValueOnce(new Error("hosted transcriber unavailable"));

    const ctx = await buildDirectVoiceContext({
      messageId: 7,
      chatId: 123458,
      date: 1700000600,
      fromId: 48,
      firstName: "Gina",
      fileId: "voice-7",
      mediaPath: "/tmp/dm-managed-throws.ogg",
      mediaType: "audio/ogg",
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectManagedVoiceUnavailableRendered(ctx);
  });

  it("keeps mention-gated group voice messages skipped when managed transcription fails", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce(undefined);

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 8,
        chat: { id: -1001234567894, type: "supergroup", title: "Test Group 5" },
        date: 1700000700,
        text: undefined,
        from: { id: 49, first_name: "Hana" },
        voice: { file_id: "voice-8" },
      },
      allMedia: [{ path: "/tmp/group-managed-unavailable.ogg", contentType: "audio/ogg" }],
      cfg: {
        agents: { defaults: { model: DEFAULT_MODEL, workspace: DEFAULT_WORKSPACE } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: [DEFAULT_MENTION_PATTERN] } },
        tools: {
          media: {
            audio: {
              enabled: true,
              models: [{ type: "provider", provider: "jarvis-managed-openai" }],
            },
          },
        },
      },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: undefined,
      }),
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(ctx).toBeNull();
  });

  it("skips preflight transcription when disableAudioPreflight is true", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildGroupVoiceContext({
      messageId: 2,
      chatId: -1001234567891,
      title: "Test Group 2",
      date: 1700000100,
      fromId: 43,
      firstName: "Bob",
      fileId: "voice-2",
      mediaPath: "/tmp/voice2.ogg",
      groupDisableAudioPreflight: true,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });

  it("uses topic disableAudioPreflight=false to override group disableAudioPreflight=true", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("topic override transcript");

    const ctx = await buildGroupVoiceContext({
      messageId: 3,
      chatId: -1001234567892,
      title: "Test Group 3",
      date: 1700000200,
      fromId: 44,
      firstName: "Cara",
      fileId: "voice-3",
      mediaPath: "/tmp/voice3.ogg",
      groupDisableAudioPreflight: true,
      topicDisableAudioPreflight: false,
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectTranscriptRendered(ctx, "topic override transcript");
  });

  it("uses topic disableAudioPreflight=true to override group disableAudioPreflight=false", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildGroupVoiceContext({
      messageId: 4,
      chatId: -1001234567893,
      title: "Test Group 4",
      date: 1700000300,
      fromId: 45,
      firstName: "Dan",
      fileId: "voice-4",
      mediaPath: "/tmp/voice4.ogg",
      groupDisableAudioPreflight: false,
      topicDisableAudioPreflight: true,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });
});
