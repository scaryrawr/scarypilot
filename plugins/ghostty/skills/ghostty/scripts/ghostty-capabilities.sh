#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ghostty-capabilities.sh

Detect local Ghostty automation capabilities and print shell assignments:
  HAS_GHOSTTY_APP
  HAS_SHORTCUTS_CLI
  HAS_OSASCRIPT
  HAS_SHORTCUT_NEW_TERMINAL
  HAS_SHORTCUT_FOCUS_TERMINAL
  HAS_SHORTCUT_INPUT_TEXT
  CAN_SHORTCUTS_NEW
  CAN_SHORTCUTS_FOCUS
  CAN_SHORTCUTS_INPUT
  CAN_APPLESCRIPT
USAGE
}

if [[ "${1-}" == "-h" || "${1-}" == "--help" ]]; then
  usage
  exit 0
fi

has_command() {
  command -v "$1" >/dev/null 2>&1
}

to_int() {
  if [[ "$1" == "true" ]]; then
    printf '1'
  else
    printf '0'
  fi
}

new_shortcut="${GHOSTTY_SHORTCUT_NEW_TERMINAL:-Ghostty New Terminal}"
focus_shortcut="${GHOSTTY_SHORTCUT_FOCUS_TERMINAL:-Ghostty Focus Terminal}"
input_shortcut="${GHOSTTY_SHORTCUT_INPUT_TEXT:-Ghostty Input Text}"

has_ghostty_app=false
if [[ -d "/Applications/Ghostty.app" ]]; then
  has_ghostty_app=true
elif has_command osascript && osascript -e 'id of application "Ghostty"' >/dev/null 2>&1; then
  has_ghostty_app=true
fi

has_shortcuts_cli=false
has_shortcut_new_terminal=false
has_shortcut_focus_terminal=false
has_shortcut_input_text=false

if has_command shortcuts; then
  has_shortcuts_cli=true
  shortcuts_list="$(shortcuts list 2>/dev/null || true)"

  if printf '%s\n' "$shortcuts_list" | grep -Fx -- "$new_shortcut" >/dev/null 2>&1; then
    has_shortcut_new_terminal=true
  fi
  if printf '%s\n' "$shortcuts_list" | grep -Fx -- "$focus_shortcut" >/dev/null 2>&1; then
    has_shortcut_focus_terminal=true
  fi
  if printf '%s\n' "$shortcuts_list" | grep -Fx -- "$input_shortcut" >/dev/null 2>&1; then
    has_shortcut_input_text=true
  fi
fi

has_osascript=false
if has_command osascript; then
  has_osascript=true
fi

can_shortcuts_new=false
can_shortcuts_focus=false
can_shortcuts_input=false
can_applescript=false

if [[ "$has_shortcuts_cli" == "true" && "$has_shortcut_new_terminal" == "true" ]]; then
  can_shortcuts_new=true
fi
if [[ "$has_shortcuts_cli" == "true" && "$has_shortcut_focus_terminal" == "true" ]]; then
  can_shortcuts_focus=true
fi
if [[ "$has_shortcuts_cli" == "true" && "$has_shortcut_input_text" == "true" ]]; then
  can_shortcuts_input=true
fi
if [[ "$has_osascript" == "true" && "$has_ghostty_app" == "true" ]]; then
  can_applescript=true
fi

cat <<EOF
HAS_GHOSTTY_APP=$(to_int "$has_ghostty_app")
HAS_SHORTCUTS_CLI=$(to_int "$has_shortcuts_cli")
HAS_OSASCRIPT=$(to_int "$has_osascript")
HAS_SHORTCUT_NEW_TERMINAL=$(to_int "$has_shortcut_new_terminal")
HAS_SHORTCUT_FOCUS_TERMINAL=$(to_int "$has_shortcut_focus_terminal")
HAS_SHORTCUT_INPUT_TEXT=$(to_int "$has_shortcut_input_text")
CAN_SHORTCUTS_NEW=$(to_int "$can_shortcuts_new")
CAN_SHORTCUTS_FOCUS=$(to_int "$can_shortcuts_focus")
CAN_SHORTCUTS_INPUT=$(to_int "$can_shortcuts_input")
CAN_APPLESCRIPT=$(to_int "$can_applescript")
EOF

