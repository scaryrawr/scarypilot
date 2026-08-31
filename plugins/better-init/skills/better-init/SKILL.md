---
name: better-init
description: Create or modify repository guidance for GitHub Copilot CLI. Use when asked to initialize, bootstrap, refresh, reorganize, or generate AGENTS.md, Copilot instructions, path-specific instructions, project skills, or custom agents. Do not use for requests that only read or explain existing guidance.
---

# Better Init

Create the smallest durable set of repository guidance that helps Copilot work
correctly. Every line should answer: "Would an agent likely miss this without
help?" If not, leave it out.

## 1. Honor the requested scope

Apply any user-provided focus or constraints first. If the user names a package,
workflow, instruction type, or path, prioritize it.

Do not ask questions before inspecting the repository unless the request is
impossible to interpret. Improve existing `/init` output in place when present;
do not assume an uninitialized repository.

## 2. Investigate before writing

Read the highest-value sources first:

- Root manifests, workspace configuration, lockfiles, task runners, and
  toolchain configuration.
- Build, lint, formatter, typecheck, test, migration, and code-generation
  configuration.
- CI workflows, pre-commit configuration, and contributor documentation.
- Existing `AGENTS.md`, nested instruction files, `CLAUDE.md`, `GEMINI.md`,
  `.github/copilot-instructions.md`, and `.github/instructions`.
- Existing project skills under `.github/skills`, `.agents/skills`, or
  `.claude/skills`, and custom agents under `.github/agents`.
- Representative entrypoints and package boundaries when configuration and
  documentation do not make the architecture clear.

Prefer executable configuration over prose. When sources conflict, keep only
facts that can be verified and correct stale guidance rather than duplicating
it.

For a large monorepo or an unclear architecture, delegate repository-wide
discovery to the `repo-instruction-researcher` custom agent. Give it the user's
focus and ask for source paths. Continue directly for small repositories where
delegation would add overhead.

## 3. Extract only high-signal facts

Capture:

- Exact setup, development, build, lint, format, typecheck, test, migration,
  code-generation, and narrow validation commands.
- Required command order, working directories, services, environment loading,
  or expensive and flaky suites.
- Monorepo boundaries, ownership of major directories, real entrypoints, and
  generated-code boundaries.
- Repository-specific conventions that differ from ecosystem defaults.
- Safety, approval, release, or review constraints.
- Existing guidance worth preserving and reusable workflows that deserve
  on-demand instructions.

Do not add generic advice, restate obvious framework conventions, inventory
every directory, or encode speculative preferences.

## 4. Choose the correct instruction surface

Use each surface only for content it owns:

### `AGENTS.md`

Put portable repository facts here:

- Project structure and package boundaries.
- Exact developer and validation commands.
- Repository-specific conventions and safety constraints.
- A short inventory of important project skills when discoverability would
  otherwise be poor.

Prefer a root `AGENTS.md` for repository-wide guidance. Add nested `AGENTS.md`
files only at real subsystem boundaries where local commands or constraints
would clutter the root.

Keep the root guide concise, usually 200-400 words. Larger repositories may
need slightly more, but should link to deeper documentation rather than copying
it.

### `.github/copilot-instructions.md`

Put only Copilot-specific operating behavior here, such as tool-use policy,
Copilot workflow requirements, or instructions relying on Copilot features.

Do not copy `AGENTS.md` into this file or add `@AGENTS.md`; Copilot discovers
`AGENTS.md` independently. Omit this file when there is no meaningful
Copilot-only guidance.

### `.github/instructions/*.instructions.md`

Use path-specific instructions when guidance applies only to matching files.
Include `applyTo` frontmatter with the narrowest useful glob. Do not use these
files for repository-wide rules or create them merely to mirror directories.

### `.github/skills/<name>/SKILL.md`

Create a project skill for a repeatable multi-step workflow that is useful only
for certain tasks, such as repository setup verification, release preparation,
migrations, or creating a package.

Each skill must:

- Use a lowercase kebab-case directory and matching `name`.
- Have a specific description stating what it does and when to use it.
- Contain an actionable workflow rather than general guidance.
- Keep scripts in `scripts/`, detailed references in `references/`, and
  templates in `assets/`.
- Avoid duplicating an existing skill or normal agent behavior.

Prefer `.github/skills` for new Copilot-focused project skills. Preserve
existing `.agents/skills` or `.claude/skills` layouts unless migration is
explicitly requested.

### `.github/agents/<name>.agent.md`

Create a custom agent only when a specialist role benefits from an independent
context window, distinct tools, or repeatable delegation. Examples include a
framework-specific reviewer or a repository-specific release investigator.

Do not create an agent when a skill or concise instruction is sufficient.
Restrict its tools to the minimum needed and disable automatic model invocation
when it should only run deliberately.

### Compatibility files

Keep a root `CLAUDE.md` as exactly `@AGENTS.md` when that shim already exists or
the user requests it. Do not generate harness-specific duplicates by default.

## 5. Reconcile and write

Before editing:

1. Assign each verified fact to one owning surface.
2. Remove or consolidate duplicated and conflicting guidance.
3. Preserve useful user-authored constraints and unrelated content.
4. Plan the smallest set of file changes that satisfies the request.

Write direct, imperative guidance. Use headings for scanability, exact paths and
commands, and short explanations only where the reason changes behavior.

Do not create all supported file types as a showcase. It is valid for the
result to contain only `AGENTS.md`.

## 6. Validate the result

- Re-read every changed instruction, skill, and agent file.
- Confirm commands and paths against repository sources.
- Validate frontmatter and JSON with existing repository tooling when
  available.
- Ensure path-specific globs match their intended files.
- Ensure new skills and agents have unique, matching names and clear triggers.
- Check that no guidance is duplicated across surfaces without a specific
  reason.

Finish with a brief summary of files added, changed, or removed and the
responsibility of each.
