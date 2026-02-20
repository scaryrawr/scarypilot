#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: estimate-worktree-footprint.sh [-p repo-path]

Estimate bytes required for creating a new worktree plus dependencies/build outputs.
Outputs machine-readable key=value lines.

Options:
  -p, --path   repository path (default: .)
  -h, --help   show this help

Environment variable overrides (bytes):
  WORKTREE_METADATA_BYTES (default: 52428800)
  UNTRACKED_BUFFER_BYTES  (default: 104857600)
  NODE_DEPS_BYTES         (default: 943718400)
  NODE_BUILD_BYTES        (default: 314572800)
  PYTHON_DEPS_BYTES       (default: 524288000)
  PYTHON_BUILD_BYTES      (default: 157286400)
  GO_DEPS_BYTES           (default: 262144000)
  GO_BUILD_BYTES          (default: 314572800)
  FALLBACK_DEPS_BYTES     (default: 209715200)
  FALLBACK_BUILD_BYTES    (default: 157286400)
USAGE
}

repo_path="."

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--path) repo_path="${2-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "git not found in PATH" >&2
  exit 1
fi

repo_root="$(git -C "$repo_path" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "Could not resolve git repository from path: $repo_path" >&2
  exit 1
fi

file_size_bytes() {
  local target="$1"
  if stat -c%s "$target" >/dev/null 2>&1; then
    stat -c%s "$target"
    return
  fi
  stat -f%z "$target"
}

WORKTREE_METADATA_BYTES="${WORKTREE_METADATA_BYTES:-52428800}"
UNTRACKED_BUFFER_BYTES="${UNTRACKED_BUFFER_BYTES:-104857600}"
NODE_DEPS_BYTES="${NODE_DEPS_BYTES:-943718400}"
NODE_BUILD_BYTES="${NODE_BUILD_BYTES:-314572800}"
PYTHON_DEPS_BYTES="${PYTHON_DEPS_BYTES:-524288000}"
PYTHON_BUILD_BYTES="${PYTHON_BUILD_BYTES:-157286400}"
GO_DEPS_BYTES="${GO_DEPS_BYTES:-262144000}"
GO_BUILD_BYTES="${GO_BUILD_BYTES:-314572800}"
FALLBACK_DEPS_BYTES="${FALLBACK_DEPS_BYTES:-209715200}"
FALLBACK_BUILD_BYTES="${FALLBACK_BUILD_BYTES:-157286400}"

baseline_bytes=0
while IFS= read -r relpath; do
  [[ -z "$relpath" ]] && continue
  abs_path="$repo_root/$relpath"
  if [[ -f "$abs_path" ]]; then
    size="$(file_size_bytes "$abs_path" 2>/dev/null || echo 0)"
    baseline_bytes=$((baseline_bytes + size))
  fi
done < <(git -C "$repo_root" ls-files)

dependency_bytes=0
build_output_bytes=0
detected=()
assumptions=()

if [[ -f "$repo_root/package.json" ]]; then
  detected+=("node")
  dependency_bytes=$((dependency_bytes + NODE_DEPS_BYTES))
  build_output_bytes=$((build_output_bytes + NODE_BUILD_BYTES))
  assumptions+=("node:${NODE_DEPS_BYTES}:${NODE_BUILD_BYTES}")
fi

if [[ -f "$repo_root/pyproject.toml" || -f "$repo_root/requirements.txt" || -f "$repo_root/setup.py" || -f "$repo_root/Pipfile" || -f "$repo_root/poetry.lock" ]]; then
  detected+=("python")
  dependency_bytes=$((dependency_bytes + PYTHON_DEPS_BYTES))
  build_output_bytes=$((build_output_bytes + PYTHON_BUILD_BYTES))
  assumptions+=("python:${PYTHON_DEPS_BYTES}:${PYTHON_BUILD_BYTES}")
fi

if [[ -f "$repo_root/go.mod" ]]; then
  detected+=("go")
  dependency_bytes=$((dependency_bytes + GO_DEPS_BYTES))
  build_output_bytes=$((build_output_bytes + GO_BUILD_BYTES))
  assumptions+=("go:${GO_DEPS_BYTES}:${GO_BUILD_BYTES}")
fi

if [[ ${#detected[@]} -eq 0 ]]; then
  dependency_bytes=$((dependency_bytes + FALLBACK_DEPS_BYTES))
  build_output_bytes=$((build_output_bytes + FALLBACK_BUILD_BYTES))
  assumptions+=("fallback:${FALLBACK_DEPS_BYTES}:${FALLBACK_BUILD_BYTES}")
fi

detected_ecosystems="none"
if [[ ${#detected[@]} -gt 0 ]]; then
  detected_ecosystems="$(IFS=,; echo "${detected[*]}")"
fi

assumption_profile="$(IFS=,; echo "${assumptions[*]}")"

estimated_total_bytes=$((baseline_bytes + WORKTREE_METADATA_BYTES + UNTRACKED_BUFFER_BYTES + dependency_bytes + build_output_bytes))

printf 'repo_root=%s\n' "$repo_root"
printf 'baseline_bytes=%s\n' "$baseline_bytes"
printf 'worktree_metadata_bytes=%s\n' "$WORKTREE_METADATA_BYTES"
printf 'untracked_buffer_bytes=%s\n' "$UNTRACKED_BUFFER_BYTES"
printf 'dependency_bytes=%s\n' "$dependency_bytes"
printf 'build_output_bytes=%s\n' "$build_output_bytes"
printf 'estimated_total_bytes=%s\n' "$estimated_total_bytes"
printf 'detected_ecosystems=%s\n' "$detected_ecosystems"
printf 'assumption_profile=%s\n' "$assumption_profile"
