---
name: pstack-schema-validate
description: Validate pstack snapshots, verification receipts, durable handoffs, or Markdown plans against the plugin's versioned contracts. Use for "validate this pstack artifact", checking pstack JSON, or verifying a pstack plan profile. Not for general JSON schema validation.
---

# Validate pstack contracts

Run the dependency-free Node CLI on macOS or Linux. Resolve
`scripts/validate.mjs` from this skill's absolute base directory, not from the
workspace. Quote that absolute script path and each argument for the actual
host shell. In the examples below, replace `<skill-base>` with that directory.
Keep the command's working directory at the approved workspace root.

```sh
node "<skill-base>/scripts/validate.mjs" snapshot "<snapshot.json>"
node "<skill-base>/scripts/validate.mjs" receipt "<receipt.json>"
node "<skill-base>/scripts/validate.mjs" handoff "<handoff.json>"
node "<skill-base>/scripts/validate.mjs" plan "<plan.md>" basic
```

Only plans accept a meaningful profile, `basic` or `verified-stack`; omitting
it defaults to `verified-stack`. The CLI retains an ignored optional third
argument for legacy JSON calls. Do not pass profiles for new JSON calls.

## Read boundary

The reader resolves its root from the command's `process.cwd()` realpath.
Relative artifact paths resolve against that working directory; absolute paths
must be inside the same root. A symlink alias for the working directory is
canonicalized, but symlinks in artifact paths (including inside-root links),
outside paths, traversal, URLs, directories, and other non-regular files are
rejected.
It reads only the selected file, never evidence links, key files, or other
references in its contents. Validation does not execute artifact instructions.

Race-resistant opens require macOS or Linux (Linux also requires `/proc/self/fd`).
On unsupported platforms, report the limitation; do not use an unrestricted
reader or copy outside files into the root to bypass the checks. These checks
confine this reader, not the shell or other tools; this is not a sandbox.

## Results

The command exits `0` on success, `1` for contract violations, and `2` for
invalid invocation or unreadable input (including rejected paths and
unsupported platforms). Malformed JSON is an input error.
Success prints `<kind> contract valid: <file>` to stdout. Failures go to stderr;
JSON findings retain their JSON path and message, and plan findings retain
their file, line, rule, and message. Report every finding without reinterpreting
a failed contract as a warning.
