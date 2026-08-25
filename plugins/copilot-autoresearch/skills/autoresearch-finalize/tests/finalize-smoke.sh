#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/autoresearch-finalize-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

cd "$ROOT"
git init -q -b main
git config user.name "Autoresearch Test"
git config user.email "autoresearch@example.invalid"

printf 'base-a\n' > a.txt
printf 'base-b\n' > b.txt
git add a.txt b.txt
git commit -q -m "base"
BASE="$(git rev-parse HEAD)"

git switch -q -c autoresearch/demo-20260825
printf 'faster-a\n' > a.txt
git commit -qam "optimize a"
FIRST="$(git rev-parse HEAD)"
printf 'faster-b\n' > b.txt
git commit -qam "optimize b"
FINAL="$(git rev-parse HEAD)"

mkdir -p .auto
printf 'preserve me\n' > dirty.txt
cat > .auto/finalize-groups.json <<JSON
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "demo",
  "groups": [
    {
      "title": "Optimize a",
      "body": "Experiment #1",
      "last_commit": "$FIRST",
      "slug": "optimize-a"
    },
    {
      "title": "Optimize b",
      "body": "Experiment #2",
      "last_commit": "$FINAL",
      "slug": "optimize-b"
    }
  ]
}
JSON

bash "$SCRIPT_DIR/finalize.sh" .auto/finalize-groups.json >/dev/null

test "$(git branch --show-current)" = "autoresearch/demo-20260825"
test "$(cat dirty.txt)" = "preserve me"
test -f .auto/finalize-groups.json
git show-ref --verify --quiet refs/heads/autoresearch/demo/01-optimize-a
git show-ref --verify --quiet refs/heads/autoresearch/demo/02-optimize-b
test "$(git diff --name-only main..autoresearch/demo/01-optimize-a)" = "a.txt"
test "$(git diff --name-only main..autoresearch/demo/02-optimize-b)" = "b.txt"
