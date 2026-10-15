#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, and remote/PR state. Emits a table sorted by size
# with a suggested bucket. Never
# deletes anything; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [-b|--base <ref>] [repo-path]
#   repo-path defaults to the current repo.
#   The MERGED base defaults to origin/HEAD, origin/main, origin/master, main,
#   then master, using existing local refs only. Pass --base when PRs target a
#   different branch. No fetch is performed; remote-tracking refs may be stale.
#   No transcripts are read, and no classification grants deletion permission.
set -u
export GIT_OPTIONAL_LOCKS=0

base=""
repo=""
while [ $# -gt 0 ]; do
	case "$1" in
	-b|--base)
		[ $# -ge 2 ] && [ -n "$2" ] && [[ "$2" != -* ]] \
			|| { echo "error: $1 needs a ref" >&2; exit 2; }
		base="$2"; shift 2 ;;
	-h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
	-*) echo "error: unknown option: $1" >&2; exit 2 ;;
	*)
		[ -z "$repo" ] || { echo "error: unexpected argument: $1" >&2; exit 2; }
		repo="$1"; shift ;;
	esac
done

repo="${repo:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not a git repo: $repo" >&2; exit 1; }

# Main worktree is the first entry; everything else is a candidate.
main_wt=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')

detected=no
if [ -z "$base" ]; then
	for cand in "$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)" refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master; do
		[ -n "$cand" ] && git rev-parse --verify --quiet "$cand^{commit}" >/dev/null \
			&& { base="$cand"; break; }
	done
	[ -n "$base" ] || {
		echo "error: no base ref (origin/HEAD, origin/main, origin/master, main, master all missing); pass --base <ref>" >&2
		exit 1
	}
	detected=yes
fi
base_commit=$(git rev-parse --verify --quiet "$base^{commit}" 2>/dev/null) \
	|| { echo "error: base ref not found: $base" >&2; exit 1; }
base="${base#refs/remotes/}"
base="${base#refs/heads/}"
[ "$detected" = no ] || echo "warn: no --base given; MERGED checks against $base (local refs only; may be stale)" >&2

# PR state by branch, read once. Empty if gh is unavailable. Keep it in memory
# so this read-only audit does not create or delete scratch files.
prs=$(
gh pr list --author "@me" --state all --limit 1000 \
	--json number,state,headRefName 2>/dev/null
) || prs="[]"

now=$(date +%s)

echo "# base: $base"
printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}' | while read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	# Squash-merged branches are not ancestors of the base, so PR state is the
	# real signal; merge-base only catches fast-forward/rebase merges.
	git merge-base --is-ancestor "$head" "$base_commit" 2>/dev/null && merged=YES || merged=no

	# Distinguish real WIP (tracked edits) from disposable untracked scratch.
	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
	if [ -z "$porcelain" ]; then dirty=clean
	elif printf '%s\n' "$porcelain" | grep -qv '^??'; then
		dirty="wip:$(printf '%s\n' "$porcelain" | grep -cv '^??')"
	else dirty="scratch:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	if [ -z "$branch" ]; then remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		[ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ] \
			&& remote=pushed \
			|| remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)"
	else remote=no-remote; fi

	pr=$([ -n "$branch" ] && printf '%s' "$prs" | jq -r --arg b "$branch" \
		'.[] | select(.headRefName==$b) | "#\(.number)/\(.state)"' 2>/dev/null | head -1)
	[ -z "$pr" ] && pr="-"

	case "$dirty" in wip:*) bucket=hold-wip ;; *)
		case "$pr" in *OPEN*) bucket=hold-open-pr ;; *)
			if [ "$merged" = YES ] || [ "$pr" != "-" ]; then bucket=safe
			else bucket=review; fi ;;
		esac ;;
	esac

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh
