# pstack for GitHub Copilot

This is a GitHub Copilot adaptation of
[pstack](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan's
workflow toolkit for writing less, higher-quality code through deliberate
planning, delegation, review, and verification.

## What this plugin provides

- 48 Agent Skills, including `poteto-mode`, `how`, `why`, `architect`,
  `arena`, `swarm`, `interrogate`, `tdd`, `deslop`, `unslop`, and the pstack
  principles.
- The `poteto-agent` and `comment-sicko` custom agents.
- Native `pstack_status`, capability, artifact-validation, plan-validation, verification-receipt,
  handoff, and worktree-inspection tools plus the `/pstack` command.
- PR watching, orchestration, decision-log, and worktree-audit helpers used by
  advanced playbooks.
- Verified multi-phase planning with an executable checklist checker.
- Compatible upstream changes through pstack 0.15.5, with Cursor-only features
  intentionally excluded.
- User-level model configuration through `/setup-pstack`.

The adapted [pstack guide](./docs/guide/README.md) walks through the workflow
from setup and code understanding through verification and long-running work.

## Prerequisites

- GitHub Copilot CLI with plugin, Agent Skills, and native extension support.
- Git and GitHub CLI for GitHub and PR workflows.
- Bun only for the legacy `poteto-mode` PR watcher and orchestration CLIs.
- Graphite CLI only for playbooks that explicitly use stacked PRs.

The native extension and core skills need no extra runtime. Optional host
capabilities are reported as available, unavailable, or unknown instead of
being assumed.

## Installation

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install pstack@scarypilot
```

## Usage

Invoke a focused skill:

```text
/how explain how authentication flows through this repository
/architect design the boundary for this new cache
/interrogate stress-test this diff
/unslop tighten this PR description
```

Use the full workflow style:

```text
/poteto-mode implement this feature and prove it works
```

Inspect native state and capabilities:

```text
/pstack status
/pstack capabilities
/pstack resume
```

The status tool builds a versioned `PstackSnapshot` from existing orch,
watch-pr, handoff, and Git facts. It is a read-only projection, not another
state database. Verification receipts and handoffs are durable JSON artifacts
under the repository Git state directory. Their schemas live in
[`contracts/`](./contracts/).

Validate an explicitly requested workspace artifact with
`pstack_validate_artifact`. Its input is `{ kind, path, profile? }`.
`kind` is `snapshot`, `receipt`, `handoff`, or `plan`. Only plans accept
`profile`, either `basic` or `verified-stack`, defaulting to `verified-stack`.

JSON results contain `{ kind, path, schemaVersion: 1, ok, findings }`.
Each finding has `{ path, rule, message }`. Plan results contain
`{ kind, path, profile, ok, findings, report }`. Each plan finding has
`{ line, rule, message }`. Contract violations return `ok: false`.
Invalid arguments, unreadable paths, and malformed JSON raise tool errors.
The result's `path` is the canonical absolute file path. The TypeScript
input and output contracts are exported from the
[native tool module](./extensions/pstack/src/tools/validate-artifact.ts).

The tool reads only the selected file inside the current workspace.
It rejects outside paths and symlink escapes, and never reads evidence paths
or runs commands. Native confined reads require macOS or Linux.
macOS rejects symlinks throughout the canonical open path with `O_NOFOLLOW_ANY`.
Linux opens each path component through a pinned directory descriptor in
`/proc/self/fd`, with `O_NOFOLLOW`. A replaced ancestor symlink cannot redirect
the read. Other platforms raise an explicit unsupported-platform error.
Validation checks artifact shape, not the truth of recorded
verification claims, snapshot hashes, or permission to perform later actions.
`pstack_validate_plan` retains its existing `plan_path` input, defaults,
output, and path behavior.

The [schema-validation skill](./skills/pstack-schema-validate/SKILL.md)
routes to the native tool and provides a CLI fallback using the same pure
validation rules. The standalone CLI does not enforce workspace confinement.
It preserves legacy positional handling, including an ignored optional third
argument for JSON kinds. Native JSON inputs reject `profile`.

Configure Task models across Copilot projects:

```text
/setup-pstack
```

The setup skill writes `instructions/pstack-models.instructions.md` in
`$COPILOT_HOME`, defaulting to `$HOME/.copilot`. Copilot loads this user
instruction across repositories. Without it, pstack lets Copilot select each
Task agent's default model.

## Copilot adaptation

The manifest omits the canonical Agent Plugins `$schema` selector so Copilot
uses its legacy manifest format. This preserves the native `extensions`
directory paths and the existing root `agents` and `skills` fields.
With the canonical selector, `extensions` instead contains client namespaces.
See the [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#legacy-manifest-fields).

The upstream skills use the Agent Skills format, but their orchestration layer
assumes Cursor-specific model IDs, cloud-agent parameters, transcript paths,
commands, and companion plugins. This adaptation maps those assumptions to
Copilot Task agents, scoped session history, background completion
notifications, `.github/skills/`, and available browser, computer-use,
terminal, and project verification tools.

The native extension centralizes capability detection, deterministic state
access, and the experimental read-only `pstack-swarm` workflow. The extension
registers a non-invocable workflow worker limited to read and search tools. The
`swarm` skill keeps its existing Task-agent flow as a compatibility fallback
and for all writing work, where separate worktrees remain mandatory.
Host-controlled surfaces such as Task agents, dynamic workflows, session history,
browser automation, MCP tools, and App sidebar state remain conditional until
the host proves they are available.

Read-only swarms use `run_dynamic_workflow` and `dynamic_workflows_manage`.
The host must expose these experimental tools; a CLI version alone does not
guarantee they are enabled.
The extension targets SDK 1.0.16 and registers its worker and workflow together
through `joinSession({ customAgents, workflows })`. The workflow name and
legacy v1 arguments and results remain supported.

The optional v1 `inputFiles` manifest pins 1-128 explicitly declared workspace
files. For example, add `"inputFiles": ["src/api.ts", "tests/api.test.ts"]`
to the swarm arguments. Missing files, directories, symlinks, outside paths,
URLs, traversal, and duplicate canonical targets raise workflow errors before
worker admission. Pinned reads use the same native confined reader as artifact
validation and require macOS or Linux.

Pinned results add `pinnedInputSnapshot` with `schemaVersion: 1`,
`workspace: { root, dev, ino }`, and
`files: [{ path, sha256 }]` in manifest order. `root` and `path` are canonical
absolute paths. Directory device and inode identifiers are decimal strings.
Digests cover exact file bytes, not decoded text. Pinning hashes through
bounded 64 KiB reads and checks cancellation between reads instead of
buffering whole files. Raw worker reports may include extra metadata;
normalization retains only status, summary, and evidence. Journaled
snapshots and normalized aggregate results remain strict.
The first attempt journals
that snapshot. Fresh reads outside the journal precede worker admission,
aggregation, and result return, including on resume. Drift in workspace
identity, canonical paths, or declared bytes raises an error rather than
returning memoized results. Unchanged inputs allow existing workers and
aggregate results to replay. Changed inputs require a new run.

This guarantee covers only declared file bytes and workspace identity at
workflow boundaries. It does not cover the whole repository, undeclared
reads, or a transient edit restored between checks. It does not provide
immutable worker inputs. Legacy runs without a manifest have no freshness
guarantee. Neither a recorded SHA, digest, path, evidence string, nor a
`PASS` proves truth. `ISSUES` still counts as completed coverage, and empty
evidence still needs caller review. The swarm skill's Phase C remains the
evidence-acceptance boundary.

Artifact validation is a separate read-only increment. The CLI and native
tool share [`artifact-rules.mjs`](./skills/pstack-schema-validate/scripts/artifact-rules.mjs)
and the existing plan rules. The adaptation keeps orch, watch-pr, setup, and
recall unchanged.

Cursor's `automations/benny` pack is not included because Copilot plugins do
not provide the Cursor Automations runtime. See [`NOTICE.md`](./NOTICE.md) for
the exact upstream revision and modification summary.

Cursor's `disable-model-invocation` skill metadata is also intentionally
removed. Copilot currently filters skills carrying that key from the
model-facing skill tool, which breaks direct invocation and skill-to-skill
orchestration.

## Maintaining the adaptation

The checked-in [`upstream-sync.json`](./upstream-sync.json) records the reviewed
upstream boundary, exclusions, Copilot-owned paths, and skill-accessibility
rules.

```sh
node external_plugins/pstack/tools/pstack-sync.mjs check
node external_plugins/pstack/tools/pstack-sync.mjs plan --upstream /path/to/cursor-plugins
```

`check` validates the shipped inventory, provenance, links, extension
registration, and Copilot-compatible skill metadata. `plan` produces a bounded,
fail-closed classification of newer upstream changes.

When changing the native extension, install dependencies in
`external_plugins/pstack/extensions/pstack`, run `npm run build`, and commit its
generated `dist/` and `bundle-manifest.json`. Installed plugins use the bundle
without an npm install; Copilot supplies the SDK at runtime.

## License and resources

- Original author: [Lauren Tan](https://github.com/poteto)
- Upstream source:
  [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)
- License: [MIT](./LICENSE)
- Adaptation notes: [NOTICE.md](./NOTICE.md)
