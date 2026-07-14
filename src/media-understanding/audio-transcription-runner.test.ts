import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  buildProviderRegistry: vi.fn(() => new Map()),
  createMediaAttachmentCache: vi.fn(() => ({ cleanup: vi.fn() })),
  normalizeMediaAttachments: vi.fn(() => [{ index: 0, path: "/tmp/voice.mp3" }]),
  runCapability: vi.fn(),
}));

vi.mock("./runner.js", () => ({
  buildProviderRegistry: mocks.buildProviderRegistry,
  createMediaAttachmentCache: mocks.createMediaAttachmentCache,
  normalizeMediaAttachments: mocks.normalizeMediaAttachments,
  runCapability: mocks.runCapability,
}));

import { runAudioTranscription } from "./audio-transcription-runner.js";

describe("runAudioTranscription", () => {
  it("returns the capability decision alongside its transcript", async () => {
    const decision = {
      capability: "audio" as const,
      outcome: "success" as const,
      attachments: [],
    };
    mocks.runCapability.mockResolvedValue({
      decision,
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "heard",
          provider: "test",
        },
      ],
    });

    await expect(
      runAudioTranscription({
        ctx: { MediaPath: "/tmp/voice.mp3" },
        cfg: {} as OpenClawConfig,
      }),
    ).resolves.toMatchObject({ transcript: "heard", decision });
  });

  it("reports no-attachment as a decision", async () => {
    mocks.normalizeMediaAttachments.mockReturnValueOnce([]);

    await expect(
      runAudioTranscription({ ctx: {}, cfg: {} as OpenClawConfig }),
    ).resolves.toMatchObject({
      transcript: undefined,
      decision: { capability: "audio", outcome: "no-attachment", attachments: [] },
    });
  });
});
