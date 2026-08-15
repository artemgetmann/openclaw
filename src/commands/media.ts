import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { loadConfig } from "../config/config.js";
import {
  transcribeAudioFile,
  transcribeAudioUrl,
} from "../media-understanding/transcribe-audio.js";
import type { RuntimeEnv } from "../runtime.js";

function readBooleanOpt(opts: Record<string, unknown>, key: string): boolean {
  return opts[key] === true;
}

function readStringOpt(opts: Record<string, unknown>, key: string): string | undefined {
  const value = opts[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type MediaTranscribeCommandResult = {
  file_path?: string;
  source_url?: string;
  mime: string | null;
  text: string;
};

export async function mediaTranscribeCommand(
  fileArg: string | undefined,
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const rawFilePath = readStringOpt(opts, "file") ?? (fileArg?.trim() ? fileArg.trim() : undefined);
  const sourceUrl = readStringOpt(opts, "url");
  if (Boolean(rawFilePath) === Boolean(sourceUrl)) {
    throw new Error("Media transcribe requires exactly one file or URL.");
  }
  const filePath = rawFilePath ? path.resolve(rawFilePath) : undefined;

  // Fail early with a plain file error before the media runner starts provider
  // selection. This keeps CLI mistakes separate from STT provider/config issues.
  if (filePath) {
    await fs.access(filePath);
  }

  const mime = readStringOpt(opts, "mime");
  const common = {
    cfg: loadConfig(),
    agentDir: readStringOpt(opts, "agentDir") ?? resolveOpenClawAgentDir(),
    mime,
  };
  const result = filePath
    ? await transcribeAudioFile({
        ...common,
        filePath,
        // A CLI operator-provided file is its own trust boundary. Allow only
        // its containing directory for this one call.
        localPathRoots: [path.dirname(filePath)],
      })
    : await transcribeAudioUrl({ ...common, url: sourceUrl as string });
  const text = result.text?.trim();
  if (!text) {
    throw new Error("Media transcribe produced no transcript.");
  }
  const payload: MediaTranscribeCommandResult = {
    ...(filePath ? { file_path: filePath } : { source_url: sourceUrl }),
    mime: mime ?? null,
    text,
  };

  if (readBooleanOpt(opts, "json")) {
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }
  runtime.log(payload.text);
}
