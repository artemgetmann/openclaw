import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  synthesisCalls: [] as Array<{ text: string; outputPath: string; voice: string; lang: string }>,
  concatOrder: [] as string[],
  concatCalls: 0,
  activeRequests: 0,
  maxActiveRequests: 0,
  failText: undefined as string | undefined,
}));

vi.mock("node-edge-tts", () => ({
  EdgeTTS: class {
    private readonly config: { voice: string; lang: string };

    constructor(config: { voice: string; lang: string }) {
      this.config = config;
    }

    async ttsPromise(text: string, outputPath: string) {
      mocks.synthesisCalls.push({ text, outputPath, ...this.config });
      mocks.activeRequests += 1;
      mocks.maxActiveRequests = Math.max(mocks.maxActiveRequests, mocks.activeRequests);
      try {
        // Keep requests in flight long enough to prove bounded overlap.
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (text === mocks.failText) {
          throw new Error(`synthetic Edge failure for: ${text}`);
        }
        writeFileSync(outputPath, text);
      } finally {
        mocks.activeRequests -= 1;
      }
    }
  },
}));

vi.mock("../media/ffmpeg-exec.js", () => ({
  runFfmpeg: vi.fn(async (args: string[]) => {
    mocks.concatCalls += 1;
    const listPath = args[args.indexOf("-i") + 1];
    const outputPath = args.at(-1)!;
    const segmentPaths = readFileSync(listPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.slice("file '".length, -1));
    mocks.concatOrder.push(...segmentPaths);
    writeFileSync(
      outputPath,
      segmentPaths.map((segmentPath) => readFileSync(segmentPath, "utf8")).join(""),
    );
    return "";
  }),
}));

const { textToSpeech } = await import("./tts.js");

describe("mixed-language Edge synthesis", () => {
  afterEach(() => {
    mocks.synthesisCalls.length = 0;
    mocks.concatOrder.length = 0;
    mocks.concatCalls = 0;
    mocks.activeRequests = 0;
    mocks.maxActiveRequests = 0;
    mocks.failText = undefined;
  });

  it("sends exact ordered spans to matching voices and stitches them in that order", async () => {
    const text = "Hello, это русский текст. Back again.";
    const result = await textToSpeech({
      text,
      cfg: { messages: { tts: { provider: "edge" } } },
      channel: "telegram",
    });

    expect(result.success).toBe(true);
    expect(mocks.maxActiveRequests).toBe(3);
    expect(
      mocks.synthesisCalls.map(({ text: spanText, voice, lang }) => ({
        text: spanText,
        voice,
        lang,
      })),
    ).toEqual([
      { text: "Hello, ", voice: "en-US-MichelleNeural", lang: "en-US" },
      { text: "это русский текст. ", voice: "ru-RU-SvetlanaNeural", lang: "ru-RU" },
      { text: "Back again.", voice: "en-US-MichelleNeural", lang: "en-US" },
    ]);
    expect(mocks.concatOrder).toEqual(mocks.synthesisCalls.map((call) => call.outputPath));
    expect(readFileSync(result.audioPath!, "utf8")).toBe(text);
  });

  it("propagates a segment failure and does not stitch partial output", async () => {
    mocks.failText = "это сломается. ";
    const result = await textToSpeech({
      text: "Hello, это сломается. Back again.",
      cfg: { messages: { tts: { provider: "edge" } } },
      channel: "telegram",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("synthetic Edge failure for: это сломается.");
    expect(mocks.maxActiveRequests).toBe(3);
    expect(mocks.concatCalls).toBe(0);
  });
});
