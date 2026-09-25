# ScaryPilot Agent Guide

## Project Structure & Module Organization

ScaryPilot is a GitHub Copilot plugin marketplace. Treat `.github/plugin/marketplace.json` as the published inventory when it differs from README tables. First-party plugins live in `plugins/<name>/`; adapted or external integrations live in `external_plugins/<name>/`.

Prefer the repository's declarative plugin patterns: skills in `skills/*/SKILL.md`, MCP configuration in `.mcp.json`, agents in `agents/*.md`, native extensions in `extensions/<name>/extension.mjs`, and optional `lsp.json`. MCP files use top-level server names, not an `mcpServers` envelope. A plugin exposing native extensions must list `extensions/` in `plugin.json`; each immediate child is a separate extension.

Plugin hook `matcher` values are regular expressions, not exact tool names. Anchor supported tool-name alternatives and test that unrelated tools with overlapping names do not match.

## Build, Test, and Development Commands

There is no root build or broad test suite.

- `npm run lint` runs the repository-wide Oxlint configuration, including the vendored anti-slop rules.
- `python3 -m json.tool .github/plugin/marketplace.json >/dev/null` validates marketplace edits.
- After editing an agentic workflow, run `gh aw compile --strict` without a workflow name. Targeted compilation can leave repository-level generated defaults, such as failure-issue expiry, inconsistent across lock files.
- After editing `external_plugins/pstack/` skills, metadata, provenance, or sync policy, run `node external_plugins/pstack/tools/pstack-sync.mjs check` and `node --test external_plugins/pstack/tools/pstack-sync.test.mjs`.
- In a changed extension package, run its `npm test` and typecheck scripts. For `ado-codespaces` and `copilot-local-llm`, also run `npm run lint` and `npm run format:check`.
- Native extensions ship checked-in `dist/` bundles. After changing extension source or build inputs, run `npm run build` in its extension package and commit `dist/` and `bundle-manifest.json`; run `node tools/check-extension-bundles.mjs check` to catch stale or unbundled runtime imports. The paired-review extension has its own bundle checks.
- For extension-defined factories, also verify registration and one successful worker run through a live extension host; package tests alone do not prove the host can resolve factory agents. Register restricted factory-only agents through the same `joinSession({ customAgents, factories })` call so execution does not depend on separate agent-discovery timing.
- For `plugins/azure-devops/extensions/paired-review`, run `npm run build`, `npm run typecheck`, `npm run typecheck:frontend`, `npm test`, `npm run smoke:bundle`, and `npm run check:bundle`; commit the generated `dist/`, `public/`, and `bundle-manifest.json` artifacts.
- For `plugins/copilot-autoresearch`, also run `bash plugins/copilot-autoresearch/skills/autoresearch-finalize/tests/finalize-smoke.sh`.
- npm 12 blocks URL dependencies by default. When an existing extension manifest fails with `EALLOWREMOTE`, install with `npm install --allow-remote=all --no-package-lock`; do not treat the security default as a missing-dependency blocker or change registry configuration.
- For skill trigger evals, run the skill-creator `scripts/run_eval.py` with `--num-workers 1`; higher concurrency can starve parallel `copilot` processes and report false failures.

## Coding Style, Versioning, and Naming

Each plugin needs a `README.md` covering purpose, prerequisites, installation, usage, and resources. Adding or removing a plugin requires matching updates to the marketplace manifest and root README. External or adapted plugins require attribution and license details.

Bump the affected plugin's `plugin.json` version for any change to shipped plugin behavior or bundled content so installed users can detect an update. Use SemVer: patch for fixes, minor for backward-compatible features, and major for breaking changes. Do not bump for repository-only docs, tests, or development tooling. When an extension package mirrors the plugin version, keep its `package.json` version synchronized; independent extension package versions need not match. Preserve upstream-derived version suffixes such as pstack's `-copilot.N`.

Bundled Node scripts must use explicit `.mjs` or `.cjs` extensions even though the root package declares ESM, so their module mode remains explicit when copied or invoked outside the root package. Prefer `.mjs`. Use `os.tmpdir()` instead of `/tmp`.

For extension I/O boundaries, prefer TypeBox schemas with `Static`-derived types and `Value.Check` or `Value.Parse`. Parse external payloads once into concrete domain types; do not add one-line type-guard wrappers merely to hide `typeof` checks.

## Testing and Safety

For Markdown or manifest-only changes, validate JSON, linked paths, and inventory consistency. Load the complete plugin environment before smoke-testing shell-dependent skills. Do not run side-effecting Azure DevOps, Git, Codespaces, Worktrunk, or terminal-automation commands without explicit user approval.

When building integrations that publish agent-authored text to external systems (chat messages, forum posts, comments, review replies, PR descriptions, or similar), add the visible suffix `- Generated with AI 🤖` at the write/payload boundary, not just in prompt guidance. Append it once at the end of the authored text; preserve the body and any required template structure. Keep retries idempotent, and test the exact submitted text. For integrations without a controlled write boundary, instruct agents to include the suffix when posting. Do not attribute third-party or user-authored text as agent-authored, and do not add text to non-text mutations.

Keep repository guidance here. Use scoped `.github/instructions/*.instructions.md` only for path-specific Copilot behavior, and keep `CLAUDE.md` exactly `@AGENTS.md`.
