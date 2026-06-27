---
name: elevenlabs-creative
description: Route creative ElevenLabs work such as voice generation, sound effects, music, dubbing, voice changing, audio isolation, speech-to-text, and exploratory ElevenCreative image/video tasks.
homepage: https://elevenlabs.io/docs
metadata:
  {
    "openclaw":
      {
        "emoji": "🎧",
        "displayName": "ElevenLabs Creative",
        "requires": { "env": ["ELEVENLABS_API_KEY"] },
        "primaryEnv": "ELEVENLABS_API_KEY",
      },
  }
---

# ElevenLabs Creative

Use this skill when the user wants generated or transformed audio through
ElevenLabs: voiceovers, character voices, sound effects, music, dubbing, voice
changing, audio cleanup, speech-to-text, or creative audio for video.

## Routing

- For simple spoken voice replies or local playback, use `sag` when installed.
- For sound effects, music, dubbing, voice changing, audio isolation, or
  speech-to-text, use the ElevenLabs API/docs with `ELEVENLABS_API_KEY`.
- For "video generation" or "image/video" requests, be precise: ElevenLabs has
  ElevenCreative image/video surfaces, but Jarvis should not promise direct
  automation unless the account/API path is actually connected and tested.
- If the API key is missing, route through setup in product language: "ElevenLabs
  is not connected yet. I can help connect an API key or explore the web app."

## Product Language

Say "ElevenLabs Creative" to users. Mention `sag`, API endpoints, model names,
or raw HTTP only when doing setup, debugging, or implementation.

## Current Capability Map

- Voice generation: use `sag` for practical TTS output when available.
- Sound effects: ElevenLabs can generate short effects and loops from prompts.
- Music: Eleven Music can generate full tracks from natural-language prompts on
  supported plans.
- Video-to-music: ElevenLabs exposes a video-to-music API path for generating
  music from uploaded video context.
- Dubbing, voice changing, and audio isolation: use ElevenLabs when the user
  wants to transform existing speech or clean noisy audio.
- Image/video: treat as exploratory unless a tested ElevenCreative path is
  configured in this runtime.

## Safety

- Do not claim copyright, commercial-use, or licensing guarantees. Point users
  to their ElevenLabs plan and terms when usage rights matter.
- Ask before generating realistic voices of a specific private person.
- For public figures, brands, or copyrighted styles, keep prompts transformed
  and avoid impersonation claims.
