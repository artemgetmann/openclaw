import { logVerbose } from "../../globals.js";
import {
  getLastTtsAttempt,
  getTtsMaxLength,
  getTtsProvider,
  isSummarizationEnabled,
  isTtsProviderConfigured,
  resolveTtsApiKey,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsAutoMode,
  setTtsMaxLength,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import type { ReplyPayload } from "../types.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

type ParsedTtsCommand = {
  action: string;
  args: string;
};

function parseTtsCommand(normalized: string): ParsedTtsCommand | null {
  // Accept `/tts` and `/tts <action> [args]` as a single control surface.
  if (normalized === "/tts") {
    return { action: "status", args: "" };
  }
  if (!normalized.startsWith("/tts ")) {
    return null;
  }
  const rest = normalized.slice(5).trim();
  if (!rest) {
    return { action: "status", args: "" };
  }
  const [action, ...tail] = rest.split(/\s+/);
  return { action: action.toLowerCase(), args: tail.join(" ").trim() };
}

function ttsUsage(): ReplyPayload {
  // Keep usage in one place so help/validation stays consistent.
  return {
    text:
      `🔊 **TTS (Text-to-Speech) Help**\n\n` +
      `**Commands:**\n` +
      `• /tts on | always — Voice every reply\n` +
      `• /tts inbound — Voice replies to voice/audio messages\n` +
      `• /tts tagged — Voice only explicitly tagged replies\n` +
      `• /tts off — Disable all synthesized voice replies\n` +
      `• /tts status — Show current settings\n` +
      `• /tts provider [name] — View/change provider\n` +
      `• /tts limit [number] — View/change text limit\n` +
      `• /tts summary [on|off] — View/change auto-summary\n` +
      `• /tts audio <text> — Generate audio from text\n\n` +
      `**Providers:**\n` +
      `• edge — Free, fast (default)\n` +
      `• openai — High quality (requires API key)\n` +
      `• elevenlabs — Premium voices (requires API key)\n\n` +
      `**Text Limit (default: 1500, max: 4096):**\n` +
      `When text exceeds the limit:\n` +
      `• Summary ON: AI summarizes, then generates audio\n` +
      `• Summary OFF: Truncates text, then generates audio\n\n` +
      `**Examples:**\n` +
      `/tts provider edge\n` +
      `/tts limit 2000\n` +
      `/tts audio Hello, this is a test!`,
  };
}

async function persistSessionTtsAuto(
  params: Parameters<CommandHandler>[0],
  mode: "always" | "inbound" | "tagged" | "off",
): Promise<void> {
  // The user-facing toggle must update the active session as well as the
  // durable preference. Session overrides win during final-reply synthesis,
  // so leaving a stale `always` value would make `/tts off` appear temporary.
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return;
  }
  params.sessionEntry.ttsAuto = mode;
  await persistSessionEntry(params);
}

