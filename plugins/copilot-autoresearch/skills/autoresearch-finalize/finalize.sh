#!/usr/bin/env bash
set -euo pipefail

GROUPS_FILE="${1:-}"
if [[ -z "$GROUPS_FILE" || ! -f "$GROUPS_FILE" ]]; then
  echo "usage: $0 /path/to/groups.json" >&2
  exit 2
fi
GROUPS_FILE="$(cd "$(dirname "$GROUPS_FILE")" && pwd)/$(basename "$GROUPS_FILE")"

command -v git >/dev/null || { echo "git is required" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required" >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  { echo "run from inside the autoresearch repository" >&2; exit 2; }

ORIGINAL_REF="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ -z "$ORIGINAL_REF" ]]; then
  echo "cannot finalize from detached HEAD" >&2
  exit 2
fi

json_get() {
  node -e '
    const value = process.argv.slice(2).reduce((v, key) => v?.[key], require(process.argv[1]));
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(String(value));
  ' "$GROUPS_FILE" "$@"
}

BASE="$(json_get base)"
TRUNK="$(json_get trunk)"
FINAL_TREE="$(json_get final_tree)"
GOAL="$(json_get goal)"
GROUP_COUNT="$(json_get groups length)"

if [[ "$ORIGINAL_REF" == "$TRUNK" ]]; then
  echo "refusing to finalize while checked out on trunk '$TRUNK'" >&2
  exit 2
fi
if [[ "$GROUP_COUNT" -lt 1 ]]; then
  echo "groups.json must contain at least one group" >&2
  exit 2
fi

git cat-file -e "${BASE}^{commit}"
git cat-file -e "${FINAL_TREE}^{commit}"
git merge-base --is-ancestor "$BASE" "$FINAL_TREE" ||
  { echo "base is not an ancestor of final_tree" >&2; exit 2; }

declare -a BRANCHES=()
declare -a RANGES=()
VERIFY_DIR=""
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autoresearch-finalize.XXXXXX")"
OWNERS_FILE="$TEMP_DIR/owners"
: > "$OWNERS_FILE"
trap '[[ ${BASH_SUBSHELL:-0} -gt 0 ]] || rm -rf "$TEMP_DIR"' EXIT

is_session_file() {
  case "/$1/" in
    */.auto/*|*/autoresearch.*/*) return 0 ;;
    *) return 1 ;;
  esac
}
PREVIOUS="$BASE"

for ((index = 0; index < GROUP_COUNT; index++)); do
  LAST="$(json_get groups "$index" last_commit)"
  SLUG="$(json_get groups "$index" slug)"
  json_get groups "$index" title > "$TEMP_DIR/$index.title"
  json_get groups "$index" body > "$TEMP_DIR/$index.body"
  git cat-file -e "${LAST}^{commit}"
  git merge-base --is-ancestor "$PREVIOUS" "$LAST" ||
    { echo "group $((index + 1)) is not ordered after the prior group" >&2; exit 2; }
  git merge-base --is-ancestor "$LAST" "$FINAL_TREE" ||
    { echo "group $((index + 1)) is not contained in final_tree" >&2; exit 2; }

  BRANCH="autoresearch/${GOAL}/$(printf '%02d' "$((index + 1))")-${SLUG}"
  git check-ref-format --branch "$BRANCH" >/dev/null
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "branch already exists: $BRANCH" >&2
    exit 2
  fi

  : > "$TEMP_DIR/$index.files"
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    is_session_file "$file" && continue
    if grep -Fqx "$file" "$OWNERS_FILE"; then
      echo "groups overlap on '$file'" >&2
      exit 2
    fi
    printf '%s\n' "$file" >> "$OWNERS_FILE"
    printf '%s\n' "$file" >> "$TEMP_DIR/$index.files"
  done < <(git diff --name-only "$PREVIOUS" "$LAST")
  if [[ ! -s "$TEMP_DIR/$index.files" ]]; then
    echo "group $((index + 1)) has no non-session changes" >&2
    exit 2
  fi

  BRANCHES+=("$BRANCH")
  RANGES+=("$PREVIOUS..$LAST")
  PREVIOUS="$LAST"
done

STASHED=0
if [[ -n "$(git status --porcelain)" ]]; then
  git stash push --include-untracked -m "autoresearch-finalize temporary stash" >/dev/null
  STASHED=1
fi

restore_original() {
  if ! git switch "$ORIGINAL_REF" >/dev/null; then
    echo "failed to restore original branch '$ORIGINAL_REF'" >&2
    return 1
  fi
  if [[ "$STASHED" -eq 1 ]]; then
    if ! git stash pop >/dev/null; then
      echo "failed to restore stashed changes; recover them with: git stash list && git stash pop" >&2
      return 1
    fi
  fi
}

cleanup_verify_worktree() {
  [[ -n "$VERIFY_DIR" ]] || return 0
  git worktree remove --force "$VERIFY_DIR" >/dev/null 2>&1 ||
    rmdir "$VERIFY_DIR" >/dev/null 2>&1 ||
    true
  VERIFY_DIR=""
}

rollback() {
  local status=$?
  trap - ERR INT TERM
  cleanup_verify_worktree
  restore_original || true
  for branch in "${BRANCHES[@]}"; do
    git branch -D "$branch" >/dev/null 2>&1 || true
  done
  exit "$status"
}
trap rollback ERR INT TERM

for ((index = 0; index < GROUP_COUNT; index++)); do
  BRANCH="${BRANCHES[$index]}"
  RANGE="${RANGES[$index]}"
  TITLE="$(cat "$TEMP_DIR/$index.title")"
  BODY="$(cat "$TEMP_DIR/$index.body")"
  FILES=()
  while IFS= read -r file; do
    [[ -n "$file" ]] && FILES+=("$file")
  done < "$TEMP_DIR/$index.files"

  git switch --detach "$BASE" >/dev/null
  git switch -c "$BRANCH" >/dev/null
  git diff --binary "$RANGE" -- "${FILES[@]}" | git apply --index
  if git diff --cached --quiet; then
    echo "group $((index + 1)) has no changes" >&2
    false
  fi
  git commit -m "$TITLE" -m "$BODY" >/dev/null
done

VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autoresearch-finalize.XXXXXX")"
git worktree add --detach "$VERIFY_DIR" "$BASE" >/dev/null
for branch in "${BRANCHES[@]}"; do
  git -C "$VERIFY_DIR" cherry-pick "$branch" >/dev/null
done

DIFFERS=0
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if ! is_session_file "$file"; then
    DIFFERS=1
    break
  fi
done < <(git -C "$VERIFY_DIR" diff --name-only "$FINAL_TREE")
if [[ "$DIFFERS" -eq 1 ]]; then
  cleanup_verify_worktree
  if ! restore_original; then
    trap - ERR INT TERM
    exit 1
  fi
  trap - ERR INT TERM
  echo "verification failed: grouped branches do not reproduce final_tree" >&2
  echo "branches were left intact for inspection:" >&2
  printf '  %s\n' "${BRANCHES[@]}" >&2
  exit 1
fi

cleanup_verify_worktree
restore_original
trap - ERR INT TERM

echo "Created independent branches from $BASE:"
printf '  %s\n' "${BRANCHES[@]}"
echo
echo "Cleanup:"
printf "  git branch -D %q\n" "${BRANCHES[@]}"
