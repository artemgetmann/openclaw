---
name: summarize
description: Summarize or extract text/transcripts from URLs, podcasts, and local files (great fallback for “transcribe this YouTube/video”).
homepage: https://summarize.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🧾",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "summarize",
              "bins": ["summarize"],
              "label": "Install summarize (brew)",
              "versionCommand": ["summarize", "--version"],
              "versionRegex": "v?(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)",
              "recommendedVersion": "0.21.6",
            },
          ],
      },
  }
---

# Summarize

Summarize URLs and files. Podcast and direct-audio transcription uses Jarvis's
managed OpenAI provider first, so the user does not need Whisper or a personal
provider API key.

## When to use (trigger phrases)

Use this skill immediately when the user asks any of:

- “use summarize.sh”
- “what’s this link/video about?”
- “summarize this URL/article”
- “transcribe this YouTube/video” (best-effort transcript extraction; no `yt-dlp` needed)

## Quick start

```bash
summarize "https://example.com"
summarize "/path/to/file.pdf"
summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto
summarize "/path/to/podcast.mp3" --transcriber auto
```

## Podcast and direct-audio URLs: managed first

For a Spotify episode or direct HTTP(S) audio URL, transcribe through the
product-managed media path:

```bash
openclaw media transcribe --url "https://open.spotify.com/episode/ID" --json
```

Then summarize the returned `text` with the active agent model. Do not send the
URL to the external `summarize` CLI first: that CLI has separate transcription
providers and can incorrectly ask a Jarvis user to install Whisper or supply a
personal API key.

Spotify resolution is limited to episodes that can be matched to a publisher's
public RSS feed. If no public feed or matching episode exists, report that
boundary. Do not attempt to download Spotify's protected stream.

For a local audio file, use the same managed provider when available:

```bash
openclaw media transcribe --file "/path/to/podcast.mp3" --json
```

## YouTube: summary vs transcript

Best-effort transcript/extraction:

```bash
summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto --extract
summarize "/path/to/podcast.mp3" --transcriber auto --extract
```

If the user asked for a transcript but it’s huge, return a tight summary first, then ask which section/time range to expand.

## External CLI fallback: model + keys

Use the external `summarize` CLI for ordinary web pages, documents, and YouTube
extraction. It is optional for the managed podcast path above.

Set the API key for your chosen provider:

- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`
- xAI: `XAI_API_KEY`
- Google: `GEMINI_API_KEY` (aliases: `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`)

Default model is `auto` if none is set; pass `--model <provider/model>` only when a specific provider is needed.

## Useful flags

- `--length short|medium|long|xl|xxl|<chars>`
- `--max-output-tokens <count>`
- `--extract` (print extracted content/transcript and exit)
- `--json` (machine readable)
- `--firecrawl auto|off|always` (fallback extraction)
- `--youtube auto|web|no-auto|yt-dlp|apify`
- `--transcriber auto|whisper|parakeet|canary` (audio transcription)
- `--video-mode auto|transcript|understand`
- `--slides`, `--slides-ocr`, `--slides-max <count>` (slide-heavy videos)

## Config

Optional config file: `~/.summarize/config.json`

```json
{ "model": "auto" }
```

Optional services:

- `FIRECRAWL_API_KEY` for blocked sites
- `APIFY_API_TOKEN` for YouTube fallback
