---
name: image-gen
description: Use this skill to create, generate, draw, or edit images/photos into saved PNG files with OMLX image models. Covers text-to-image and image-to-image edits. Do not use for text-only image explanations, screenshot summaries, or non-generative image processing scripts.
allowed-tools: Bash(uv run ./scripts/generate.py:*) Bash(uv run ./scripts/edit.py:*)
---

# OMLX Image Generation and Editing

## Requirements

- `$OMLX_BASE_URL` must be set.
- `uv` must be available to run the bundled Python helpers.
- Editing requires a source `.png`, `.jpg`, `.jpeg`, or `.webp` file.
- If the loaded task is non-generative image analysis or simple file processing, stop using this skill and handle it with ordinary tooling.

## Workflow

1. Keep user inputs and outputs in the user's workspace. Pass absolute workspace paths for `--input`, `--inputs`, `--mask`, and `--output`.
2. Discover an available model from `$OMLX_BASE_URL/v1/models/status` unless the user specified one. The response puts models under `.models` (not `.data`). Prefer models with `engine_type` or `model_type` of `image` and a loaded status. A working discovery query:

```bash
curl -s "$OMLX_BASE_URL/v1/models/status" | jq '.models[] | select(.engine_type == "image" or .model_type == "image") | {id, loaded, capabilities}'
```

Prefer loaded models whose `capabilities` or `tasks` include `generation` or `edit`.
3. Use `uv run ./scripts/generate.py` or `uv run ./scripts/edit.py`. Do not hard-code install locations, copy scripts elsewhere, or run non-bundled wrappers. The scripts refuse outputs inside the skill directory.
4. For structural edits that transform a scene while preserving the subject, prefer FLUX.2/Klein edit models over ERNIE when both are available. Prompt explicitly for preserved subject details (pose, clothing, crop, camera angle, privacy blur) and the replacement scene. If the first result changes too much or too little, retry with `--image_strength` values such as `0.2`, `0.4`, or `0.6`, and use `--steps`/`--guidance` for quality and prompt-adherence sweeps.
5. Report the saved file path and model used.

## Commands

Generate:

```bash
uv run ./scripts/generate.py \
  --prompt "a watercolor fox in a moonlit forest" \
  --model "<image-model>" \
  --size "1024x1024" \
  --output "/absolute/path/to/user/workspace/result.png"
```

Edit:

```bash
uv run ./scripts/edit.py \
  --input "/absolute/path/to/user/workspace/source.png" \
  --prompt "add sunglasses" \
  --model "<image-edit-model>" \
  --output "/absolute/path/to/user/workspace/edited.png"
```

Read `references/generation.md` or `references/editing.md` only when you need optional parameters such as `--n`, `--quality`, `--style`, `--mask`, `--steps`, `--guidance`, `--image_strength`, multi-input edits, or URL responses.
