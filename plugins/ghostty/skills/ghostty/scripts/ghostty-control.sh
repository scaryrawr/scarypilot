#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ghostty-control.sh [--engine auto|shortcuts|applescript] <action> [options]

Wrapper that selects the best available Ghostty automation engine.

Examples:
  ghostty-control.sh new --location tab --command "npm run dev"
  ghostty-control.sh focus --target "server"
  ghostty-control.sh input --target "server" --text "npm test" --submit
USAGE
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

engine="auto"
forwarded_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine)
      engine="${2-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      forwarded_args+=("$1")
      shift
      ;;
  esac
done

if [[ "${#forwarded_args[@]}" -eq 0 ]]; then
  usage
  exit 1
fi

action="${forwarded_args[0]}"

case "$engine" in
  shortcuts)
    exec "$script_dir/ghostty-shortcuts.sh" "${forwarded_args[@]}"
    ;;
  applescript)
    exec "$script_dir/ghostty-applescript.sh" "${forwarded_args[@]}"
    ;;
  auto)
    ;;
  *)
    echo "Unknown engine: $engine" >&2
    usage
    exit 1
    ;;
esac

cap_output="$("$script_dir/ghostty-capabilities.sh")"
# Source via a temp file to avoid raw eval. Deleted immediately after sourcing so
# subsequent exec calls (which skip EXIT traps) don't leak the file.
cap_tmp_file="$(mktemp)"
trap 'rm -f "$cap_tmp_file"' EXIT
printf '%s\n' "$cap_output" >"$cap_tmp_file"
# shellcheck disable=SC1090
. "$cap_tmp_file"
rm -f "$cap_tmp_file"

use_shortcuts=0
case "$action" in
  new)
    if [[ "${CAN_SHORTCUTS_NEW:-0}" == "1" ]]; then
      use_shortcuts=1
    fi
    ;;
  focus)
    if [[ "${CAN_SHORTCUTS_FOCUS:-0}" == "1" ]]; then
      use_shortcuts=1
    fi
    ;;
  input)
    if [[ "${CAN_SHORTCUTS_INPUT:-0}" == "1" ]]; then
      use_shortcuts=1
    fi
    ;;
esac

if [[ "$use_shortcuts" == "1" ]]; then
  exec "$script_dir/ghostty-shortcuts.sh" "${forwarded_args[@]}"
fi

if [[ "${CAN_APPLESCRIPT:-0}" == "1" ]]; then
  exec "$script_dir/ghostty-applescript.sh" "${forwarded_args[@]}"
fi

echo "No available Ghostty automation engine for action '$action'." >&2
echo "Current capability snapshot:" >&2
"$script_dir/ghostty-capabilities.sh" >&2
exit 1

