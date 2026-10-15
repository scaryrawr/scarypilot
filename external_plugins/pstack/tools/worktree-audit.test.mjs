import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const script = fileURLToPath(new URL("../skills/poteto-mode/scripts/worktree-audit.sh", import.meta.url));

const gitPath = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".pstack-audit "));
  directories.push(root);
  const repo = join(root, "repo with spaces");
  const worktree = join(root, "linked worktree");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);

  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Audit Test",
    GIT_AUTHOR_EMAIL: "audit@example.invalid",
    GIT_COMMITTER_NAME: "Audit Test",
    GIT_COMMITTER_EMAIL: "audit@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };

  // Do not inherit checkout/index overrides from the invoking Git process.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];

  const git = (...args) => {
    const result = spawnSync(gitPath, ["-C", repo, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    return result.stdout.trim();
  };

  git("init", "--quiet", "--initial-branch=integration");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  const initial = git("rev-parse", "HEAD");
  git("worktree", "add", "--quiet", "-b", "feature", worktree, initial);
  git("commit", "--quiet", "--allow-empty", "-m", "integration change");
  const head = git("rev-parse", "HEAD");
  const calls = join(root, "git-calls");
  const ghCalls = join(root, "gh-calls");
  writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AUDIT_GIT_CALLS"
case "$1" in
rev-parse|worktree|symbolic-ref|merge-base) ;;
-C)
  case "$3" in rev-parse|log|status|symbolic-ref|show-ref|rev-list) ;;
  *) echo "unexpected mutation" >&2; exit 99 ;;
  esac
  if [ "$3" = status ] && [ "\${GIT_OPTIONAL_LOCKS:-}" != 0 ]; then
    echo "unexpected mutation: optional index writes enabled" >&2; exit 99
  fi ;;
*) echo "unexpected mutation, including fetch" >&2; exit 99 ;;
esac
exec "$AUDIT_REAL_GIT" "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AUDIT_GH_CALLS"
printf '%s\\n' "\${AUDIT_PRS:-[]}"
`, { mode: 0o755 });

  return {
    repo, worktree, initial, head, git,
    audit(args = [], prs = "[]") {
      writeFileSync(calls, "");
      writeFileSync(ghCalls, "");
      const before = git("show-ref");

      const result = spawnSync("bash", [script, ...args, repo], {
        env: {
          ...env,
          PATH: `${bin}:${env.PATH}`,
          AUDIT_REAL_GIT: gitPath,
          AUDIT_GIT_CALLS: calls,
          AUDIT_GH_CALLS: ghCalls,
          AUDIT_PRS: prs,
        },
        encoding: "utf8",
      });

      assert.equal(git("show-ref"), before, "audit must not change refs");
      assert.ok(existsSync(worktree), "audit must not remove worktrees");
      assert.ok(!existsSync(join(repo, ".git", "FETCH_HEAD")), "audit must never fetch");
      assert.doesNotMatch(readFileSync(calls, "utf8"), /\b(fetch|pull|prune|remove|delete|reset|clean)\b/);
      assert.doesNotMatch(result.stderr, /unexpected mutation/);

      return { ...result, ghCalls: readFileSync(ghCalls, "utf8") };
    },
  };
}

function row(result) {
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.match(lines[1], /^SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tBUCKET\tWORKTREE$/);
  assert.equal(lines.length, 3);

  return lines[2].split("\t");
}

test("explicit --base and -b accept non-default refs and use their merge ancestry", () => {
  const f = fixture();
  f.git("update-ref", "refs/remotes/origin/release", f.head);

  for (const flag of ["--base", "-b"]) {
    const result = f.audit([flag, "origin/release"]);
    assert.match(result.stdout, /^# base: origin\/release\n/);
    assert.equal(row(result)[2], "YES");
    assert.equal(row(result)[7], f.worktree);
    assert.match(result.ghCalls, /^pr list --author @me --state all --limit 1000 --json number,state,headRefName\n$/);
  }

  f.git("update-ref", "refs/remotes/origin/release", f.initial);
  f.git("update-ref", "refs/heads/other", f.head);
  f.git("worktree", "add", "--quiet", join(f.repo, "..", "unmerged"), "other");
  const result = f.audit(["--base", "origin/release"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split("\n").some((line) => line.includes("\tno\t") && line.endsWith("/unmerged")));
});

test("detects a non-main origin/HEAD before origin/main", () => {
  const f = fixture();
  f.git("update-ref", "refs/remotes/origin/integration", f.head);
  f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/integration");
  f.git("update-ref", "refs/remotes/origin/main", f.initial);
  const result = f.audit();
  assert.match(result.stdout, /^# base: origin\/integration\n/);
  assert.match(result.stderr, /local refs only; may be stale/);
  assert.equal(row(result)[2], "YES");
});

for (const [ref, label] of [
  ["refs/remotes/origin/main", "origin/main"],
  ["refs/remotes/origin/master", "origin/master"],
  ["refs/heads/main", "main"],
  ["refs/heads/master", "master"],
]) {
  test(`falls back to existing ${label} without fetching`, () => {
    const f = fixture();
    f.git("update-ref", ref, f.head);
    f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
    const result = f.audit();
    assert.match(result.stdout, new RegExp(`^# base: ${label}\\n`));
    assert.equal(row(result)[2], "YES");
  });
}

