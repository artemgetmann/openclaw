---
name: openai-whisper-api
description: Direct OpenAI Audio Transcriptions API access. Use only when the user explicitly requests the direct API path or when diagnosing that provider; use the configured media transcription route for ordinary requests.
homepage: https://platform.openai.com/docs/guides/speech-to-text
metadata:
  {
    "openclaw":
      {
        "emoji": "🌐",
        "requires": { "bins": ["curl"], "env": ["OPENAI_API_KEY"] },
        "primaryEnv": "OPENAI_API_KEY",
      },
  }
---

# OpenAI Whisper API (curl)

Transcribe an audio file directly through OpenAI’s
`/v1/audio/transcriptions` endpoint. This bypasses the runtime's configured
media route, so use it only when the user explicitly requests direct API access
or when diagnosing that provider. For ordinary transcription requests, use
`openclaw media transcribe --file <path> --json`.

## Quick start

```bash
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a
```

Defaults:

- Model: `whisper-1`
- Output: `<input>.txt`

## Useful flags

```bash
{baseDir}/scripts/transcribe.sh /path/to/audio.ogg --model whisper-1 --out /tmp/transcript.txt
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --language en
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --prompt "Speaker names: Peter, Daniel"
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --json --out /tmp/transcript.json
```

## API key

Set `OPENAI_API_KEY`, or configure it in the active OpenClaw/Jarvis config.
Prefer `$OPENCLAW_CONFIG_PATH`; otherwise use `$OPENCLAW_STATE_DIR/openclaw.json`.
For source/dev OpenClaw with no active env override, the fallback is `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    "openai-whisper-api": {
      apiKey: "OPENAI_KEY_HERE",
    },
  },
}
```
