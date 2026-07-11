import { describe, expect, it } from "vitest";
import { resolveEdgeSpeechSegments, segmentEdgeSpeech } from "./edge-multilingual.js";

const automaticConfig = {
  voice: "en-US-MichelleNeural",
  lang: "en-US",
  voiceConfigured: false,
  langConfigured: false,
};

describe("Edge English/Russian speech segmentation", () => {
  it.each([
    ["English only.", ["en"]],
    ["Только русский.", ["ru"]],
    ["Hello, это русский текст. Back again.", ["en", "ru", "en"]],
    ["Привет, this is English. Снова русский.", ["ru", "en", "ru"]],
  ])("segments %s", (text, languages) => {
    const segments = segmentEdgeSpeech(text);
    expect(segments.map((segment) => segment.language)).toEqual(languages);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("keeps short fragments and punctuation boundaries in output order", () => {
    const text = "A — я! B? да.";
    const segments = resolveEdgeSpeechSegments(text, automaticConfig);

    expect(segments.map(({ language, text }) => ({ language, text }))).toEqual([
      { language: "en", text: "A — " },
      { language: "ru", text: "я! " },
      { language: "en", text: "B? " },
      { language: "ru", text: "да." },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("keeps an explicitly configured Edge voice and language authoritative", () => {
    const text = "Hello, русский passage.";
    const segments = resolveEdgeSpeechSegments(text, {
      voice: "en-GB-SoniaNeural",
      lang: "en-GB",
      voiceConfigured: true,
      langConfigured: true,
    });

    expect(segments).toEqual([
      {
        text,
        language: "en",
        voice: "en-GB-SoniaNeural",
        lang: "en-GB",
      },
    ]);
  });

  it("does not classify Ukrainian-specific Cyrillic words as Russian", () => {
    const text = "English і українська";
    const segments = segmentEdgeSpeech(text);

    expect(segments).toEqual([{ language: "en", text }]);
  });
});
