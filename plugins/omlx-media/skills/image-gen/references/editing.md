# Image Editing Reference

Detailed parameters for the `edit.py` script.

## Parameters

### Required

| Parameter  | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `--input`  | Single source image (`.png`, `.jpg`, `.jpeg`) — default mode  |
| `--inputs` | Multiple source images (overrides `--input`, model-dependent) |
| `--prompt` | Instructions for editing the image                            |
| `--model`  | Model name (e.g., `omlx-dall-e-edit`)                         |

### Optional

| Parameter           | Default              | Description                                                                                                                 |
| ------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--mask`            | —                    | Mask image for selective edits (white = edited area)                                                                        |
| `--n`               | `1`                  | Number of edited images (1–4)                                                                                               |
| `--size`            | same as input        | Output dimensions. Use `auto` to let the model decide, or `WIDTHxHEIGHT` (e.g. `1024x1024`).                                |
| `--steps`           | model default        | Inference steps. More steps can improve detail but takes longer.                                                            |
| `--guidance`        | model default        | Prompt guidance scale. Higher values may follow the prompt more strongly but can look less natural.                         |
| `--image_strength`  | model default        | Source-image/edit strength, model-dependent. Try values from `0.2` to `0.7` when balancing preservation and transformation. |
| `--response_format` | `b64_json`           | `b64_json` returns base64, `url` returns URLs                                                                               |
| `--output`          | `edited_<model>.png` | Output file path. Prefer an absolute path in the user's workspace; paths inside the skill directory are refused.            |

## Mask Format

When using `--mask`:

- White pixels (`#ffffff`) indicate the edited area
- Black pixels (`#000000`) are preserved
- Grayscale values are partially edited
- Must be the same dimensions as the input image

## Examples

### Simple edit

```bash
uv run ./scripts/edit.py \
  --input "/absolute/path/to/user/workspace/photo.png" \
  --prompt "add sunglasses to the person" \
  --model "omlx-dall-e-edit" \
  --output "/absolute/path/to/user/workspace/photo-sunglasses.png"
```

### Selective edit with mask

```bash
uv run ./scripts/edit.py \
  --input "/absolute/path/to/user/workspace/photo.png" \
  --prompt "replace the sky with a sunset" \
  --mask "/absolute/path/to/user/workspace/sky_mask.png" \
  --model "omlx-dall-e-edit" \
  --output "/absolute/path/to/user/workspace/edited.png"
```

### Multiple variations

```bash
uv run ./scripts/edit.py \
  --input "/absolute/path/to/user/workspace/photo.png" \
  --prompt "change background to a beach" \
  --model "omlx-dall-e-edit" \
  --n 3 \
  --response_format b64_json \
  --output "/absolute/path/to/user/workspace/beach.png"
```

## Multi-Input Edits

Some models support multiple input images (`--inputs`). The prompt applies across all inputs.

```bash
uv run ./scripts/edit.py \
  --inputs "/absolute/path/to/user/workspace/photo1.png" "/absolute/path/to/user/workspace/photo2.png" "/absolute/path/to/user/workspace/photo3.png" \
  --prompt "combine these into a collage" \
  --model "omlx-multi-edit" \
  --output "/absolute/path/to/user/workspace/collage.png"
```

- `--inputs` accepts one or more filenames (separated by spaces)
- `--inputs` overrides `--input` when both are provided
- Model support for multiple inputs varies — check model docs

## Model Discovery

Available models are listed at `$OMLX_BASE_URL/v1/models/status`. Prefer models whose `capabilities` or `tasks` include `edit` for image edits.

## Tips

- Use `uv run ./scripts/edit.py` and absolute paths for user workspace inputs and outputs.
- For structural scene edits, prefer FLUX.2/Klein edit models when available; ERNIE edit models are often better for gentler image-to-image changes.
- Preserve important subject details explicitly in the prompt: pose, clothing, crop, camera angle, privacy blur, and any objects that must stay fixed.
- Keep prompts concise but concrete — describe what to preserve and what to replace.
- Use `--image_strength` when the model changes too much or too little; try a small sweep such as `0.2`, `0.4`, and `0.6`.
- Use `--steps`/`--guidance` for quality and prompt adherence experiments before changing code.
- For selective edits, provide a mask where white = edited area.
- The mask should match the input image dimensions.
- Use `response_format=url` if you prefer URLs over base64 encoding.
