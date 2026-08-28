---
name: pstack-schema-validate
description: Validate pstack snapshots, verification receipts, durable handoffs, or Markdown plans against the plugin's versioned contracts. Use for "validate this pstack artifact", checking pstack JSON, or verifying a pstack plan profile. Not for general JSON schema validation.
---

# Validate pstack contracts

Run the bundled validator rather than inspecting pstack artifacts by eye.

## Commands

Resolve `scripts/validate.mjs` relative to this skill directory.

```sh
node scripts/validate.mjs snapshot <snapshot.json>
node scripts/validate.mjs receipt <receipt.json>
node scripts/validate.mjs handoff <handoff.json>
node scripts/validate.mjs plan <plan.md> [basic|verified-stack]
```

The command exits `0` on success, `1` for contract violations, and `2` for
invalid invocation or unreadable input. Report every finding with its path or
line number. Do not reinterpret a failed contract as a warning.
