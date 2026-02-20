#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ghostty-applescript.sh <action> [options]

Run Ghostty automation via AppleScript/System Events.

Actions:
  new       Create a new context
  focus     Bring Ghostty to foreground
  input     Send input text to active terminal

Options:
  --location LOCATION        window|tab|split:right|split:down|split:left|split:up (new)
  --command COMMAND          Command to run after context creation (new)
  --working-directory PATH   cd into this directory first (new)
  --env KEY=VALUE            Environment variable export, repeatable (new)
  --target TARGET            Not supported in AppleScript fallback (focus/input)
  --text TEXT                Input text (input)
  --submit                   Press Enter after input text (input)
  -h, --help                 Show this help

Notes:
  - split:left and split:up are not supported by default fallback keybindings.
  - Targeted focus/input should use shortcuts/App Intents instead.
USAGE
}

normalize_location() {
  case "$1" in
    window|tab|split:right|split:down|split:left|split:up) printf '%s' "$1" ;;
    split-right) printf 'split:right' ;;
    split-down) printf 'split:down' ;;
    split-left) printf 'split:left' ;;
    split-up) printf 'split:up' ;;
    *)
      echo "Invalid location: $1" >&2
      return 1
      ;;
  esac
}

require_osascript() {
  if ! command -v osascript >/dev/null 2>&1; then
    echo "osascript is required for AppleScript fallback." >&2
    exit 1
  fi
}

require_ghostty() {
  if ! osascript -e 'id of application "Ghostty"' >/dev/null 2>&1; then
    echo "Ghostty app was not found. Install Ghostty before using this helper." >&2
    exit 1
  fi
}

send_input() {
  local value="$1"
  local submit="${2:-1}"

  # Values are passed as process arguments (osascript -), not interpolated into the
  # AppleScript source (heredoc uses <<'OSA'), so special characters are safe.
  osascript - "$value" "$submit" <<'OSA'
on run argv
  set inputText to item 1 of argv
  set submitFlag to item 2 of argv
  tell application "Ghostty" to activate
  delay 0.05
  tell application "System Events"
    keystroke inputText
    if submitFlag is "1" then
      key code 36
    end if
  end tell
end run
OSA
}

open_context() {
  local location="$1"

  # Location is passed as a process argument, not interpolated into AppleScript source.
  osascript - "$location" <<'OSA'
on run argv
  set locationValue to item 1 of argv
  tell application "Ghostty" to activate
  delay 0.1
  tell application "System Events"
    if locationValue is "window" then
      keystroke "n" using command down
    else if locationValue is "tab" then
      keystroke "t" using command down
    else if locationValue is "split:right" then
      keystroke "d" using command down
    else if locationValue is "split:down" then
      keystroke "d" using {command down, shift down}
    end if
  end tell
end run
OSA
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
env_vars=()

while [[ $# -gt 0 ]]; do
  case "$1" in
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

require_osascript
require_ghostty

case "$action" in
  new)
    if [[ "$location" == "split:left" || "$location" == "split:up" ]]; then
      echo "AppleScript fallback does not support $location; use shortcuts/App Intents for this location." >&2
      exit 1
    fi
    open -a Ghostty >/dev/null 2>&1 || true
    open_context "$location"
    sleep 0.1

    for env_var in "${env_vars[@]+"${env_vars[@]}"}"; do
      if [[ "$env_var" != *=* ]]; then
        echo "Invalid --env value (expected KEY=VALUE): $env_var" >&2
        exit 1
      fi
      env_key="${env_var%%=*}"
      env_value="${env_var#*=}"
      send_input "export ${env_key}=$(printf '%q' "$env_value")" 1
    done

    if [[ -n "$working_directory" ]]; then
      send_input "cd $(printf '%q' "$working_directory")" 1
    fi
    if [[ -n "$command_text" ]]; then
      send_input "$command_text" 1
    fi
    ;;
  focus)
    if [[ -n "$target" ]]; then
      echo "AppleScript fallback cannot reliably target specific Ghostty terminals; use shortcuts/App Intents." >&2
      exit 1
    fi
    osascript -e 'tell application "Ghostty" to activate'
    ;;
  input)
    if [[ -z "$text" ]]; then
      echo "--text is required for action 'input'" >&2
      exit 1
    fi
    if [[ -n "$target" ]]; then
      echo "AppleScript fallback cannot reliably target specific Ghostty terminals; use shortcuts/App Intents." >&2
      exit 1
    fi
    if [[ "$text" == *$'\n'* ]]; then
      echo "AppleScript fallback does not support multi-line --text; use shortcuts/App Intents." >&2
      exit 1
    fi
    send_input "$text" "$submit"
    ;;
  *)
    echo "Unknown action: $action" >&2
    usage
    exit 1
    ;;
esac

