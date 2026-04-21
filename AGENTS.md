# ScaryPilot Agent Guide

## Repo purpose

ScaryPilot is a GitHub Copilot plugin marketplace. It hosts first-party plugins under `plugins/` and third-party MCP wrappers under `external_plugins/`.

## Repository map

- `plugins/<name>/`: first-party plugins. Today this includes `azure-devops`, `codespaces`, `copilot`, `ghostty`, `ollama`, and `worktrunk`.
- `external_plugins/<name>/`: external integrations. Today this includes `chrome-devtools`, `microsoft-docs`, and `playwright-ext`.
- `.github/plugin/marketplace.json`: source of truth for which plugins are published by the marketplace.
- Root TypeScript tooling only validates Azure DevOps helper scripts under `plugins/azure-devops/skills/**/*.mts`.

## Plugin patterns

Choose the lightest pattern that fits the capability:

- **Skills**: `plugins/*/skills/*/SKILL.md`
- **MCP wrappers**: `external_plugins/*/.mcp.json`
- **Agents**: `plugins/*/agents/*.md` or `external_plugins/*/agents/*.md`
- **LSP integrations**: `plugins/*/lsp.json`

Prefer Markdown and JSON configuration over adding new executable code.

## Authoring rules

- Every plugin directory must include a `README.md` with what it does, prerequisites, install steps, usage examples, and resource links.
- When authoring or updating skills, follow the Agent Skills specification: https://agentskills.io/specification
- If a skill needs bundled scripts, follow the Agent Skills scripts guidance: https://agentskills.io/skill-creation/using-scripts
- If you add or remove a plugin, update `.github/plugin/marketplace.json` to match the directory layout.
- Keep the root `README.md` aligned with the current plugin inventory and docs links when plugin availability changes.
- External or adapted plugins need clear attribution and license information.
- When repo guidance differs by area, add a nested `AGENTS.md` in that subtree instead of stuffing everything into the root file.

## Validation

- For Markdown, JSON, and manifest-only edits, prefer the smallest review needed and keep cross-file references in sync.
- For `.mts` helper-script edits, run from the repo root:
  - `npm install`
  - `npm run typecheck`
- Treat `package.json#engines.node` (`>=22.18.0`) as the runtime floor for shipped scripts.
- `@types/node` is pinned for editor and type-checking support only; do not treat it as permission to use newer runtime-only Node APIs.

## Safety and workflow notes

- Skills that depend on shell helpers must load or source the full plugin environment before smoke testing; partial setup is not a valid check.
- Keep shared guidance in `AGENTS.md`. Keep Copilot-only behavior in `.github/copilot-instructions.md`.
- If you add a `CLAUDE.md`, keep it as a thin compatibility shim whose entire contents are `@AGENTS.md`.
