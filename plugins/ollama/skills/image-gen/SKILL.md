---
name: image-gen
description: "Generate images from text prompts using Ollama's local image generation models."
---

# Ollama Image Generation

Generate images locally using Ollama's experimental text-to-image models. This feature is currently **macOS-only**.

## Models

### Z-Image Turbo (default)

6B parameter model from Alibaba's Tongyi Lab. Best for photorealistic images and bilingual (English/Chinese) text rendering. Apache 2.0 licensed.

```bash
ollama run x/z-image-turbo "your prompt here"
```

### FLUX.2 Klein

Black Forest Labs' fast image-generation model (4B and 9B sizes). Best for readable text in images, UI mockups, and typography-heavy designs.

- 4B: Apache 2.0 (commercial use OK)
- 9B: FLUX Non-Commercial License v2.1

```bash
ollama run x/flux2-klein "your prompt here"
```

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

Run the model with a descriptive prompt:

```bash
ollama run x/z-image-turbo "Young woman in a cozy coffee shop, natural window lighting, wearing a cream knit sweater, holding a ceramic mug, soft bokeh background"
```

Images are saved to the **current working directory**. Terminals that support image rendering (Ghostty, iTerm2, etc.) can preview images inline.

Always tell the user where the generated image was saved.

## Configuration

Settings are changed using `/set` commands inside an interactive `ollama run` session. Start a session first, configure it, then type your prompt:

```bash
$ ollama run x/z-image-turbo
>>> /set num_steps 20
Set num_steps to "20"
>>> /set width 1024
Set width to "1024"
>>> /set height 1024
Set height to "1024"
>>> A sunset over the ocean with dramatic clouds
```

Settings persist for the duration of the session. You can also generate a quick one-off image without changing settings:

```bash
ollama run x/z-image-turbo "A sunset over the ocean with dramatic clouds"
```

### Image Size

Modify width and height. Smaller images generate faster and use less memory.

```
/set width 1024
/set height 1024
```

### Number of Steps

Controls iteration count. Fewer steps = faster but less detailed. Too many steps can cause artifacts. The default is typically 4, which prioritizes speed but may produce lower fidelity results.

| Steps       | Use Case                                     |
| ----------- | -------------------------------------------- |
| 4 (default) | Quick drafts, fast iteration                 |
| 8–12        | Good balance of quality and speed            |
| 20–30       | High fidelity, detailed images               |
| 30+         | Diminishing returns; may introduce artifacts |

Increase steps when the user needs fine details, readable text in images, or higher quality output. Suggest 20+ steps for text-heavy prompts or when using FLUX.2 Klein for UI mockups.

```
/set num_steps 20
```

### Random Seed

Set a seed for reproducible results. Different seeds produce different images from the same prompt.

```
/set seed 42
```

### Negative Prompts

Guide the model on what to exclude from the image.

```
/set negative_prompt "blurry, low quality, distorted"
```

## Workflow

1. Confirm the user's prompt and any preferences (model, size, style)
2. Ensure Ollama is running (`ollama list` to verify)
3. Run the appropriate model with the prompt
4. Report the output file location to the user
5. If the user wants adjustments, iterate with modified prompts or settings

## Prompting Tips

- Be specific and descriptive: include lighting, composition, style, and mood
- For photorealistic results, mention camera settings (e.g., "shot on 35mm film", "soft bokeh")
- For creative work, reference art styles (e.g., "watercolor", "surreal double exposure")
- Keep prompts focused on a single subject or scene for best results
