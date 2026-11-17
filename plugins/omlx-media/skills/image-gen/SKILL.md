---
name: image-gen
description: Use this skill to create, generate, draw, or edit images/photos into saved PNG files with OMLX image models. Covers text-to-image and image-to-image edits. Do not use for text-only image explanations, screenshot summaries, or non-generative image processing scripts.
---

# OMLX Image Generation and Editing

## Workflow

Choose capabilities through [the shared media actions](../../references/actions.md).
Discover an image generation or editing capability from its advertised
description. Otherwise use the bundled CLI's `image` operation.

1. Use this skill only for image creation or generative image editing. Use ordinary tools for analysis, screenshot summaries, resizing, conversion, or other non-generative processing.
2. Turn the request into a finished visual prompt. For edits, state what must change and explicitly preserve important subject details such as pose, clothing, crop, camera angle, text, and privacy blur.
3. Generate or edit once with an absolute path for a new output file. Omit `sources` for text-to-image generation; include absolute read-only source paths for image-to-image generation. Sources are never modified. Pass an absolute mask path only for selective edits. Let the action select a loaded capable model unless the user named one.
4. Inspect the saved result. Retry only when it needs a deliberate change; adjust the prompt, `strength`, or advanced `steps` and `guidance` instead of repeating an identical call accidentally.
5. Report the saved path and selected model.

For a direct skill installation without the plugin CLI, use the bundled Python
helper documented in `references/generation.md` or `references/editing.md`.
Do not switch helpers after a consent, validation, or output-conflict error.
