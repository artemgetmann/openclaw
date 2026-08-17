import path from "node:path";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postTranscriptionRequest,
  requireTranscriptionTextField,
} from "../shared.js";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_AUDIO_MODEL = "gpt-4o-mini-transcribe";

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_OPENAI_AUDIO_MODEL;
}

function resolveUploadFileName(fileName: string): string {
  const trimmed = fileName.trim() || "audio";
  // WhatsApp commonly labels valid Ogg/Opus voice notes with the `.oga`
  // alias. OpenAI validates the multipart filename against a narrower
  // extension allowlist, so present the same bytes with its canonical suffix.
  return path.extname(trimmed).toLowerCase() === ".oga" ? `${trimmed.slice(0, -4)}.ogg` : trimmed;
}

export async function transcribeOpenAiCompatibleAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_OPENAI_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model);
  const form = new FormData();
  const fileName = resolveUploadFileName(params.fileName);
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, fileName);
  form.append("model", model);
  if (params.language?.trim()) {
    form.append("language", params.language.trim());
  }
  if (params.prompt?.trim()) {
    form.append("prompt", params.prompt.trim());
  }

  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }
  // The SSRF-pinned fetch path can receive Brotli-compressed provider bytes
  // without a Content-Encoding header, leaving Response.json() to parse the
  // compressed body as JSON. Ask OpenAI for identity encoding so the guarded
  // response remains directly parseable.
  if (!headers.has("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }

  const { response: res, release } = await postTranscriptionRequest({
    url,
    headers,
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork: allowPrivate,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = (await res.json()) as { text?: unknown };
    const text = requireTranscriptionTextField(
      payload.text,
      "Audio transcription response missing text",
    );
    return { text, model };
  } finally {
    await release();
  }
}