test("prefers remote main to remote master and local fallbacks", () => {
  const f = fixture();

  for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]) {
    f.git("update-ref", ref, f.head);
  }

  assert.match(f.audit().stdout, /^# base: origin\/main\n/);
});

test("explicit base overrides detected origin/HEAD", () => {
  const f = fixture();
  f.git("update-ref", "refs/remotes/origin/main", f.head);
  f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  assert.match(f.audit(["--base", "integration"]).stdout, /^# base: integration\n/);
});

test("missing explicit or detected base fails before querying PRs or printing classifications", () => {
  const f = fixture();

  for (const args of [[], ["--base", "origin/not-fetched"]]) {
    const result = f.audit(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error: (no base ref|base ref not found)/);
    assert.equal(result.stdout, "");
    assert.equal(result.ghCalls, "");
  }
});

test("local fallback does not mistake a main tag for a branch", () => {
  const f = fixture();
  f.git("tag", "main");
  const result = f.audit();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no base ref/);
});

test("local fallback checks the branch commit even when a tag shadows its short name", () => {
  const f = fixture();
  f.git("update-ref", "refs/heads/main", f.head);
  f.git("tag", "main", f.initial);
  f.git("-C", f.worktree, "reset", "--hard", f.head);
  const result = f.audit();
  assert.match(result.stdout, /^# base: main\n/);
  assert.equal(row(result)[2], "YES");
  assert.doesNotMatch(result.stderr, /ambiguous/);
});

test("rejects missing base arguments and unknown options", () => {
  const f = fixture();

  // The fixture always appends the repository, so use an empty ref explicitly.
  for (const args of [["--base", ""], ["--base", "--invalid"], ["--invalid"]]) {
    const result = f.audit(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /error:/);
    assert.equal(result.stdout, "");
    assert.equal(result.ghCalls, "");
  }
});

test("preserves WIP and open-PR holds and never scans transcripts", () => {
  const f = fixture();
  f.git("update-ref", "refs/heads/main", f.head);
  const prs = '[{"number":42,"state":"OPEN","headRefName":"feature"}]';
  assert.deepEqual(row(f.audit([], prs)).slice(5, 7), ["#42/OPEN", "hold-open-pr"]);
  writeFileSync(join(f.worktree, "tracked"), "initial");
  f.git("-C", f.worktree, "add", "tracked");
  assert.equal(row(f.audit([], prs))[6], "hold-wip");
  const source = readFileSync(script, "utf8");
  assert.doesNotMatch(source, /agent-transcripts|\.cursor|\.copilot|mktemp|git fetch/);
});
