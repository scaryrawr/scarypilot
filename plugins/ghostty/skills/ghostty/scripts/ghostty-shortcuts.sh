#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ghostty-shortcuts.sh <action> [options]

Run Ghostty automation via macOS Shortcuts.

Actions:
  new       Create a new context
  focus     Focus a terminal target
  input     Send input text

Options:
  --shortcut NAME            Override shortcut name for this call
  --location LOCATION        window|tab|split:left|split:right|split:up|split:down (new)
  --command COMMAND          Command to run (new)
  --working-directory PATH   Working directory (new)
  --env KEY=VALUE            Environment variable, repeatable (new)
  --target TARGET            Target selector text (focus/input)
  --text TEXT                Input text (input)
  --submit                   Press Enter after input text (input)
  -h, --help                 Show this help

Default shortcut names (override with env vars):
  GHOSTTY_SHORTCUT_NEW_TERMINAL   (default: "Ghostty New Terminal")
  GHOSTTY_SHORTCUT_FOCUS_TERMINAL (default: "Ghostty Focus Terminal")
  GHOSTTY_SHORTCUT_INPUT_TEXT     (default: "Ghostty Input Text")
USAGE
}

normalize_location() {
  case "$1" in
    window|tab|split:left|split:right|split:up|split:down) printf '%s' "$1" ;;
    split-left) printf 'split:left' ;;
    split-right) printf 'split:right' ;;
    split-up) printf 'split:up' ;;
    split-down) printf 'split:down' ;;
    *)
      echo "Invalid location: $1" >&2
      return 1
      ;;
  esac
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

default_shortcut_for_action() {
  case "$1" in
    new) printf '%s' "${GHOSTTY_SHORTCUT_NEW_TERMINAL:-Ghostty New Terminal}" ;;
    focus) printf '%s' "${GHOSTTY_SHORTCUT_FOCUS_TERMINAL:-Ghostty Focus Terminal}" ;;
    input) printf '%s' "${GHOSTTY_SHORTCUT_INPUT_TEXT:-Ghostty Input Text}" ;;
    *)
      echo "Unknown action: $1" >&2
      exit 1
      ;;
  esac
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

action="$1"
shift

if [[ "$action" == "-h" || "$action" == "--help" ]]; then
  usage
  exit 0
fi

location="window"
command_text=""
working_directory=""
target=""
text=""
submit=0
shortcut_override=""
env_vars=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shortcut)
      shortcut_override="${2-}"
      shift 2
      ;;
    --location)
      location="$(normalize_location "${2-}")"
      shift 2
      ;;
    --command)
      command_text="${2-}"
      shift 2
      ;;
    --working-directory)
      working_directory="${2-}"
      shift 2
      ;;
    --env)
      env_vars+=("${2-}")
      shift 2
      ;;
    --target)
      target="${2-}"
      shift 2
      ;;
    --text)
      text="${2-}"
      shift 2
      ;;
    --submit)
      submit=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

case "$action" in
  new|focus)
    ;;
  input)
    if [[ -z "$text" ]]; then
      echo "--text is required for action 'input'" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unknown action: $action" >&2
    usage
    exit 1
    ;;
esac

require_command shortcuts
require_command python3

shortcut_name="$shortcut_override"
if [[ -z "$shortcut_name" ]]; then
  shortcut_name="$(default_shortcut_for_action "$action")"
fi

shortcuts_list="$(shortcuts list 2>/dev/null || true)"
if ! printf '%s\n' "$shortcuts_list" | grep -Fx -- "$shortcut_name" >/dev/null 2>&1; then
  echo "Shortcut not found: $shortcut_name" >&2
  echo "Run 'shortcuts list' to inspect available shortcuts." >&2
  echo "You can override default shortcut names with GHOSTTY_SHORTCUT_* environment variables (e.g. GHOSTTY_SHORTCUT_NEW_TERMINAL, GHOSTTY_SHORTCUT_FOCUS_TERMINAL, GHOSTTY_SHORTCUT_INPUT_TEXT)." >&2
  exit 1
fi

tmp_input="$(mktemp "${TMPDIR:-/tmp}/ghostty-shortcuts.XXXXXX.json")"
trap 'rm -f "$tmp_input"' EXIT INT TERM

# ${env_vars[@]+"${env_vars[@]}"} safely expands the array only when non-empty,
# avoiding the unbound variable error from set -u on older bash (e.g. macOS bash 3.2).
# Each element is passed as a distinct argv to Python, so values with spaces are handled correctly.
python3 - "$action" "$location" "$command_text" "$working_directory" "$target" "$text" "$submit" ${env_vars[@]+"${env_vars[@]}"} >"$tmp_input" <<'PY'
import json
import sys

action = sys.argv[1]
location = sys.argv[2]
command_text = sys.argv[3]
working_directory = sys.argv[4]
target = sys.argv[5]
text = sys.argv[6]
submit = bool(int(sys.argv[7]))
env_vars = sys.argv[8:]

payload = {"action": action}

if action == "new":
    payload["location"] = location
    if command_text:
        payload["command"] = command_text
    if working_directory:
        payload["workingDirectory"] = working_directory
    if env_vars:
        payload["env"] = env_vars
elif action == "focus":
    if target:
        payload["target"] = target
elif action == "input":
    payload["text"] = text
    payload["submit"] = submit
    if target:
        payload["target"] = target

print(json.dumps(payload))
PY

echo "Running Ghostty shortcut: $shortcut_name" >&2
shortcuts run "$shortcut_name" --input-path "$tmp_input"

