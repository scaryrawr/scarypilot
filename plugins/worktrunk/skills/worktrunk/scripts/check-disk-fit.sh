#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: check-disk-fit.sh [-p repo-path] [-m safety-margin-bytes]

Run worktree footprint estimation and compare it to available disk space.
Outputs machine-readable key=value lines and exits non-zero when creation should be blocked.

Options:
  -p, --path                  repository path (default: .)
  -m, --safety-margin-bytes   safety margin in bytes (default: 1073741824)
  -h, --help                  show this help
USAGE
}

repo_path="."
safety_margin_bytes="${SAFETY_MARGIN_BYTES:-1073741824}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
estimate_script="$script_dir/estimate-worktree-footprint.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--path) repo_path="${2-}"; shift 2 ;;
    -m|--safety-margin-bytes) safety_margin_bytes="${2-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if ! [[ "$safety_margin_bytes" =~ ^[0-9]+$ ]]; then
  echo "safety-margin-bytes must be an integer number of bytes" >&2
  exit 1
fi

if [[ ! -x "$estimate_script" ]]; then
  echo "Missing executable estimator script: $estimate_script" >&2
  exit 1
fi

estimate_output=""
set +e
estimate_output="$("$estimate_script" -p "$repo_path")"
estimator_exit_code=$?
set -e

if (( estimator_exit_code != 0 )); then
  if [[ -n "$estimate_output" ]]; then
    printf '%s\n' "$estimate_output"
  fi
  printf 'estimator_exit_code=%s\n' "$estimator_exit_code"
  printf 'fits=false\n'
  exit "$estimator_exit_code"
fi

value_for_key() {
  local key="$1"
  printf '%s\n' "$estimate_output" | awk -F= -v k="$key" '$1==k {print substr($0, index($0, "=") + 1)}' | tail -n1
}

estimated_total_bytes="$(value_for_key "estimated_total_bytes")"
repo_root="$(value_for_key "repo_root")"

if ! [[ "$estimated_total_bytes" =~ ^[0-9]+$ ]]; then
  echo "Failed to parse estimated_total_bytes from estimator output" >&2
  exit 1
fi

if [[ -z "$repo_root" ]]; then
  echo "Failed to parse repo_root from estimator output" >&2
  exit 1
fi

free_kb="$(df -Pk "$repo_root" | awk 'NR==2 {print $4}')"
if ! [[ "$free_kb" =~ ^[0-9]+$ ]]; then
  echo "Failed to parse free space from df output" >&2
  exit 1
fi

free_bytes=$((free_kb * 1024))
required_bytes=$((estimated_total_bytes + safety_margin_bytes))

fits="false"
if (( required_bytes <= free_bytes )); then
  fits="true"
fi

printf '%s\n' "$estimate_output"
printf 'free_bytes=%s\n' "$free_bytes"
printf 'safety_margin_bytes=%s\n' "$safety_margin_bytes"
printf 'required_bytes=%s\n' "$required_bytes"
printf 'fits=%s\n' "$fits"

if [[ "$fits" != "true" ]]; then
  echo "Insufficient disk space for a new worktree (required=${required_bytes}, free=${free_bytes})" >&2
  exit 1
fi
