# pstack for GitHub Copilot

This is a GitHub Copilot adaptation of
[pstack](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan's
workflow toolkit for writing less, higher-quality code through deliberate
planning, delegation, review, and verification.

## What this plugin provides

- 58 Agent Skills, including `poteto-mode`, `poteto-help`, `ketchup`,
  `in-your-own-words`, `sharpen`, `how`, `why`,
  `architect`, `arena`, `swarm`, `interrogate`, `correct`, `benchmark-checklist`,
  `tdd`, `deslop`, `unslop`, `create-formal-verification-skill`,
  `maintain-formal-verification-skill`, `statechart`, and 24 pstack principles.
- The `poteto-agent` and `comment-sicko` custom agents.
- Portable artifact and plan validation using deterministic contract rules and
  workspace-confined file reads.
- PR watching, orchestration, decision-log, and worktree-audit helpers used by
  advanced playbooks.
- Verified multi-phase planning with an executable checklist checker.
- Compatible upstream changes through pstack 0.15.30, with client-specific
  Cursor and Claude Code features intentionally excluded.
- User-level model configuration through `/setup-pstack`.

Start with [Use pstack for a focused task](./docs/guide/quick-start.md) for
copy/paste prompts, short follow-ups, and when extra agents are worth the cost.
The adapted [pstack guide](./docs/guide/README.md) walks through the workflow
from setup and code understanding through verification and long-running work.
Ask [`/poteto-help`](./skills/poteto-help/SKILL.md) when you need help choosing
a workflow. It answers the question without starting the suggested task.

## Prerequisites

- GitHub Copilot CLI with plugin and Agent Skills support.
- Git and GitHub CLI for GitHub and PR workflows.
- Bun only for the legacy `poteto-mode` PR watcher and orchestration CLIs.
- Node.js for the decision-log and validation helpers. Confined artifact
  validation requires macOS or Linux and fails explicitly on other platforms.
- For `/statechart` model checking only, Java 11 or later and `tla2tools.jar`
  configured through `JAVA` and `TLA2TOOLS`. Optional PNG rendering needs an
  already available Mermaid CLI and its browser runtime. It does not install
  missing packages. The bundled PNG launcher requires a POSIX `npx` executable;
  Windows users can keep Mermaid sources or use a separately approved renderer.
- GitHub CLI with the separately installed [`github/gh-stack`](https://github.com/github/gh-stack)
  extension for stacked-PR playbooks, using the public v0.2.1 JSON contract or
  a compatible release. Capability detection runs `gh stack --version`;
  pstack never installs the extension automatically.

The plugin has no native extension or SDK dependency. Core skills use the
current host's advertised tools; optional capabilities are not assumed.

On macOS, install Java for statechart with `brew install openjdk@21`. The
Homebrew Java path is `$(brew --prefix openjdk@21)/bin/java`; using that path
does not require system Java registration. Obtain `tla2tools.jar` from the
[official TLA+ releases](https://github.com/tlaplus/tlaplus/releases), with
approval, and set `TLA2TOOLS` to its absolute path. Homebrew's Toolbox cask is
the GUI, not a required CLI dependency. Do not substitute Node or Python
property-based tests for a TLC model-checking result.

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
/correct prevent the config mistakes agents keep repeating
/benchmark-checklist vet this speedup before it goes in the PR
/in-your-own-words play back the goal and problem before starting
/sharpen rewrite this diagnosis prompt deeper, not bigger
/ketchup catch me up on what changed since my last message
/create-formal-verification-skill the job lease and retry logic
/maintain-formal-verification-skill
/statechart show what the user sees when an upload retries
```

Use the full workflow style:

```text
/poteto-mode implement this feature and prove it works
```

### Upstream refresh in `2.2.0-copilot.1`

[`/statechart`](./skills/statechart/SKILL.md) turns a TLA+ model into Mermaid
charts with numbered bug paths. It can also turn an agreed chart into a TLA+
skeleton or compare a code model with an unchanged spec. Model findings need
real-code replay before they count as product bugs. Work stays in approved
scratch storage, and missing Java, TLC, or rendering tools are reported rather
than installed automatically.

The [focused-task guide](./docs/guide/quick-start.md) covers a smaller set of
entry points and follow-up phrases without requiring the full workflow catalog.

### Earlier refresh in `2.1.0-copilot.1`

The refresh adds formal-verification creation and maintenance skills.
[`/create-formal-verification-skill`](./skills/create-formal-verification-skill/SKILL.md)
chooses one costly, hard-to-test property, verifies it with suitable tooling,
and generates `.github/skills/verify-<area>/SKILL.md` for repeatable checks.
[`/maintain-formal-verification-skill`](./skills/maintain-formal-verification-skill/SKILL.md)
keeps those checks aligned with changed code and separates verification drift
from product bugs. Bounds, assumptions, mutation checks, and sync commits make
the result reviewable; a bounded model pass is not proof of the whole system.
Setup offers formal verification once when none exists, but does not start it
without acceptance.

`/sharpen` now returns a rewritten prompt instead of doing the underlying task.
It names the expert approach, raw material, methods, and outside check while
leaving your choices open. Send the rewrite when you want the work to start.
`/ketchup` lists every item waiting on you, with its recommendation, evidence,
and risk. It stays read-only and never drops items to meet a total word count.

### Migration from the native extension

`2.0.0-copilot.1` removes the Copilot-only extension, its seven tools, the
`/pstack` command, automatic handoff injection on resume, and the journaled
swarm workflow. This is an intentional breaking change, not a transparent
replacement of those services.

Skills, custom agents, contract schemas and useful scripts remain. Existing
receipts, handoffs and orchestration state are not deleted or rewritten.
Read a supplied handoff or scoped session history explicitly during pickup.
The pause playbook writes its existing Markdown resume note; orchestration uses
its existing Bun ledger. Neither recreates the removed native services.

Swarms use Task agents. Read-only instructions and before/after evidence do not
provide tool-level write prevention, journaled replay or pinned inputs. If a task
requires those guarantees and the current host cannot enforce them, report it
blocked. Writing workers still require isolated workspaces.

The `1.0.0-copilot.1` release changes the stack dependency and capability key to
`ghStack`. It no longer supports the previous stack backend. The reviewed
upstream content version remains recorded separately in `upstream-sync.json`.

The `1.1.0-copilot.1` release added `ketchup`, `in-your-own-words`, and `sharpen`, and refreshed
portable upstream content through `0.15.25`. Ketchup is a read-only catch-up,
using existing evidence and supported host visuals rather than launching apps.
Autopilot audits use it for meaningful updates and stay quiet when nothing
changed. The receiving chat runs poteto-mode; its custom agent is a delegate
that reads the parent's absolute skill path.

The PR watcher now reads all GitHub review-thread pages and treats the named
Code Review Gate's `ACTION_REQUIRED` state as a review gate, while ordinary
action-required checks remain failures. When GitHub blocks merging solely on
that owner-approval gate, the watcher reports an explicit approval blocker,
not failing CI or merge readiness. Genuine failures and rollup errors still
block CI. Legacy POSIX worktree auditing accepts
`--base <local-ref>` or detects the locally recorded default branch without
fetching. Inspection still never grants deletion permission.

`orch frontier set --repo <dir> [--prs <complete-bottom-to-top-pin>]` reads
`gh stack view --json`, checks every branch's identity and lifecycle with
`gh pr view`, and resolves local Git head SHAs. It preserves terminal PRs and
the existing frontier shape, including the singular branch stored in `branches`.
The first OPEN PR is the frontier, not proof of merge readiness. Acquisition can
refresh gh-stack's local cache but never installs, adopts, rewrites branches,
creates PRs, or merges. There is no cross-system transaction; failed acquisition
leaves the previous frontier intact, and a retry reacquires the complete result.
Run the Bun CLI through its absolute skill path as described in Poteto mode.

Stack adoption and publication require the user's relevant scope and approval.
Supported host PR-creation tools remain authoritative; `gh stack submit` is not
a bypass. Shipping is a separate approved operation over a contiguous verified
prefix through an explicit ceiling, not merge-when-ready. Released gh-stack
resolves numeric merge targets as stack numbers before PR numbers, so target
resolution must be proven before any merge. See the
[Shipping playbook](./skills/poteto-mode/playbooks/shipping.md).

### Validate a workspace artifact

Invoke [`/pstack-schema-validate`](./skills/pstack-schema-validate/SKILL.md), or
run its CLI from the approved workspace. Resolve the script from the installed
skill's absolute directory; do not change the working directory to the plugin.

```sh
node "<schema-skill>/scripts/validate.mjs" receipt receipt.json
node "<schema-skill>/scripts/validate.mjs" plan plan.md basic
```

Kinds are `snapshot`, `receipt`, `handoff`, and `plan`. Plans accept `basic` or
`verified-stack`, defaulting to `verified-stack`. The CLI reports all contract
findings and exits `0` for valid input, `1` for contract violations, and `2` for
invocation, access or parse errors. JSON contracts remain in
[`contracts/`](./contracts/). A valid contract is not proof that evidence is true,
fresh, or authorized.

The validator reads only the selected file inside its current workspace.
It rejects outside paths, traversal and symlink escapes; it does not follow
evidence paths or execute artifact contents. Confined reads require macOS or Linux.
macOS rejects symlinks throughout the canonical open path with `O_NOFOLLOW_ANY`.
Linux opens each path component through a pinned directory descriptor in
`/proc/self/fd`, with `O_NOFOLLOW`. A replaced ancestor symlink cannot redirect
the read. Other platforms raise an explicit unsupported-platform error.
There is no unconstrained fallback. The workspace root is the CLI's working
directory, so the caller must retain the approved root; the reader does not
sandbox the caller's other shell commands.

The standalone [`check-plan.mjs`](./skills/poteto-mode/scripts/check-plan.mjs)
keeps its existing human-readable checklist diagnostics. Both entrypoints share
the same pure plan rules.

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
uses its legacy manifest format with the existing root `agents` and `skills`
fields. It does not register an `extensions` directory.
See the [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#legacy-manifest-fields).

The upstream skills use the Agent Skills format, but their orchestration layer
assumes Cursor-specific model IDs, cloud-agent parameters, transcript paths,
commands, and companion plugins. This adaptation maps those assumptions to
Copilot Task agents, scoped session history, background completion
notifications, `.github/skills/`, and available browser, computer-use,
terminal, and project verification tools.

Host-controlled surfaces such as Task agents, dynamic workflows, session history,
browser automation, MCP tools, and App sidebar state remain conditional until
the host proves they are available.
The swarm skill uses Task agents directly and accepts evidence explicitly.
Artifact validation retains the shared
[`artifact-rules.mjs`](./skills/pstack-schema-validate/scripts/artifact-rules.mjs)
and plan rules without a native adapter. Orch, watch-pr, setup and recall keep
their existing portable interfaces.

Autopilot playbooks now use an hourly audit through an available, approved
host scheduling mechanism. They do not assume Cursor's `/loop` or a wake-up
after a session closes. The shared verified-stack plan validator accepts the
hourly cadence and existing 30-minute plans, so saved plans remain valid.
Cadence must appear on the audit-tick or status-message line in plan prose;
an unrelated hourly task or fenced example cannot satisfy it.
Backtick and tilde fences accept up to three leading spaces and stay in code
until a closing fence of the same type with at least the opening length.
Swarm worker dispatches and evidence retries share one resolved model choice,
omitting both aliases instead of sending them as slugs.
Before landing, any trunk or intended-parent movement requires fresh CI
and required live/perf evidence on the combined new base and PR head.
Disjoint paths and unchanged patch-id do not preserve stale integration receipts.

Cursor's `automations/benny` pack is not included because Copilot plugins do
not provide the Cursor Automations runtime. See [`NOTICE.md`](./NOTICE.md) for
the exact upstream revision and modification summary.

Cursor's `disable-model-invocation` skill metadata is also intentionally
removed. Copilot currently filters skills carrying that key from the
model-facing skill tool, which breaks direct invocation and skill-to-skill
orchestration.

Upstream's Claude Code adapter and generated harness tree are not shipped.
This package already maps tools, models, paths, and packaging directly to
Copilot, so a second client's adapter would conflict with those mappings.

## Maintaining the adaptation

The checked-in [`upstream-sync.json`](./upstream-sync.json) records the reviewed
upstream boundary, exclusions, Copilot-owned paths, and skill-accessibility
rules.

```sh
node external_plugins/pstack/tools/pstack-sync.mjs check
node external_plugins/pstack/tools/pstack-sync.mjs plan --upstream /path/to/cursor-plugins
node --test external_plugins/pstack/tools/pstack-sync.test.mjs external_plugins/pstack/tools/pstack-plan.test.mjs
node --test external_plugins/pstack/skills/pstack-schema-validate/tests/validation.test.mjs external_plugins/pstack/skills/pstack-schema-validate/tests/workspace-reader.test.mjs
node --test external_plugins/pstack/skills/statechart/scripts/test/statechart.test.mjs
```

On a POSIX host, also run
`node --test external_plugins/pstack/tools/worktree-audit.test.mjs` for the
POSIX shell helper. CI runs these regressions on macOS and Linux; portable
core checks also run on Windows, including explicit rejection of unsupported
confined reads.

`check` validates the shipped inventory, provenance, links, extension-free
packaging, and Copilot-compatible skill metadata. `plan` produces a bounded,
fail-closed classification of newer upstream changes.
The plan regressions exercise the shipped skeleton, saved legacy plans,
the CLI, and the portable artifact validator. Reader regressions exercise
outside/symlink rejection and ancestor-swap confinement on supported platforms.
No extension bundle, SDK install or live model worker is required.

The existing portable-helper workflow provisions Temurin Java 21 and the
official TLC `v1.8.0` jar on Linux and macOS. This is the official prerelease
used for this integration's model-checking coverage. The download is pinned
by version and SHA-256
`5bd7b64db99ae4c6c35f290de5e809c0ee41af43f8699cf696099ffb6452b1e2`.
CI sets `PSTACK_REQUIRE_TLC=1`, so a missing jar or unusable Java fails the
suite instead of silently skipping model checking. Windows runs the
dependency-free subset; POSIX process tests are not claimed as Windows coverage.

For the same required local check, set `TLA2TOOLS` and `JAVA` to approved local
installations and set `PSTACK_REQUIRE_TLC=1` in the host shell before running
the statechart test command. Without that flag, missing TLC produces explicit
skips so Java is not a global requirement for pstack. The suite also has
Linux-only filesystem and namespace checks. Missing platform facilities are
reported as skips. PNG tests use a fake renderer, not a real browser-rendering
check. A skipped model run is not proof that model checking works on that host.

## License and resources

- Original author: [Lauren Tan](https://github.com/poteto)
- Upstream source:
  [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)
- License: [MIT](./LICENSE)
- Adaptation notes: [NOTICE.md](./NOTICE.md)
