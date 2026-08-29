# ScaryPilot Agent Guide

## Project Structure & Module Organization

ScaryPilot is a GitHub Copilot plugin marketplace. Treat `.github/plugin/marketplace.json` as the published inventory when it differs from README tables. First-party plugins live in `plugins/<name>/`; adapted or external integrations live in `external_plugins/<name>/`.

Prefer the repository's declarative plugin patterns: skills in `skills/*/SKILL.md`, MCP configuration in `.mcp.json`, agents in `agents/*.md`, native extensions in `extensions/<name>/extension.mjs`, and optional `lsp.json`. MCP files use top-level server names, not an `mcpServers` envelope. A plugin exposing native extensions must list `extensions/` in `plugin.json`; each immediate child is a separate extension.

## Build, Test, and Development Commands

There is no root build or broad test suite.

- `python3 -m json.tool .github/plugin/marketplace.json >/dev/null` validates marketplace edits.
- In an extension package, run `npm test` and `npm run typecheck`; `copilot-local-llm` also provides `npm run lint` and `npm run format:check`.
- For skill trigger evals, run the skill-creator `scripts/run_eval.py` with `--num-workers 1`; higher concurrency can starve parallel `copilot` processes and report false failures.

## Coding Style, Versioning, and Naming

Each plugin needs a `README.md` covering purpose, prerequisites, installation, usage, and resources. Adding or removing a plugin requires matching updates to the marketplace manifest and root README. External or adapted plugins require attribution and license details.

Bump the affected plugin's `plugin.json` version for any change to shipped plugin behavior or bundled content so installed users can detect an update. Use SemVer: patch for fixes, minor for backward-compatible features, and major for breaking changes. Do not bump for repository-only docs, tests, or development tooling. When an extension package mirrors the plugin version, keep its `package.json` version synchronized; independent extension package versions need not match. Preserve upstream-derived version suffixes such as pstack's `-copilot.N`.

Bundled Node scripts must use explicit `.mjs` or `.cjs` extensions because the host repository's `package.json#type` is unknown. Prefer `.mjs`. Plugin hooks must reference bundled files through `${PLUGIN_ROOT}`. Use cross-platform `command` hooks when the invocation is identical on every OS, and use `os.tmpdir()` instead of `/tmp`.

## Testing and Safety

For Markdown or manifest-only changes, validate JSON, linked paths, and inventory consistency. Load the complete plugin environment before smoke-testing shell-dependent skills. Do not run side-effecting Azure DevOps, Git, Codespaces, Worktrunk, or terminal-automation commands without explicit user approval.

Keep repository guidance here. Use scoped `.github/instructions/*.instructions.md` only for path-specific Copilot behavior, and keep `CLAUDE.md` exactly `@AGENTS.md`.
