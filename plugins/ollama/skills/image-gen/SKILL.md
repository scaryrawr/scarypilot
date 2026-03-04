---
name: image-gen
description: "Generate images from text prompts using Ollama's local image generation models."
---

# Ollama Image Generation

Generate images locally with a single helper that supports both Ollama CLI and REST backends. This feature is currently **macOS-only** and uses Ollama's experimental image generation support.

## Models

### Z-Image Turbo (default)

6B parameter model from Alibaba's Tongyi Lab. Best for photorealistic images and bilingual (English/Chinese) text rendering. Apache 2.0 licensed.

### FLUX.2 Klein

Black Forest Labs' fast image-generation model (4B and 9B sizes). Best for readable text in images, UI mockups, and typography-heavy designs.

- 4B: Apache 2.0 (commercial use OK)
- 9B: FLUX Non-Commercial License v2.1

## Model Selection Guide

| Need                                | Recommended Model                         |
| ----------------------------------- | ----------------------------------------- |
| Photorealistic portraits/scenes     | `x/z-image-turbo`                         |
| Chinese text rendering              | `x/z-image-turbo`                         |
| Readable text in images (signs, UI) | `x/flux2-klein`                           |
| Commercial use                      | `x/z-image-turbo` or `x/flux2-klein` (4B) |
| General purpose                     | `x/z-image-turbo`                         |

Default to `x/z-image-turbo` unless the user has a specific need for text rendering in images.

## Generating Images

Use the helper script (backend defaults to `auto`, which prefers CLI when available):

```bash
./scripts/generate-image.sh --prompt "Young woman in a cozy coffee shop, natural window lighting, wearing a cream knit sweater, holding a ceramic mug, soft bokeh background"
```

Choose a specific model and image size:

```bash
./scripts/generate-image.sh \
  --model x/flux2-klein \
  --size 512x512 \
  --output my-image.png \
  --prompt "A neon sign reading OPEN 24 HOURS in a rainy alley"
```

Use richer generation controls (CLI backend):

```bash
./scripts/generate-image.sh \
  --backend cli \
  --model x/flux2-klein \
  --width 1024 \
  --height 1024 \
  --steps 20 \
  --seed 42 \
  --negative-prompt "blurry, low quality, distorted" \
  --output detailed.png \
  --prompt "UI dashboard mockup with clean typography and clear labels"
```

Images are saved to the **current working directory** by default unless `--output` is provided. Always tell the user where the generated image was saved.

### Backend Selection

| Backend | Description |
| ------- | ----------- |
| `auto` (default) | Prefers `ollama run` when available; falls back to REST |
| `cli` | Uses `ollama run` directly (supports richer options) |
| `rest` | Uses `POST /v1/images/generations` |

If requested model is missing, the script attempts `ollama pull <model>`.

### Script Options

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--prompt` | *(required)* | The text prompt |
| `--model` | `x/z-image-turbo` | Ollama model name |
| `--size` | `1024x1024` | Image dimensions (`WxH`) |
| `--width` / `--height` | unset | Size aliases (must be used together) |
| `--output` | `image_YYYYMMDD_HHMMSS.png` | Output file path |
| `--backend` | `auto` | `auto`, `cli`, or `rest` |
| `--steps` | unset | Denoising steps (CLI backend only) |
| `--seed` | unset | Random seed (CLI backend only) |
| `--negative-prompt` | unset | Negative prompt text (CLI backend only) |

### Capability Matrix

| Capability | CLI backend | REST backend |
| ---------- | ----------- | ------------ |
| Basic prompt + model + size | ✅ | ✅ |
| `steps` / `seed` / `negative prompt` | ✅ | ❌ |
| `width` / `height` aliases | ✅ | ✅ (normalized to `size`) |

If `--backend rest` is forced with CLI-only options, the script fails with an actionable error.

### Direct curl Example

You can still call the REST API directly:

```bash
curl -s http://localhost:11434/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "x/z-image-turbo",
    "prompt": "A sunset over the ocean with dramatic clouds",
    "size": "1024x1024",
    "response_format": "b64_json"
  }' | jq -r '.data[0].b64_json' | base64 -d > output.png
```

## Image Size

Control the output dimensions with `--size` (or `--width` + `--height`). Format is `WxH`. Smaller images generate faster and use less memory.

Common sizes: `512x512`, `768x768`, `1024x1024`

## Workflow

1. Confirm the user's prompt and preferences (model, size, style, optional steps/seed/negative prompt)
2. Run the helper script with `--backend auto` unless the user explicitly requests a backend
3. If advanced controls are requested, prefer `--backend cli` (or rely on `auto` when CLI is available)
4. Report the output file location to the user
5. If the user wants adjustments, iterate with modified prompt, size, or advanced controls

## Prompting Tips

- Be specific and descriptive: include lighting, composition, style, and mood
- For photorealistic results, mention camera settings (e.g., "shot on 35mm film", "soft bokeh")
- For creative work, reference art styles (e.g., "watercolor", "surreal double exposure")
- Keep prompts focused on a single subject or scene for best results
