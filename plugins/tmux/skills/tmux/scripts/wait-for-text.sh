#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh -t target -p pattern [options]

Poll a tmux pane for text and exit when found.

Options:
  -t, --target    tmux target (session:window.pane), required
  -p, --pattern   regex pattern to look for, required
  -S, --socket    tmux socket path (passed to tmux -S)
  -F, --fixed     treat pattern as a fixed string (grep -F)
  -T, --timeout   seconds to wait (integer, default: 15)
  -i, --interval  poll interval in seconds (default: 0.5)
  -l, --lines     number of history lines to inspect (integer, default: 1000)
  -h, --help      show this help
USAGE
}

target=""
pattern=""
socket=""
grep_flag="-E"
timeout=15
interval=0.5
lines=1000

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target)   [[ $# -lt 2 ]] && { echo "Option '$1' requires an argument" >&2; usage; exit 1; }; target="$2"; shift 2 ;;
    -p|--pattern)  [[ $# -lt 2 ]] && { echo "Option '$1' requires an argument" >&2; usage; exit 1; }; pattern="$2"; shift 2 ;;
    -S|--socket)   [[ $# -lt 2 ]] && { echo "Option '$1' requires an argument" >&2; usage; exit 1; }; socket="$2"; shift 2 ;;
    -F|--fixed)    grep_flag="-F"; shift ;;
    -T|--timeout)  [[ $# -lt 2 ]] && { echo "Option '$1' requires an argument" >&2; usage; exit 1; }; timeout="$2"; shift 2 ;;
    -i|--interval) [[ $# -lt 2 ]] && { echo "Option '$1' requires an argument" >&2; usage; exit 1; }; interval="$2"; shift 2 ;;
    -l|--lines)    [[ $# -lt 2 ]] && { echo "Option '$1' requires an argument" >&2; usage; exit 1; }; lines="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$target" || -z "$pattern" ]]; then
  echo "target and pattern are required" >&2
  usage
  exit 1
fi

if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "timeout must be an integer number of seconds" >&2
  exit 1
fi

if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
  echo "lines must be an integer" >&2
  exit 1
fi

if ! [[ "$interval" =~ ^[0-9]*\.?[0-9]+$ ]]; then
  echo "interval must be a positive number (e.g., 0.5, 1)" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

# Build base tmux command with optional private socket
tmux_base=(tmux)
if [[ -n "$socket" ]]; then
  tmux_base=(tmux -S "$socket")
fi

# End time in epoch seconds (integer, good enough for polling)
start_epoch=$(date +%s)
deadline=$((start_epoch + timeout))

_cap_err_file="$(mktemp "${TMPDIR:-/tmp}/wft_err.XXXXXX")"
trap 'rm -f "$_cap_err_file"' EXIT

_cap_fail_count=0

while true; do
  if ! pane_text="$("${tmux_base[@]}" capture-pane -p -J -t "$target" -S "-${lines}" 2>"$_cap_err_file")"; then
    _cap_fail_count=$((_cap_fail_count + 1))
    if [[ $_cap_fail_count -ge 3 ]]; then
      echo "tmux capture-pane failed ${_cap_fail_count} times for target '$target':" >&2
      cat "$_cap_err_file" >&2
      exit 1
    fi
    pane_text=""
  else
    _cap_fail_count=0
  fi

  _grep_rc=0
  printf '%s\n' "$pane_text" | grep $grep_flag -- "$pattern" >/dev/null 2>&1 || _grep_rc=$?
  if [[ $_grep_rc -eq 2 ]]; then
    echo "Invalid pattern: $pattern" >&2
    exit 2
  fi
  if [[ $_grep_rc -eq 0 ]]; then
    exit 0
  fi

  now=$(date +%s)
  if (( now >= deadline )); then
    echo "Timed out after ${timeout}s waiting for pattern: $pattern" >&2
    if [[ -s "$_cap_err_file" ]]; then
      echo "tmux error:" >&2
      cat "$_cap_err_file" >&2
    fi
    echo "Last ${lines} lines from $target:" >&2
    printf '%s\n' "$pane_text" >&2
    exit 1
  fi

  sleep "$interval"
done
