import { writeFileSync } from "node:fs";
import path from "node:path";
import { runFfmpeg } from "../media/ffmpeg-exec.js";

export type EdgeSpeechLanguage = "en" | "ru";

export type EdgeSpeechSegment = {
  text: string;
  language: EdgeSpeechLanguage;
};

type EdgeLanguageConfig = {
  voice: string;
  lang: string;
  voiceConfigured: boolean;
  langConfigured: boolean;
};

const EDGE_LANGUAGE_DEFAULTS: Record<EdgeSpeechLanguage, { voice: string; lang: string }> = {
  en: { voice: "en-US-MichelleNeural", lang: "en-US" },
  ru: { voice: "ru-RU-SvetlanaNeural", lang: "ru-RU" },
};

const LETTER_TOKEN_REGEX = /\p{L}+/gu;
const LATIN_REGEX = /\p{Script=Latin}/u;
const CYRILLIC_REGEX = /\p{Script=Cyrillic}/u;
// These letters identify common neighboring Cyrillic languages. Leave their
// words neutral instead of confidently feeding them to the Russian voice.
const NON_RUSSIAN_CYRILLIC_REGEX = /[іїєґў]/iu;

function classifyWord(word: string): EdgeSpeechLanguage | undefined {
  if (NON_RUSSIAN_CYRILLIC_REGEX.test(word)) {
    return undefined;
  }
  const letters = Array.from(word);
  if (letters.every((letter) => LATIN_REGEX.test(letter))) {
    return "en";
  }
  if (letters.every((letter) => CYRILLIC_REGEX.test(letter))) {
    return "ru";
  }
  return undefined;
}

/** Split the final, already-sanitized TTS input without dropping or reordering text. */
export function segmentEdgeSpeech(text: string): EdgeSpeechSegment[] {
  const tokens: Array<{ text: string; language?: EdgeSpeechLanguage }> = [];
  let offset = 0;
  for (const match of text.matchAll(LETTER_TOKEN_REGEX)) {
    const index = match.index;
    if (index > offset) {
      tokens.push({ text: text.slice(offset, index) });
    }
    tokens.push({ text: match[0], language: classifyWord(match[0]) });
    offset = index + match[0].length;
  }
  if (offset < text.length) {
    tokens.push({ text: text.slice(offset) });
  }

  const segments: EdgeSpeechSegment[] = [];
  let leadingNeutral = "";
  for (const token of tokens) {
    if (!token.language) {
      if (segments.length === 0) {
        leadingNeutral += token.text;
      } else {
        // Punctuation and whitespace between scripts stay with the preceding
        // speech. This preserves natural sentence endings and exact ordering.
        segments[segments.length - 1].text += token.text;
      }
      continue;
    }

    const textWithPrefix = `${leadingNeutral}${token.text}`;
    leadingNeutral = "";
    const previous = segments.at(-1);
    if (previous?.language === token.language) {
      previous.text += textWithPrefix;
    } else {
      segments.push({ text: textWithPrefix, language: token.language });
    }
  }

  if (segments.length === 0 && leadingNeutral) {
    return [{ text: leadingNeutral, language: "en" }];
  }
  return segments;
}

export function resolveEdgeSpeechSegments(
  text: string,
  config: EdgeLanguageConfig,
): Array<EdgeSpeechSegment & { voice: string; lang: string }> {
  // Any explicit voice or language is authoritative. A partial override must
  // not silently pair the user's setting with an automatically selected one.
  if (config.voiceConfigured || config.langConfigured) {
    return [{ text, language: "en", voice: config.voice, lang: config.lang }];
  }
  return segmentEdgeSpeech(text).map((segment) => ({
    ...segment,
    ...EDGE_LANGUAGE_DEFAULTS[segment.language],
  }));
}

function escapeConcatPath(filePath: string): string {
  return filePath.replaceAll("'", "'\\''");
}

function resolveStitchedAudioCodec(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase();
  if (normalized.includes("opus") || normalized.includes("webm")) {
    return "libopus";
  }
  if (normalized.includes("wav") || normalized.includes("riff") || normalized.includes("pcm")) {
    return "pcm_s16le";
  }
  return "libmp3lame";
}

/** Stitch Edge outputs by re-encoding; stream-copying independent MP3s breaks timestamps. */
export async function stitchEdgeAudio(params: {
  segmentPaths: string[];
  outputPath: string;
  outputFormat: string;
}): Promise<void> {
  if (params.segmentPaths.length < 2) {
    throw new Error("Edge audio stitching requires at least two segments");
  }
  const listPath = path.join(path.dirname(params.outputPath), "segments.ffconcat");
  const list = params.segmentPaths
    .map((segmentPath) => `file '${escapeConcatPath(segmentPath)}'`)
    .join("\n");
  writeFileSync(listPath, `${list}\n`, { encoding: "utf8", mode: 0o600 });
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vn",
    "-c:a",
    resolveStitchedAudioCodec(params.outputFormat),
    "-y",
    params.outputPath,
  ]);
}
