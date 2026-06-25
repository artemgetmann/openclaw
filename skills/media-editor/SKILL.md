---
name: media-editor
description: Edit, convert, trim, inspect, or prepare audio and video files with FFmpeg/ffprobe. Use when the user asks for audio/video conversion, clipping, compression, normalization, extracting audio, adding/removing streams, subtitles, thumbnails, or voice-note/video cleanup.
homepage: https://ffmpeg.org
metadata:
  {
    "openclaw":
      {
        "emoji": "🎞️",
        "displayName": "Audio & Video Editing",
        "requires": { "bins": ["ffmpeg", "ffprobe"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "ffmpeg",
              "bins": ["ffmpeg", "ffprobe"],
              "label": "Install FFmpeg (brew)",
            },
          ],
      },
  }
---

# Audio & Video Editing

Use this skill for practical media-file work: trim clips, convert formats,
compress files, extract audio, normalize volume, inspect metadata, create
thumbnails, prepare voice notes, or burn/strip subtitles.

## Routing

- Use `ffprobe` first when the task depends on duration, streams, codecs,
  dimensions, rotation, or audio layout.
- Use existing narrow skills when they match better:
  - `video-frames` for quick frame extraction.
  - `openai-whisper` or `openai-whisper-api` for transcription.
  - `songsee` for spectrograms or audio feature visualizations.
- Prefer deterministic FFmpeg commands over GUI automation for file conversion
  and clipping.
- Never overwrite the original media file unless the user explicitly asks.
  Write a new output path and sanity-check it exists.

## Common Jobs

- Inspect: `ffprobe -hide_banner -i input.mp4`
- Trim without re-encode: `ffmpeg -ss 00:01:00 -to 00:02:00 -i input.mp4 -c copy output.mp4`
- Convert to mp3: `ffmpeg -i input.m4a -vn -codec:a libmp3lame -q:a 2 output.mp3`
- Compress video: `ffmpeg -i input.mov -c:v libx264 -crf 24 -preset medium -c:a aac output.mp4`
- Extract audio: `ffmpeg -i input.mp4 -vn -acodec copy output.m4a`

After edits, verify with `ffprobe` or a file-size/duration check before saying
the output is ready.
