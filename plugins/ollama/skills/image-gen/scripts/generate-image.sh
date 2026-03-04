#!/usr/bin/env bash
set -euo pipefail

# Generate an image using Ollama with backend auto-detection.
# Usage: generate-image.sh --prompt "..." [options]

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"

MODEL="x/z-image-turbo"
SIZE="1024x1024"
WIDTH=""
HEIGHT=""
OUTPUT=""
PROMPT=""
BACKEND="auto"
STEPS=""
SEED=""
NEGATIVE_PROMPT=""

print_usage() {
  cat <<'EOF'
Usage:
  ./scripts/generate-image.sh --prompt "..." [options]

Options:
  --prompt TEXT            Required text prompt
  --model NAME             Model name (default: x/z-image-turbo)
  --size WxH               Image size (default: 1024x1024)
  --width N                Width alias (requires --height)
  --height N               Height alias (requires --width)
  --output PATH            Output file path (default: image_YYYYMMDD_HHMMSS.png)
  --backend MODE           auto|rest|cli (default: auto)
  --steps N                CLI backend only
  --seed N                 CLI backend only
  --negative-prompt TEXT   CLI backend only
  --help                   Show this help

Notes:
  - auto backend prefers CLI when available.
  - If the requested model is missing, the script attempts: ollama pull <model>.
EOF
}

require_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "Error: ${flag} requires a value." >&2
    exit 1
  fi
}

list_image_files() {
  find . -maxdepth 1 -type f \
    \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) \
    -print | sed 's|^\./||' | LC_ALL=C sort
}

select_newest_file() {
  local newest=""
  local newest_mtime=0
  local file
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if [[ ! -f "$file" ]]; then
      continue
    fi
    local mtime
    mtime="$(stat -f '%m' "$file" 2>/dev/null || echo 0)"
    if (( mtime > newest_mtime )); then
      newest_mtime="$mtime"
      newest="$file"
    fi
  done
  printf '%s' "$newest"
}

has_cli_backend_options() {
  [[ -n "$STEPS" || -n "$SEED" || -n "$NEGATIVE_PROMPT" ]]
}

ensure_model_with_cli() {
  if ! command -v ollama >/dev/null 2>&1; then
    echo "Error: ollama CLI is required to verify/pull model '$MODEL'." >&2
    exit 1
  fi

  if ! ollama show "$MODEL" >/dev/null 2>&1; then
    echo "Model '$MODEL' not found locally. Pulling..." >&2
    ollama pull "$MODEL"
  fi
}

resolve_backend() {
  case "$BACKEND" in
    auto)
      if command -v ollama >/dev/null 2>&1; then
        echo "cli"
      else
        echo "rest"
      fi
      ;;
    rest|cli)
      echo "$BACKEND"
      ;;
    *)
      echo "Error: --backend must be one of: auto, rest, cli" >&2
      exit 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      MODEL="$2"
      shift 2
      ;;
    --size)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      SIZE="$2"
      shift 2
      ;;
    --width)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      WIDTH="$2"
      shift 2
      ;;
    --height)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      HEIGHT="$2"
      shift 2
      ;;
    --output)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      OUTPUT="$2"
      shift 2
      ;;
    --prompt)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      PROMPT="$2"
      shift 2
      ;;
    --backend)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      BACKEND="$2"
      shift 2
      ;;
    --steps)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      STEPS="$2"
      shift 2
      ;;
    --seed)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      SEED="$2"
      shift 2
      ;;
    --negative-prompt)
      if [[ $# -lt 2 ]]; then require_value "$1"; fi
      NEGATIVE_PROMPT="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PROMPT" ]]; then
  echo "Error: --prompt is required" >&2
  exit 1
fi

# Default output filename based on timestamp
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="image_$(date +%Y%m%d_%H%M%S).png"
fi

if [[ -n "$WIDTH" || -n "$HEIGHT" ]]; then
  if [[ -z "$WIDTH" || -z "$HEIGHT" ]]; then
    echo "Error: --width and --height must be provided together." >&2
    exit 1
  fi
  SIZE="${WIDTH}x${HEIGHT}"
fi

if ! [[ "$SIZE" =~ ^[0-9]+x[0-9]+$ ]]; then
  echo "Error: --size must be in WxH format (for example 1024x1024)." >&2
  exit 1
fi

if [[ -n "$STEPS" && ! "$STEPS" =~ ^[0-9]+$ ]]; then
  echo "Error: --steps must be an integer." >&2
  exit 1
fi

