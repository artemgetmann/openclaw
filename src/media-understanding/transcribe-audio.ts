import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runFfmpeg, runFfprobe } from "../media/ffmpeg-exec.js";
import {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  isInboundPathAllowed,
  mergeInboundPathRoots,
} from "../media/inbound-path-policy.js";
import { getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import { DEFAULT_MAX_BYTES } from "./defaults.js";

const MAX_AUDIO_CHUNK_DURATION_SECONDS = 15 * 60;
const AUDIO_CHUNK_BITRATE_KBPS = 32;
const AUDIO_CHUNK_BITRATE_BPS = AUDIO_CHUNK_BITRATE_KBPS * 1024;
const AUDIO_CHUNK_SIZE_SAFETY_RATIO = 0.8;

function resolveAudioMaxBytes(cfg: OpenClawConfig): number {
  const audioConfig = cfg.tools?.media?.audio;
  const configuredEntries = [
    ...(audioConfig?.models ?? []),
    ...(cfg.tools?.media?.models ?? []).filter(
      (entry) => !entry.capabilities || entry.capabilities.includes("audio"),
    ),
  ];
  const defaultMaxBytes = audioConfig?.maxBytes ?? DEFAULT_MAX_BYTES.audio;
  if (configuredEntries.length === 0) {
    return defaultMaxBytes;
  }
  return Math.min(...configuredEntries.map((entry) => entry.maxBytes ?? defaultMaxBytes));
}

async function inspectAudioDuration(filePath: string): Promise<number> {
  let stdout: string;
  try {
    // Probe only the first audio stream. A video container without audio is not
    // transcribable, even when its container reports an overall duration.
    stdout = await runFfprobe([
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_type,duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
  } catch (err) {
    throw new Error(
      `Unable to inspect audio with ffprobe. Install FFmpeg and verify the file is readable: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }

  const fields = stdout
    .trim()
    .split(/[,\r\n]+/)
    .map((field) => field.trim());
  if (!fields.includes("audio")) {
    throw new Error("Audio transcription requires an audio stream; ffprobe found none.");
  }
  const durationSeconds = fields
    .map((field) => Number(field))
    .find((value) => Number.isFinite(value) && value >= 0);

  // Some containers do not expose stream duration. Chunk conservatively rather
  // than sending an unknown-length file to a provider with a hard duration cap.
  return durationSeconds ?? Number.POSITIVE_INFINITY;
}

function resolveChunkDurationSeconds(maxBytes: number): number {
  const durationForConfiguredLimit = Math.floor(
    (maxBytes * 8 * AUDIO_CHUNK_SIZE_SAFETY_RATIO) / AUDIO_CHUNK_BITRATE_BPS,
  );
  return Math.max(1, Math.min(MAX_AUDIO_CHUNK_DURATION_SECONDS, durationForConfiguredLimit));
}

async function assertChunkSourceAllowed(params: {
  filePath: string;
  localPathRoots?: readonly string[];
}): Promise<void> {
  const localPathRoots = mergeInboundPathRoots(
    params.localPathRoots,
    getDefaultMediaLocalRoots(),
    DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  );
  const resolvedPath = path.resolve(params.filePath);
  if (!isInboundPathAllowed({ filePath: resolvedPath, roots: localPathRoots })) {
    throw new Error(
      `Audio transcription file is outside the allowed local paths: ${params.filePath}`,
    );
  }

  // Keep the runner's symlink-safe root semantics before placing a derived
  // chunk in a trusted temp directory, which must not bypass caller roots.
  const canonicalPath = await fs.realpath(params.filePath);
  const canonicalRoots = mergeInboundPathRoots(
    localPathRoots,
    await Promise.all(
      localPathRoots.map(async (root) => {
        if (root.includes("*")) {
          return root;
        }
        return await fs.realpath(root).catch(() => root);
      }),
    ),
  );
  if (!isInboundPathAllowed({ filePath: canonicalPath, roots: canonicalRoots })) {
    throw new Error(
      `Audio transcription file resolves outside the allowed local paths: ${params.filePath}`,
    );
  }
}

async function createAudioChunks(params: {
  filePath: string;
  outputDir: string;
  maxBytes: number;
}): Promise<string[]> {
  const outputPattern = path.join(params.outputDir, "chunk-%03d.mp3");
  try {
    // Re-encoding to narrowband mono keeps every chunk small and predictable
    // across source codecs instead of trusting the original container bitrate.
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      params.filePath,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${AUDIO_CHUNK_BITRATE_KBPS}k`,
      "-f",
      "segment",
      "-segment_time",
      String(resolveChunkDurationSeconds(params.maxBytes)),
      "-reset_timestamps",
      "1",
      "-y",
      outputPattern,
    ]);
  } catch (err) {
    throw new Error(
      `Unable to create transcription chunks with ffmpeg. Install FFmpeg and verify the file contains readable audio: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }

  const chunkNames = (await fs.readdir(params.outputDir))
    .filter((name) => /^chunk-\d+\.mp3$/.test(name))
    .toSorted((left, right) => left.localeCompare(right, "en"));
  if (chunkNames.length === 0) {
    throw new Error("ffmpeg created no audio chunks for transcription.");
  }
  return chunkNames.map((name) => path.join(params.outputDir, name));
}

async function transcribeAudioChunk(params: {
  chunkPath: string;
  chunkIndex: number;
  cfg: OpenClawConfig;
  agentDir?: string;
  localPathRoots: readonly string[];
}): Promise<string> {
  try {
    const { transcript } = await runAudioTranscription({
      ctx: { MediaPath: params.chunkPath, MediaType: "audio/mpeg" },
      cfg: params.cfg,
      agentDir: params.agentDir,
      localPathRoots: params.localPathRoots,
    });
    const text = transcript?.trim();
    if (!text) {
      throw new Error("provider returned no text");
    }
    return text;
  } catch (err) {
    // Do not return a plausible-looking partial transcript when one interval
    // failed or was skipped by the configured provider/model fallback path.
    throw new Error(
      `Audio chunk ${params.chunkIndex + 1} failed to transcribe; no partial transcript was returned: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

async function transcribeAudioChunks(params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  localPathRoots?: readonly string[];
  maxBytes: number;
}): Promise<{ text: string }> {
  await assertChunkSourceAllowed({
    filePath: params.filePath,
    localPathRoots: params.localPathRoots,
  });
  const outputDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-audio-transcribe-"),
  );
  try {
    const chunkPaths = await createAudioChunks({
      filePath: params.filePath,
      outputDir,
      maxBytes: params.maxBytes,
    });
    const localPathRoots = [...(params.localPathRoots ?? []), outputDir];
    const transcripts: string[] = [];
    for (const [chunkIndex, chunkPath] of chunkPaths.entries()) {
      transcripts.push(
        await transcribeAudioChunk({
          chunkPath,
          chunkIndex,
          cfg: params.cfg,
          agentDir: params.agentDir,
          localPathRoots,
        }),
      );
    }
    return { text: transcripts.join("\n") };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

/**
 * Transcribe an audio file using the configured media-understanding provider.
 *
 * Reads provider/model/apiKey from `tools.media.audio` in the openclaw config,
 * falling back through configured models until one succeeds.
 *
 * This is the runtime-exposed entry point for external plugins (e.g. marmot)
 * that need STT without importing internal media-understanding modules directly.
 */
export async function transcribeAudioFile(params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  localPathRoots?: readonly string[];
  mime?: string;
}): Promise<{ text: string | undefined }> {
  const maxBytes = resolveAudioMaxBytes(params.cfg);
  const stat = await fs.stat(params.filePath);
  if (!stat.isFile()) {
    throw new Error(`Audio transcription requires a regular file: ${params.filePath}`);
  }

  // An oversized source would be skipped by the runner. Inspect and split it
  // before any provider call, while short files keep their existing fast path.
  if (stat.size > maxBytes) {
    await inspectAudioDuration(params.filePath);
    return await transcribeAudioChunks({ ...params, maxBytes });
  }

  const { transcript } = await runAudioTranscription({
    ctx: { MediaPath: params.filePath, MediaType: params.mime },
    cfg: params.cfg,
    agentDir: params.agentDir,
    localPathRoots: params.localPathRoots,
  });
  if (transcript?.trim()) {
    return { text: transcript };
  }

  // A provider can reject a long but byte-small file. Probe only after that
  // miss, then recover with chunks when its duration exceeds the safe ceiling.
  const durationSeconds = await inspectAudioDuration(params.filePath);
  if (durationSeconds > MAX_AUDIO_CHUNK_DURATION_SECONDS) {
    return await transcribeAudioChunks({ ...params, maxBytes });
  }
  return { text: undefined };
}
