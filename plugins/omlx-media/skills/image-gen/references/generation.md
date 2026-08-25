# Image Generation Reference

Detailed parameters for the `generate.py` script.

## Parameters

### Required

| Parameter  | Description                                  |
| ---------- | -------------------------------------------- |
| `--prompt` | Text prompt describing the image to generate |
| `--model`  | Model name (e.g., `omlx-dall-e-3`)           |

### Optional

| Parameter           | Default                     | Description                                                                                                      |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--n`               | `1`                         | Number of images to generate (1–4)                                                                               |
| `--size`            | `1024x1024`                 | Image dimensions. Common values: `1024x1024`, `1024x1792`, `1792x1024`                                           |
| `--response_format` | `b64_json`                  | `b64_json` returns base64, `url` returns URLs                                                                    |
| `--quality`         | `standard`                  | `hd`, `standard`, or `quality`                                                                                   |
| `--style`           | `vivid`                     | `vivid` (bold, dramatic) or `natural` (true to life)                                                             |
| `--output`          | `generated_<model>_<n>.png` | Output file path. Prefer an absolute path in the user's workspace; paths inside the skill directory are refused. |

## Common Size Presets

| Use case  | Size        |
| --------- | ----------- |
| Square    | `1024x1024` |
| Portrait  | `1024x1792` |
| Landscape | `1792x1024` |

## Examples

### Basic generation

```bash
uv run ./scripts/generate.py \
  --prompt "a golden retriever sitting in a field of sunflowers" \
  --model "omlx-dall-e-3" \
  --output "/absolute/path/to/user/workspace/golden-retriever.png"
```

### Multiple images

```bash
uv run ./scripts/generate.py \
  --prompt "futuristic cityscape at sunset" \
  --model "omlx-dall-e-3" \
  --n 4 \
  --size "1024x1792" \
  --output "/absolute/path/to/user/workspace/cityscape.png"
```

### High quality, natural style

```bash
uv run ./scripts/generate.py \
  --prompt "a serene mountain lake at dawn" \
  --model "omlx-dall-e-3" \
  --quality hd \
  --style natural \
  --output "/absolute/path/to/user/workspace/mountain.png"
```

## Model Discovery

Available models are listed at `$OMLX_BASE_URL/v1/models/status`. Prefer models whose `capabilities` or `tasks` include `generation`, or whose `engine_type`/`model_type` is `image`.

## Tips

- Use `uv run ./scripts/generate.py` and write outputs to an absolute path in the user's workspace.
- Use descriptive prompts with subject, setting, style, and mood.
- For consistent results, specify a seed if supported by the model.
- Higher `quality` values produce better images but may take longer.
- `vivid` style is more dramatic; `natural` is more realistic.
