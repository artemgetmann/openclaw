import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const MB = 1024 * 1024;

const { runAudioTranscription, runFfmpeg, runFfprobe } = vi.hoisted(() => {
  const runAudioTranscription = vi.fn();
  const runFfmpeg = vi.fn();
  const runFfprobe = vi.fn();
  return { runAudioTranscription, runFfmpeg, runFfprobe };
});

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription,
}));

vi.mock("../media/ffmpeg-exec.js", () => ({
  runFfmpeg,
  runFfprobe,
}));

import { transcribeAudioFile } from "./transcribe-audio.js";

describe("transcribeAudioFile", () => {
  let tempDir = "";

  beforeEach(() => {
    vi.clearAllMocks();
    runFfprobe.mockResolvedValue("audio\n60");
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcribe-audio-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeAudioFile(name = "note.mp3", contents = "audio"): Promise<string> {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, contents);
    return filePath;
  }

  function mockChunkFiles(count: number): void {
    runFfmpeg.mockImplementation(async (args: string[]) => {
      const outputPattern = args.at(-1);
      if (!outputPattern) {
        throw new Error("missing chunk output pattern");
      }
      await Promise.all(
        Array.from({ length: count }, async (_, index) => {
          const outputPath = outputPattern.replace("%03d", String(index).padStart(3, "0"));
          await fs.writeFile(outputPath, `chunk ${index}`);
        }),
      );
    });
  }

  it("does not force audio/wav when mime is omitted", async () => {
    runAudioTranscription.mockResolvedValue({ transcript: "hello", attachments: [] });
    const filePath = await writeAudioFile();

    const result = await transcribeAudioFile({
      filePath,
      cfg: {} as OpenClawConfig,
    });

    expect(runAudioTranscription).toHaveBeenCalledWith({
      ctx: {
        MediaPath: filePath,
        MediaType: undefined,
      },
      cfg: {} as OpenClawConfig,
      agentDir: undefined,
      localPathRoots: undefined,
    });
    expect(result).toEqual({ text: "hello" });
    expect(runFfprobe).not.toHaveBeenCalled();
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("passes explicit local path roots through to the audio runner", async () => {
    runAudioTranscription.mockResolvedValue({ transcript: "hello", attachments: [] });
    const mediaDir = path.join(tempDir, "media");
    await fs.mkdir(mediaDir);
    const filePath = path.join(mediaDir, "voice.ogg");
    await fs.writeFile(filePath, "audio");

    await transcribeAudioFile({
      filePath,
      cfg: {} as OpenClawConfig,
      localPathRoots: [mediaDir],
      mime: "audio/ogg",
    });

    expect(runAudioTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        localPathRoots: [mediaDir],
      }),
    );
  });

  it("returns undefined when helper returns no transcript", async () => {
    runAudioTranscription.mockResolvedValue({ transcript: undefined, attachments: [] });
    const filePath = await writeAudioFile("missing.wav");

    const result = await transcribeAudioFile({
      filePath,
      cfg: {} as OpenClawConfig,
    });

    expect(result).toEqual({ text: undefined });
  });

  it("propagates helper errors", async () => {
    const cfg = {
      tools: { media: { audio: { timeoutSeconds: 10 } } },
    } as unknown as OpenClawConfig;
    runAudioTranscription.mockRejectedValue(new Error("boom"));
    const filePath = await writeAudioFile("note.wav");

    await expect(
      transcribeAudioFile({
        filePath,
        cfg,
      }),
    ).rejects.toThrow("boom");
  });

  it("chunks an oversized local file and joins chunk transcripts in order", async () => {
    const filePath = await writeAudioFile("long.mp4", "this is larger than ten bytes");
    const cfg = {
      tools: { media: { audio: { maxBytes: 10 } } },
    } as unknown as OpenClawConfig;
    mockChunkFiles(2);
    runAudioTranscription
      .mockResolvedValueOnce({ transcript: "first chunk", attachments: [] })
      .mockResolvedValueOnce({ transcript: "second chunk", attachments: [] });

    await expect(
      transcribeAudioFile({ filePath, cfg, localPathRoots: [tempDir] }),
    ).resolves.toEqual({
      text: "first chunk\nsecond chunk",
    });
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
    expect(runAudioTranscription).toHaveBeenCalledTimes(2);

    const calls = runAudioTranscription.mock.calls;
    expect(calls.map(([params]) => path.basename(params.ctx.MediaPath))).toEqual([
      "chunk-000.mp3",
      "chunk-001.mp3",
    ]);
    for (const [params] of calls) {
      expect(params.ctx.MediaType).toBe("audio/mpeg");
      expect(params.localPathRoots).toEqual(
        expect.arrayContaining([tempDir, path.dirname(params.ctx.MediaPath)]),
      );
    }
    expect(calls.some(([params]) => params.ctx.MediaPath === filePath)).toBe(false);
  });

  it("chunks audio longer than fifteen minutes even when it is below the byte limit", async () => {
    const filePath = await writeAudioFile("long-but-small.mp3");
    runFfprobe.mockResolvedValue("audio\n901");
    mockChunkFiles(1);
    runAudioTranscription
      .mockResolvedValueOnce({ transcript: undefined, attachments: [] })
      .mockResolvedValueOnce({ transcript: "long transcript", attachments: [] });

    await expect(
      transcribeAudioFile({ filePath, cfg: {} as OpenClawConfig, localPathRoots: [tempDir] }),
    ).resolves.toEqual({ text: "long transcript" });
    expect(runFfmpeg).toHaveBeenCalledWith(expect.arrayContaining(["-segment_time", "900"]));
    expect(runAudioTranscription).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty chunk transcript without returning partial text and removes temp chunks", async () => {
    const filePath = await writeAudioFile("partial.mp3", "this is larger than ten bytes");
    const cfg = {
      tools: { media: { audio: { maxBytes: 10 } } },
    } as unknown as OpenClawConfig;
    mockChunkFiles(2);
    runAudioTranscription
      .mockResolvedValueOnce({ transcript: "first chunk", attachments: [] })
      .mockResolvedValueOnce({ transcript: undefined, attachments: [] });

    await expect(transcribeAudioFile({ filePath, cfg, localPathRoots: [tempDir] })).rejects.toThrow(
      /chunk 2 failed to transcribe; no partial transcript/i,
    );

    const secondChunkPath = runAudioTranscription.mock.calls[1]?.[0].ctx.MediaPath as string;
    await expect(fs.access(path.dirname(secondChunkPath))).rejects.toThrow();
  });

  it("rejects a no-text file with no audio stream", async () => {
    const filePath = await writeAudioFile("silent-video.mp4");
    runFfprobe.mockResolvedValue("120");
    runAudioTranscription.mockResolvedValue({ transcript: undefined, attachments: [] });

    await expect(transcribeAudioFile({ filePath, cfg: {} as OpenClawConfig })).rejects.toThrow(
      /requires an audio stream/i,
    );
    expect(runAudioTranscription).toHaveBeenCalledTimes(1);
  });

  it("honors an explicit global maxBytes above the default", async () => {
    const filePath = await writeAudioFile("raised-limit.mp3");
    vi.spyOn(fs, "stat").mockResolvedValueOnce({
      isFile: () => true,
      size: 21 * MB,
    } as Awaited<ReturnType<typeof fs.stat>>);
    runAudioTranscription.mockResolvedValue({ transcript: "accepted", attachments: [] });

    await expect(
      transcribeAudioFile({
        filePath,
        cfg: { tools: { media: { audio: { maxBytes: 30 * MB } } } } as OpenClawConfig,
      }),
    ).resolves.toEqual({ text: "accepted" });
    expect(runFfprobe).not.toHaveBeenCalled();
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});
