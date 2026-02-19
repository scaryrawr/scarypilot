---
name: image-gen
description: "Generate images from text prompts using Ollama's local image generation models."
---

# Ollama Image Generation

Generate images locally using Ollama's REST API (`/v1/images/generations`). This feature is currently **macOS-only** and uses Ollama's experimental OpenAI-compatible image generation endpoint.

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

Use the helper script to generate images via the Ollama REST API:

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

Images are saved to the **current working directory** by default. Always tell the user where the generated image was saved.

### Script Options

| Option     | Default                            | Description                    |
| ---------- | ---------------------------------- | ------------------------------ |
| `--prompt` | *(required)*                       | The text prompt                |
| `--model`  | `x/z-image-turbo`                 | Ollama model name              |
| `--size`   | `1024x1024`                       | Image dimensions (`WxH`)       |
| `--output` | `image_YYYYMMDD_HHMMSS.png`       | Output file path               |

### Direct curl Example

You can also call the API directly:

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

Control the output dimensions with the `--size` flag (or `size` field in the JSON body). Format is `WxH`. Smaller images generate faster and use less memory.

Common sizes: `512x512`, `768x768`, `1024x1024`

## Workflow

1. Confirm the user's prompt and any preferences (model, size, style)
2. Ensure Ollama is running (`curl -s http://localhost:11434/v1/models` to verify)
3. Run the helper script with the appropriate model and prompt
4. Report the output file location to the user
5. If the user wants adjustments, iterate with modified prompts or size

## Prompting Tips

- Be specific and descriptive: include lighting, composition, style, and mood
- For photorealistic results, mention camera settings (e.g., "shot on 35mm film", "soft bokeh")
- For creative work, reference art styles (e.g., "watercolor", "surreal double exposure")
- Keep prompts focused on a single subject or scene for best results
