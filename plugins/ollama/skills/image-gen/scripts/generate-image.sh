#!/usr/bin/env bash
set -euo pipefail

# Generate an image using the Ollama REST API (OpenAI-compatible endpoint).
# Usage: generate-image.sh --prompt "..." [--model MODEL] [--size WxH] [--output PATH]

OLLAMA_BASE_URL="http://localhost:11434"

MODEL="x/z-image-turbo"
SIZE="1024x1024"
OUTPUT=""
PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)  MODEL="$2";  shift 2 ;;
    --size)   SIZE="$2";   shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
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

# Build JSON payload
PAYLOAD=$(jq -n \
  --arg model "$MODEL" \
  --arg prompt "$PROMPT" \
  --arg size "$SIZE" \
  '{model: $model, prompt: $prompt, size: $size, response_format: "b64_json"}')

# Call the Ollama REST API
RESPONSE=$(curl -sf "${OLLAMA_BASE_URL}/v1/images/generations" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD") || {
  echo "Error: Failed to reach Ollama at ${OLLAMA_BASE_URL}." >&2
  echo "Make sure Ollama is running (ollama serve)." >&2
  exit 1
}

# Extract and validate base64 image data
B64_DATA=$(echo "$RESPONSE" | jq -r '.data[0].b64_json // empty')

if [[ -z "$B64_DATA" ]]; then
  ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error // empty')
  if [[ -n "$ERROR_MSG" ]]; then
    echo "Error from Ollama: $ERROR_MSG" >&2
  else
    echo "Error: No image data in response." >&2
  fi
  exit 1
fi

# Decode and save
echo "$B64_DATA" | base64 -d > "$OUTPUT"
echo "Image saved to: $OUTPUT"
