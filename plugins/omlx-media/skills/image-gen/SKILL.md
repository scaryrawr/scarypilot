---
name: image-gen
description: Use this skill to create, generate, draw, or edit images/photos into saved PNG files with OMLX image models. Covers text-to-image and image-to-image edits. Do not use for text-only image explanations, screenshot summaries, or non-generative image processing scripts.
allowed-tools: omlx_image Bash(uv run ./scripts/generate.py:*) Bash(uv run ./scripts/edit.py:*)
---

# OMLX Image Generation and Editing

## Workflow

1. Use this skill only for image creation or generative image editing. Use ordinary tools for analysis, screenshot summaries, resizing, conversion, or other non-generative processing.
2. Turn the request into a finished visual prompt. For edits, state what must change and explicitly preserve important subject details such as pose, clothing, crop, camera angle, text, and privacy blur.
3. Call `omlx_image` once with an absolute path for a new output file. Omit `sources` for text-to-image generation; include absolute read-only source paths for image-to-image generation. Sources are never modified. Pass an absolute mask path only for selective edits. Let the tool select a loaded capable model unless the user named one.
4. Inspect the saved result. Retry only when it needs a deliberate change; adjust the prompt, `strength`, or advanced `steps` and `guidance` instead of repeating an identical call accidentally.
5. Report the saved path and selected model.

If `omlx_image` is unavailable because this skill was installed without the plugin, use the bundled Python helper documented in `references/generation.md` or `references/editing.md`. Do not load those references during the native-tool path.