export const handleTtsCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseTtsCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring TTS command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const action = parsed.action;
  const args = parsed.args;

  if (action === "help") {
    return { shouldContinue: false, reply: ttsUsage() };
  }

  if (["on", "always", "inbound", "tagged", "off"].includes(action)) {
    // `/tts on` remains the friendly alias for the documented `always` mode.
    // Persisting the exact mode in both stores makes mode changes immediate
    // and restart-safe for the active conversation.
    const mode = action === "on" ? "always" : (action as "always" | "inbound" | "tagged" | "off");
    setTtsAutoMode(prefsPath, mode);
    await persistSessionTtsAuto(params, mode);
    const text =
      mode === "off"
        ? "🔇 TTS disabled. Voice messages will still be transcribed."
        : mode === "always"
          ? "🔊 TTS enabled for every reply."
          : mode === "inbound"
            ? "🔊 TTS enabled for replies to voice/audio messages."
            : "🔊 TTS enabled for explicitly tagged replies.";
    return { shouldContinue: false, reply: { text } };
  }

  if (action === "audio") {
    if (!args.trim()) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `🎤 Generate audio from text.\n\n` +
            `Usage: /tts audio <text>\n` +
            `Example: /tts audio Hello, this is a test!`,
        },
      };
    }

    const start = Date.now();
    const result = await textToSpeech({
      text: args,
      cfg: params.cfg,
      channel: params.command.channel,
      prefsPath,
    });

    if (result.success && result.audioPath) {
      // Store last attempt for `/tts status`.
      setLastTtsAttempt({
        timestamp: Date.now(),
        success: true,
        textLength: args.length,
        summarized: false,
        provider: result.provider,
        latencyMs: result.latencyMs,
      });
      const payload: ReplyPayload = {
        mediaUrl: result.audioPath,
        audioAsVoice: result.voiceCompatible === true,
      };
      return { shouldContinue: false, reply: payload };
    }

    // Store failure details for `/tts status`.
    setLastTtsAttempt({
      timestamp: Date.now(),
      success: false,
      textLength: args.length,
      summarized: false,
      error: result.error,
      latencyMs: Date.now() - start,
    });
    return {
      shouldContinue: false,
      reply: { text: `❌ Error generating audio: ${result.error ?? "unknown error"}` },
    };
  }

  if (action === "provider") {
    const currentProvider = getTtsProvider(config, prefsPath);
    if (!args.trim()) {
      const hasOpenAI = Boolean(resolveTtsApiKey(config, "openai"));
      const hasElevenLabs = Boolean(resolveTtsApiKey(config, "elevenlabs"));
      const hasEdge = isTtsProviderConfigured(config, "edge");
      return {
        shouldContinue: false,
        reply: {
          text:
            `🎙️ TTS provider\n` +
            `Primary: ${currentProvider}\n` +
            `OpenAI key: ${hasOpenAI ? "✅" : "❌"}\n` +
            `ElevenLabs key: ${hasElevenLabs ? "✅" : "❌"}\n` +
            `Edge enabled: ${hasEdge ? "✅" : "❌"}\n` +
            `Usage: /tts provider openai | elevenlabs | edge`,
        },
      };
    }

    const requested = args.trim().toLowerCase();
    if (requested !== "openai" && requested !== "elevenlabs" && requested !== "edge") {
      return { shouldContinue: false, reply: ttsUsage() };
    }

    setTtsProvider(prefsPath, requested);
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS provider set to ${requested}.` },
    };
  }

  if (action === "limit") {
    if (!args.trim()) {
      const currentLimit = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text:
            `📏 TTS limit: ${currentLimit} characters.\n\n` +
            `Text longer than this triggers summary (if enabled).\n` +
            `Range: 100-4096 chars (Telegram max).\n\n` +
            `To change: /tts limit <number>\n` +
            `Example: /tts limit 2000`,
        },
      };
    }
    const next = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(next) || next < 100 || next > 4096) {
      return {
        shouldContinue: false,
        reply: { text: "❌ Limit must be between 100 and 4096 characters." },
      };
    }
    setTtsMaxLength(prefsPath, next);
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS limit set to ${next} characters.` },
    };
  }

  if (action === "summary") {
    if (!args.trim()) {
      const enabled = isSummarizationEnabled(prefsPath);
      const maxLen = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text:
            `📝 TTS auto-summary: ${enabled ? "on" : "off"}.\n\n` +
            `When text exceeds ${maxLen} chars:\n` +
            `• ON: summarizes text, then generates audio\n` +
            `• OFF: truncates text, then generates audio\n\n` +
            `To change: /tts summary on | off`,
        },
      };
    }
    const requested = args.trim().toLowerCase();
    if (requested !== "on" && requested !== "off") {
      return { shouldContinue: false, reply: ttsUsage() };
    }
    setSummarizationEnabled(prefsPath, requested === "on");
    return {
      shouldContinue: false,
      reply: {
        text: requested === "on" ? "✅ TTS auto-summary enabled." : "❌ TTS auto-summary disabled.",
      },
    };
  }

  if (action === "status") {
    const autoMode = resolveTtsAutoMode({
      config,
      prefsPath,
      sessionAuto: params.sessionEntry?.ttsAuto,
    });
    const enabled = autoMode !== "off";
    const provider = getTtsProvider(config, prefsPath);
    const hasKey = isTtsProviderConfigured(config, provider);
    const maxLength = getTtsMaxLength(prefsPath);
    const summarize = isSummarizationEnabled(prefsPath);
    const last = getLastTtsAttempt();
    const lines = [
      "📊 TTS status",
      `State: ${enabled ? "✅ enabled" : "❌ disabled"}`,
      `Mode: ${autoMode}`,
      `Provider: ${provider} (${hasKey ? "✅ configured" : "❌ not configured"})`,
      `Text limit: ${maxLength} chars`,
      `Auto-summary: ${summarize ? "on" : "off"}`,
    ];
    if (last) {
      const timeAgo = Math.round((Date.now() - last.timestamp) / 1000);
      lines.push("");
      lines.push(`Last attempt (${timeAgo}s ago): ${last.success ? "✅" : "❌"}`);
      lines.push(`Text: ${last.textLength} chars${last.summarized ? " (summarized)" : ""}`);
      if (last.success) {
        lines.push(`Provider: ${last.provider ?? "unknown"}`);
        lines.push(`Latency: ${last.latencyMs ?? 0}ms`);
      } else if (last.error) {
        lines.push(`Error: ${last.error}`);
      }
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  return { shouldContinue: false, reply: ttsUsage() };
};
