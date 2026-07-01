---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image (Nano Banana Pro).
homepage: https://ai.google.dev/
metadata:
  {
    "openclaw":
      {
        "emoji": "🍌",
        "displayName": "Image Generation",
        "requires": { "bins": ["node"] },
        "install":
          [
            {
              "id": "uv-brew",
              "kind": "brew",
              "formula": "uv",
              "bins": ["uv"],
              "label": "Install uv (brew)",
            },
          ],
      },
  }
---

# Image Generation (Nano Banana Pro)

Use the native or managed image-generation surface first when it is available in
the runtime. Use this bundled Gemini/Nano Banana script as the Jarvis fallback or
direct BYOK path for text-to-image, input-image edits, and multi-image
composition.

Generate

```bash
node {baseDir}/scripts/generate-image.mjs --prompt "your image description" --filename "output.png" --resolution 1K
```

Edit (single image)

```bash
node {baseDir}/scripts/generate-image.mjs --prompt "edit instructions" --filename "output.png" -i "/path/in.png" --resolution 2K
```

Multi-image composition (up to 14 images)

```bash
node {baseDir}/scripts/generate-image.mjs --prompt "combine these into one scene" --filename "output.png" -i img1.png -i img2.png -i img3.png
```

Managed and API key paths

- Jarvis managed mode can generate a text-to-image result through the backend without a local Gemini key.
- Input-image editing/composition still uses the direct BYOK path.
- Direct BYOK: `GEMINI_API_KEY` env var
- Or set `skills."nano-banana-pro".apiKey` / `skills."nano-banana-pro".env.GEMINI_API_KEY` in the active config file. Prefer `$OPENCLAW_CONFIG_PATH`; otherwise use `$OPENCLAW_STATE_DIR/openclaw.json`.

Specific aspect ratio (optional)

```bash
node {baseDir}/scripts/generate-image.mjs --prompt "portrait photo" --filename "output.png" --aspect-ratio 9:16
```

Notes

- Resolutions: `1K` (default), `2K`, `4K`.
- Aspect ratios: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. Without `--aspect-ratio` / `-a`, the model picks freely - use this flag for avatars, profile pics, or consistent batch generation.
- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.
- The script prints a `MEDIA:` line for OpenClaw to auto-attach on supported chat providers.
- Do not read the image back; report the saved path only.
