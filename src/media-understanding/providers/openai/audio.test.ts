import { describe, expect, it } from "vitest";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./audio.js";

installPinnedHostnameTestHooks();

describe("transcribeOpenAiCompatibleAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({ text: "ok" });

    const result = await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Bearer override" },
      fetchFn,
    });

    expect(getAuthHeader()).toBe("Bearer override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

    const result = await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      prompt: " hello ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("gpt-4o-mini-transcribe");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("x-custom")).toBe("1");

    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("hello");
    const file = form.get("file") as Blob | { type?: string; name?: string } | null;
    expect(file).not.toBeNull();
    if (file) {
      expect(file.type).toBe("audio/wav");
      if ("name" in file && typeof file.name === "string") {
        expect(file.name).toBe("voice.wav");
      }
    }
  });

  it("normalizes WhatsApp Ogg audio filenames for OpenAI uploads", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "whatsapp-voice.oga",
      mime: "audio/ogg; codecs=opus",
      apiKey: "test-key",
      timeoutMs: 1234,
      fetchFn,
    });

    const form = getRequest().init?.body as FormData;
    const file = form.get("file") as Blob | { name?: string } | null;
    expect(file && "name" in file ? file.name : undefined).toBe("whatsapp-voice.ogg");
  });

  it("throws when the provider response omits text", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({});

    await expect(
      transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing text");
  });

  it("preserves an explicit empty transcript as successful silence", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({ text: "   " });

    await expect(
      transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "silent.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).resolves.toMatchObject({ text: "" });
  });
});