if [[ -n "$SEED" && ! "$SEED" =~ ^-?[0-9]+$ ]]; then
  echo "Error: --seed must be an integer." >&2
  exit 1
fi

RESOLVED_BACKEND="$(resolve_backend)"
if has_cli_backend_options && [[ "$RESOLVED_BACKEND" == "rest" ]]; then
  if [[ "$BACKEND" == "rest" ]]; then
    echo "Error: --steps, --seed, and --negative-prompt are not supported with --backend rest." >&2
  else
    echo "Error: Advanced options require CLI backend, but auto mode selected REST (ollama CLI unavailable)." >&2
  fi
  exit 1
fi

case "$RESOLVED_BACKEND" in
  cli)
    ensure_model_with_cli
    ;;
  rest)
    if command -v ollama >/dev/null 2>&1; then
      ensure_model_with_cli
    fi
    ;;
esac

SIZE_WIDTH="${SIZE%x*}"
SIZE_HEIGHT="${SIZE#*x}"

if [[ "$RESOLVED_BACKEND" == "rest" ]]; then
  PAYLOAD=$(jq -n \
    --arg model "$MODEL" \
    --arg prompt "$PROMPT" \
    --arg size "$SIZE" \
    '{model: $model, prompt: $prompt, size: $size, response_format: "b64_json"}')

  RESPONSE=$(curl -sf "${OLLAMA_BASE_URL}/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD") || {
    echo "Error: Failed to reach Ollama at ${OLLAMA_BASE_URL}." >&2
    echo "Make sure Ollama is running (ollama serve)." >&2
    exit 1
  }

  B64_DATA=$(echo "$RESPONSE" | jq -r '.data[0].b64_json // empty')
  if [[ -z "$B64_DATA" ]]; then
    ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error // empty')
    if [[ -n "$ERROR_MSG" ]]; then
      echo "Error from Ollama: $ERROR_MSG" >&2
      if [[ "$ERROR_MSG" == *"model"* && "$ERROR_MSG" == *"not found"* ]]; then
        echo "Hint: ensure '$MODEL' is available locally (for example: ollama pull $MODEL)." >&2
      fi
    else
      echo "Error: No image data in response." >&2
    fi
    exit 1
  fi

  echo "$B64_DATA" | base64 -d > "$OUTPUT"
  echo "Image saved to: $OUTPUT"
  exit 0
fi

TMP_BEFORE="$(mktemp)"
TMP_AFTER="$(mktemp)"
TMP_CLI_OUTPUT="$(mktemp)"
trap 'rm -f "$TMP_BEFORE" "$TMP_AFTER" "$TMP_CLI_OUTPUT"' EXIT

list_image_files > "$TMP_BEFORE"

CLI_CMD=(ollama run "$MODEL" --width "$SIZE_WIDTH" --height "$SIZE_HEIGHT")
if [[ -n "$STEPS" ]]; then
  CLI_CMD+=(--steps "$STEPS")
fi
if [[ -n "$SEED" ]]; then
  CLI_CMD+=(--seed "$SEED")
fi
if [[ -n "$NEGATIVE_PROMPT" ]]; then
  CLI_CMD+=(--negative "$NEGATIVE_PROMPT")
fi
CLI_CMD+=("$PROMPT")

if ! "${CLI_CMD[@]}" 2>&1 | tee "$TMP_CLI_OUTPUT"; then
  echo "Error: ollama run failed." >&2
  exit 1
fi

list_image_files > "$TMP_AFTER"
NEW_FILES="$(comm -13 "$TMP_BEFORE" "$TMP_AFTER" || true)"
GENERATED_FILE="$(printf '%s\n' "$NEW_FILES" | select_newest_file)"

if [[ -z "$GENERATED_FILE" ]]; then
  CANDIDATE="$(grep -Eo '([^[:space:]]+\.(png|jpg|jpeg|webp))' "$TMP_CLI_OUTPUT" | tail -n 1 || true)"
  if [[ -n "$CANDIDATE" && -f "$CANDIDATE" ]]; then
    GENERATED_FILE="$CANDIDATE"
  fi
fi

if [[ -z "$GENERATED_FILE" ]]; then
  echo "Error: CLI generation succeeded, but the script could not determine the output image file." >&2
  echo "Try --backend rest --output <path>, or rerun from a clean output directory." >&2
  exit 1
fi

if [[ "$GENERATED_FILE" != "$OUTPUT" ]]; then
  mv "$GENERATED_FILE" "$OUTPUT"
fi

echo "Image saved to: $OUTPUT"
