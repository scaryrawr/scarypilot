---
name: Pstack upstream sync
emoji: 🥞
description: Review upstream pstack changes and port compatible updates to the Copilot adaptation.
intent: Keep the Copilot pstack adaptation aligned with applicable upstream improvements without importing Cursor-only behavior or creating duplicate maintenance work.
on:
  schedule:
    - cron: "0 9 * * 3"
      timezone: "America/New_York"
  workflow_dispatch:
  skip-if-match: 'is:pr is:open "gh-aw-workflow-id: pstack-sync" in:body'
permissions:
  contents: read
  copilot-requests: write
strict: true
timeout-minutes: 45
checkout:
  - fetch-depth: 0
  - repository: cursor/plugins
    path: upstream
    ref: main
    fetch-depth: 0
    sparse-checkout: |
      pstack/
tools:
  github:
    mode: gh-proxy
    toolsets: [repos]
    allowed-repos:
      - scaryrawr/scarypilot
      - cursor/plugins
    min-integrity: merged
network:
  allowed:
    - defaults
    - node
safe-outputs:
  create-pull-request:
    title-prefix: "[pstack sync] "
    branch-prefix: "agentic/pstack-sync/"
    draft: true
    max: 1
    if-no-changes: ignore
    fallback-as-issue: false
    protected-files: allowed
    allowed-files:
      - external_plugins/pstack/**
      - README.md
      - .github/plugin/marketplace.json
---

# Sync the Copilot pstack adaptation

Work in `${{ github.workspace }}`; treat
`${{ github.workspace }}/upstream/pstack` as read-only upstream source.

1. Read `AGENTS.md`, `external_plugins/pstack/README.md`,
   `external_plugins/pstack/NOTICE.md`, both relevant `package.json` files, and
   `external_plugins/pstack/plugin.json`.
2. Identify the upstream commit recorded in `NOTICE.md`. Verify it is an
   ancestor of the checked-out upstream `main`, then inspect the bounded commit
   range and diffs after it under upstream `pstack/`.
3. Classify each upstream change as compatible, adaptable, Cursor-only, already
   represented by a Copilot-native equivalent, or unsafe/ambiguous. This is a
   Copilot adaptation, not a mirror. Preserve the documented Copilot Task,
   session-history, extension, path, verification, and capability changes.
   Continue excluding Cursor-only models, commands, control skills, UI/runtime
   assumptions, marketplace metadata, and `automations/benny`.
4. Port only meaningful compatible behavior into
   `external_plugins/pstack/**`. Keep changes focused and avoid new
   dependencies unless an upstream change clearly requires one and it is safe
   for Copilot CLI.
5. Update `NOTICE.md` and parity wording in `README.md` when the accepted port
   changes the reviewed upstream boundary. For shipped plugin changes, bump
   `external_plugins/pstack/plugin.json` using the repository's SemVer and
   `-copilot.N` convention. Do not bump versions for repository-only
   documentation.
6. Run bounded validation appropriate to every changed area. At minimum,
   validate changed JSON. If the native extension changes, run `npm install
   --no-package-lock`, `npm run typecheck`, and `npm test` from
   `external_plugins/pstack/extensions/pstack`. If the poteto helper package
   changes and Bun is available, run its existing `typecheck` and `test`
   scripts. Do not add dependency lockfiles solely as a validation side effect.
7. Review the final diff. It must contain only the allowed pstack subtree and
   directly required root inventory/documentation updates, with no generated
   dependency artifacts or upstream checkout files.

Create exactly one draft pull request through the configured
`create-pull-request` safe output only after applicable changes pass validation.
The pull request body must identify the upstream commit range reviewed, explain
what was adapted or intentionally excluded, list validation commands and
results, and call out any residual uncertainty. Do not commit, push, or call a
GitHub mutation directly. Never merge the pull request.

Call `noop` with a short reason and make no visible write when the recorded
upstream boundary is already current, all newer changes are Cursor-only or
otherwise inapplicable, the same workflow already has an open pull request,
the baseline cannot be verified safely, the adaptation is ambiguous, or
relevant validation fails.
