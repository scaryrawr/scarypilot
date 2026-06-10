# ScaryPilot Agent Guide

## Project Structure & Module Organization

ScaryPilot is a GitHub Copilot plugin marketplace. Published plugin inventory lives in `.github/plugin/marketplace.json`; trust that manifest over README tables when they differ. First-party plugins are under `plugins/<name>/` and external MCP wrappers under `external_plugins/<name>/`.

Main capability patterns are Markdown/JSON first: skills in `plugins/*/skills/*/SKILL.md`, MCP wrappers in `external_plugins/*/.mcp.json`, agents in `plugins/*/agents/*.md` or `external_plugins/*/agents/*.md`, and optional LSP integrations in `plugins/*/lsp.json`. Prefer these patterns over adding executable code.

When plugin hooks invoke scripts bundled with the plugin, reference them with `${PLUGIN_ROOT}` in hook configuration instead of repo-relative paths; hooks run in the user's target repository, not necessarily the plugin directory.

## Build, Test, and Development Commands

This repo has no app build or broad test suite. Root TypeScript tooling exists only for Azure DevOps helper scripts included by `tsconfig.json` (`plugins/azure-devops/skills/**/*.mts`).

- `npm install` — install the lightweight TypeScript tooling.
- `npm run typecheck` — run `tsgo -p tsconfig.json`; required after `.mts` helper edits.
- `python3 -m json.tool .github/plugin/marketplace.json >/dev/null` — quick JSON sanity check after manifest edits.

## Coding Style & Naming Conventions

Every plugin directory needs a `README.md` with purpose, prerequisites, install steps, usage examples, and resource links. When adding/removing plugins, update both `.github/plugin/marketplace.json` and root `README.md` links/inventory. External or adapted plugins need clear attribution and license information.

Skills must follow the Agent Skills spec; put bundled scripts in a skill-local `scripts/` directory and keep paths in `SKILL.md` accurate. Treat `package.json#engines.node` (`>=22.18.0`) as the runtime floor for shipped scripts; pinned `@types/node` is editor/type-checking support, not permission to use newer runtime-only APIs.

## Testing Guidelines

For Markdown, JSON, and manifest-only edits, prefer targeted review: validate JSON, verify linked paths exist, and cross-check plugin inventory. For Azure DevOps `.mts` helper work, also follow `plugins/azure-devops/skills/AGENTS.md`.

## Security & Configuration Tips

Skills that depend on shell helpers must load or source the full plugin environment before smoke testing; partial setup is not a valid check. Do not run side-effecting Azure DevOps, Git, Codespaces, Worktrunk, or terminal-automation commands unless the user explicitly requested or confirmed them.

## Agent-Specific Instructions

Keep shared guidance in `AGENTS.md`; put Copilot-only behavior in `.github/copilot-instructions.md` or scoped `.github/instructions/*.instructions.md`. Keep `CLAUDE.md` as exactly `@AGENTS.md`. `package.json#pi.skills` currently exposes only `plugins/copilot/skills` and `plugins/ollama/skills` for local pi discovery.
