# pstack attribution and modifications

This plugin is adapted from
[pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan.
The adaptation originally imported upstream commit
`46125561306434d8a1d7745d540d8932ab0cd2a2` and had included the compatible
changes through upstream repository commit
`d0ef80d86795816da932a153458c5dbe192d294e` (pstack version `0.15.15`). The
last commit in that range that changes the `pstack/` subtree is
`df581122cde17e6e27686b5a448bde23e4ad4318`.

The reviewed range starts after
`2cbf58508f40de470d7490b55c51d71241928fa2`, the last upstream content commit
included by the previous Copilot adaptation. The machine-readable boundary,
ownership rules, and exclusions live in [`upstream-sync.json`](./upstream-sync.json).

The `make-bot-ui` feature remains excluded because it depends on Cursor-only
routines, secret-request cards, and UI behavior. Cursor's `automations/benny`
pack and marketplace logo are also excluded. The upstream
`disable-model-invocation` guard is not carried into Copilot because Copilot
filters guarded skills from its model-facing skill tool.

The original and adapted files are distributed under the MIT License in
[`LICENSE`](./LICENSE).

ScaryPilot changed the integration layer for GitHub Copilot:

- Converted Cursor model, subagent, and background-execution instructions to
  Copilot Task conventions.
- Moved generated project skills under `.github/` and pstack's user-level
  configuration into Copilot home.
- Replaced Cursor transcript paths with scoped Copilot session-history tools.
- Replaced dependencies on Cursor-only built-ins and companion plugins with
  Copilot-native tools or project verification skills.
- Added Copilot review-bot recognition to the PR watcher.
- Removed Cursor transcript scanning from the worktree audit.
- Ported upstream's verified multi-PR checklist and added a Copilot-compatible
  plan checker.
- Added a native Copilot extension with versioned projected status, capability
  reporting, structured verification receipts, durable handoffs, plan
  profiles, and read-only worktree inspection.
- Added versioned JSON contracts and trigger evals for Copilot-specific
  workflow surfaces.
- Bundled the `deslop` skill from
  [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit).
- Added an executable sync checker that validates upstream provenance,
  exclusions, inventory, links, extension registration, and model-callable
  skill metadata.
- Ported compatible `0.15.6`-`0.15.13` changes. Added `benchmark-checklist`,
  `principle-explain-the-number`, `correct`, and Copilot-adapted `poteto-help`
  with prompting and recipe references. Added agent-resistant architecture
  checks and schema-first cast examples. Updated performance playbooks,
  fresh-agent guidance, early PR snapshots, PR headings, and merge-prep
  base-freshness checks. Preserved Copilot's same-task agent messaging,
  read-only retry boundary, pinned swarm inputs, and final receipt audits.
  Model aliases omit `model` for the host's agent default instead of promising
  parent-model inheritance; rejected models no longer trigger guessed
  family substitutions or a separate configuration PR.
- Adapted hourly autopilot audits to available, approved Copilot scheduling
  tools instead of Cursor's `/loop 1h`. The shared plan rules accept hourly
  audits while retaining existing 30-minute plans. Rebuilt the native bundle
  so CLI and native artifact/plan validation use the same rules.
- Applied review corrections in `0.15.13-copilot.1`. Audit cadence must be on
  the audit-tick or status-message line outside code fences. Swarm dispatches
  and retries consistently omit model aliases. Trunk or intended-parent
  movement invalidates integration receipts even for disjoint paths and an
  unchanged patch-id; landing requires fresh CI and required live/perf proof
  on the combined new base and PR head. This deliberately strengthens
  upstream's path-overlap shortcut without changing the upstream boundary.
- Corrected Markdown fence parsing in `0.15.13-copilot.2`. The shared plan
  rules recognize backtick and tilde fences with up to three leading spaces,
  retain the opening delimiter and length until a valid closing fence, and
  keep fenced examples out of cadence and prose validation. Rebuilt the
  native bundle and expanded CLI and native regression coverage.
- Ported the `0.15.14`-`0.15.15` neutral wording for multi-model panels
  (`several` becomes `different` or `more than one`) in the guide,
  `/architect`, `/blast-radius`, and `/poteto-help`. Excluded the Sol removal,
  Opus `xhigh` default slugs, reasoning-budget defaults in `/setup-pstack`,
  and the Cursor model-rule prompt in `/poteto-help`, because Copilot's model
  roles omit `model` by default and its setup differs from Cursor's.
- Updated the guide for prompting, investigation, prototypes, plans,
  verification infrastructure, benchmark evidence, recurring corrections,
  and trust before unattended work. Excluded Cursor Custom Modes shortcuts,
  `/in-cloud`, Cursor Projects/runtime promises, and the Benny automation
  links. Help links target this Copilot adaptation, not Cursor-only docs.
  Kept technical-writing source attributions rather than carrying upstream's
  cosmetic removal of them.
- Ported the `0.15.5` model-rule resolution wording (missing configuration or
  role line omits `model`, `auto`/`inherit-parent` are aliases, rejected slugs
  fall back to the Task default), the retired-role cleanup in `/setup-pstack`,
  the autopilot owner's babysit and own-branch `--force-with-lease` rules, and
  the decision-log run/`start`-row and supersede-don't-edit audit rules. The
  Cursor model slugs, family-prefix fallbacks, and `swarm workers` lane model
  placeholder are not carried.
- Ported the `0.15.2`-`0.15.4` operator-neutral pronoun fix, the swarm skill's
  requirement that workers record verification SHAs and measurement methods
  with a one-retry rule for missing records and an explicit caller-side
  evidence check before accepting native workflow results, the autopilot
  playbooks' split between a code-ready verification round and a final
  merge-ready receipt audit, and the shipping playbook's noise-vs-signal
  patch-id diff check applied consistently across both autopilot modes.
  Excluded the
  accompanying Grok 4.7/Opus 5.5 model-slug renames, the reasoning-budget
  addition to `/setup-pstack`, and the Opus-5.5-tuned instruction trims,
  because Copilot's model catalog and defaults already differ from Cursor's
  and the trims assume a specific upstream model's behavior.
- Migrated the native swarm to Copilot SDK 1.0.16's dynamic workflow API and
  updated its tool instructions while preserving the v1 swarm contract.
- Added the read-only `pstack_validate_artifact` tool for snapshots, receipts,
  handoffs, and plans. Extracted shared JSON validation rules from the
  Copilot-owned schema-validation CLI and kept the existing shared plan rules.
  Preserved `pstack_validate_plan`, its callers, and the standalone validator's
  positional handling. Confined native reads use
  macOS all-component no-follow opens or Linux pinned directory descriptors.
  Unsupported platforms fail explicitly.
  Updated the Copilot-owned schema-validation skill to prefer the native tool
  with a CLI fallback.
  `contracts`, `extensions`, and `skills/pstack-schema-validate` remain
  Copilot-owned in `upstream-sync.json`.
- Removed the canonical Agent Plugins `$schema` selector from the Copilot
  manifest. Copilot's legacy format supports the existing native extension
  paths and root agent and skill fields. The canonical selector gives
  `extensions` a different namespace-based meaning.
- Added optional `inputFiles` pinning to the existing v1 read-only swarm.
  Journaled snapshots record canonical workspace identity and declared
  file-byte digests. Fresh confined reads reject drift before memoized
  workers or aggregate results can be returned. Legacy unpinned calls retain
  their coverage behavior without a freshness guarantee. This does not
  validate factual evidence or change Phase C acceptance.
  Extracted the existing native confined reader for reuse without adding
  runtime writes, subprocesses, or network access. The swarm skill changes
  are a Copilot adaptation of the upstream-derived skill. The native
  extension remains Copilot-owned.

The upstream guide is included with Copilot-specific installation, agent,
automation, path, and verification instructions. Cursor-only screenshots and
unsupported runtime promises are omitted.
