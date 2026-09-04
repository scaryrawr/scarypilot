---
name: Autoresearch upstream sync
emoji: 🔬
description: Review pi-autoresearch changes and port compatible updates to the Copilot adaptation.
intent: Keep the Copilot autoresearch adaptation aligned with applicable upstream improvements without importing Pi-only behavior or creating duplicate maintenance work.
on:
  schedule:
    - cron: "0 9 * * 1,3"
      timezone: "America/New_York"
  workflow_dispatch:
  skip-if-match: 'is:pr is:open "gh-aw-workflow-id: autoresearch-sync" in:body'
  permissions:
    contents: read
    issues: read
    pull-requests: read
permissions:
  contents: read
  copilot-requests: write
strict: true
timeout-minutes: 45
checkout:
  - fetch-depth: 0
  - repository: davebcn87/pi-autoresearch
    path: upstream
    ref: main
    fetch-depth: 0
tools:
  github:
    mode: gh-proxy
    toolsets: [repos]
    allowed-repos:
      - scaryrawr/scarypilot
      - davebcn87/pi-autoresearch
    min-integrity: merged
network:
  allowed:
    - defaults
    - node
safe-outputs:
  create-pull-request:
    title-prefix: "[autoresearch sync] "
    branch-prefix: "agentic/autoresearch-sync/"
    draft: true
    max: 1
    if-no-changes: ignore
    fallback-as-issue: false
    protected-files: allowed
    allowed-files:
      - plugins/copilot-autoresearch/**
      - README.md
      - .github/plugin/marketplace.json
---

# Sync the Copilot autoresearch adaptation

Work in `${{ github.workspace }}`; treat
`${{ github.workspace }}/upstream` as read-only upstream source.

1. Read `AGENTS.md`, `plugins/copilot-autoresearch/README.md`,
   `plugins/copilot-autoresearch/NOTICE.md`,
   `plugins/copilot-autoresearch/plugin.json`, and
   `plugins/copilot-autoresearch/extensions/copilot-autoresearch/package.json`.
2. Identify the upstream parity commit recorded in `NOTICE.md`. Verify it is an
   ancestor of upstream `main`, then inspect the bounded commit range and diffs
   after it.
3. Classify each upstream change as compatible, adaptable, Pi-only,
   already represented by a Copilot-native equivalent, or unsafe/ambiguous.
   This is a Copilot CLI adaptation, not a mirror. Preserve the documented
   extension API constraints, slash-command UX, auto-resume behavior, loopback
   dashboard, `.auto/` contract, safety limits, hook contract, and finalization
   workflow. Do not add Pi-only keyboard bindings, terminal overlays,
   compaction hooks, private-feed artifacts, or upstream deployment/site files.
4. Port only meaningful compatible behavior into
   `plugins/copilot-autoresearch/**`. Keep the implementation focused and avoid
   unrelated dependencies.
5. Update attribution and parity metadata in `NOTICE.md` and `README.md` as
   appropriate. For shipped plugin changes, bump
   `plugins/copilot-autoresearch/plugin.json` and keep the mirrored extension
   `package.json` version synchronized. Do not bump versions for
   repository-only documentation.
6. Run the repository-documented validation from the Copilot adaptation:
   from `plugins/copilot-autoresearch/extensions/copilot-autoresearch`, run
   `npm install --no-package-lock`, `npm run typecheck`, and `npm test`; then
   run `bash ../../skills/autoresearch-finalize/tests/finalize-smoke.sh`.
   Validate changed JSON and do not add dependency lockfiles solely as a
   validation side effect.
7. Review the final diff. It must contain only the allowed autoresearch subtree
   and directly required root inventory/documentation updates, with no
   generated dependency artifacts or upstream checkout files.

Create exactly one draft pull request through the configured
`create-pull-request` safe output only after applicable changes pass validation.
The pull request body must identify the upstream commit range reviewed, explain
what was adapted or intentionally excluded, list validation commands and
results, and call out any residual uncertainty. Do not commit, push, or call a
GitHub mutation directly. Never merge the pull request.

Call `noop` with a short reason and make no visible write when the recorded
upstream boundary is already current, all newer changes are Pi-only or
otherwise inapplicable, the same workflow already has an open pull request,
the baseline cannot be verified safely, the adaptation is ambiguous, or
relevant validation fails.
