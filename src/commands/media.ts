import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { loadConfig } from "../config/config.js";
import { transcribeAudioFile } from "../media-understanding/transcribe-audio.js";
import type { RuntimeEnv } from "../runtime.js";

function readBooleanOpt(opts: Record<string, unknown>, key: string): boolean {
  return opts[key] === true;
}

function readStringOpt(opts: Record<string, unknown>, key: string): string | undefined {
  const value = opts[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type MediaTranscribeCommandResult = {
  file_path: string;
  mime: string | null;
  text: string | null;
};

export async function mediaTranscribeCommand(
  fileArg: string | undefined,
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const rawFilePath = readStringOpt(opts, "file") ?? (fileArg?.trim() ? fileArg.trim() : undefined);
  if (!rawFilePath) {
    throw new Error("Media transcribe requires a file path.");
  }
  const filePath = path.resolve(rawFilePath);

  // Fail early with a plain file error before the media runner starts provider
  // selection. This keeps CLI mistakes separate from STT provider/config issues.
  await fs.access(filePath);

  const mime = readStringOpt(opts, "mime");
  const result = await transcribeAudioFile({
    filePath,
    cfg: loadConfig(),
    agentDir: readStringOpt(opts, "agentDir") ?? resolveOpenClawAgentDir(),
    mime,
  });
  const payload: MediaTranscribeCommandResult = {
    file_path: filePath,
    mime: mime ?? null,
    text: result.text ?? null,
  };

  if (readBooleanOpt(opts, "json")) {
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }
  runtime.log(payload.text ?? "");
}
