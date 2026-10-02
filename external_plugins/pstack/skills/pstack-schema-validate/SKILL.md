---
name: pstack-schema-validate
description: Validate pstack snapshots, verification receipts, durable handoffs, or Markdown plans against the plugin's versioned contracts. Use for "validate this pstack artifact", checking pstack JSON, or verifying a pstack plan profile. Not for general JSON schema validation.
---

# Validate pstack contracts

Use `pstack_validate_artifact` when the host exposes it. Pass the artifact's
`kind` and `path`. For `plan`, optionally pass `profile` as `basic` or
`verified-stack`. The default is `verified-stack`. Omit `profile` for JSON
artifacts.

The native tool reads one file inside the current workspace. Relative paths
resolve against the host's current working directory. Outside paths and
symlink escapes are rejected. Do not copy outside files into the workspace
to bypass this boundary.

Report every finding with its `path` or `line`, `rule`, and `message`.
Treat `ok: false` as a contract failure. Invalid arguments, unreadable files,
and malformed JSON are tool errors, not successful validation.

Keep using `pstack_validate_plan` for callers that need its existing
`plan_path` input and `{ ok, profile, findings, report }` output.

## CLI fallback

If the native tool is unavailable or reports an unsupported platform,
report that limit and resolve `scripts/validate.mjs` relative
to this skill directory. Read only an explicitly requested artifact inside
the approved workspace. The CLI uses the same contract rules but does not
enforce the native tool's workspace boundary.

The CLI preserves its legacy ignored third argument for JSON kinds.
Do not pass a profile for new JSON validation calls.

```sh
node scripts/validate.mjs snapshot <snapshot.json>
node scripts/validate.mjs receipt <receipt.json>
node scripts/validate.mjs handoff <handoff.json>
node scripts/validate.mjs plan <plan.md> [basic|verified-stack]
```

The command exits `0` on success, `1` for contract violations, and `2` for
invalid invocation or unreadable input. Report every finding with its path or
line number. Malformed JSON is an input error. Do not reinterpret a failed
contract as a warning.
