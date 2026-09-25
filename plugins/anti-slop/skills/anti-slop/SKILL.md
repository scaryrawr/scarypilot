---
name: anti-slop
description: Use when writing, reviewing, refactoring, or repairing TypeScript or JavaScript, and when asked to anti-slop, unslop, remove AI-generated slop, fix Anti-Slop findings, improve type precision, replace unsafe assertions, parse unknown data, or avoid lint-shaped workarounds. Apply as advisory guidance even when the repository has not installed Anti-Slop.
---

# Anti-Slop

Write code that preserves evidence about its values instead of discarding that
evidence and reconstructing it later with assertions, reflection, or runtime
guessing.

This skill is advisory. Do not install a linter, dependency, build step, or
repository configuration unless the user asks for repository enforcement.
When the standalone plugin's pre-edit hook denies an edit, use its remediation
to revise the proposed code and retry the same editing tool. Do not bypass the
guard with a shell write.
When its post-edit hook reports a generic record predicate, inspect the full
file and the value's origin before changing code. Retain a justified boundary
check; otherwise preserve a known type or parse external input into a named
contract instead of renaming the guard.
The standalone plugin's post-edit hook also reports parser-backed Anti-Slop
diagnostics for newly edited code. Treat those as leads for the remediation
order below, not as permission to apply broad mechanical rewrites.

## Optional heuristic scan

For a quick read-only pass in a repository that has not installed Anti-Slop,
run:

Resolve `scripts/scan.mjs` relative to this skill directory while keeping the
shell working directory at the repository being scanned.

```bash
node scripts/scan.mjs [paths...]
```

Use `--json` for structured output, `--max N` to limit displayed candidates,
and repeat `--ignore DIR` for repository-specific generated directories:

```bash
node scripts/scan.mjs . --ignore lib --ignore packages/api/generated
```

The script has no package dependencies and skips conventional generated,
vendor, and build-output directories. Ambiguous names such as `lib` are not
ignored by default because many repositories keep authored source there.

The scan intentionally covers only high-confidence textual candidates. Treat
its results as review leads, not lint violations. Confirm every finding in
context, and do not claim the scan proves the repository is clean. Prefer the
repository's parser-backed lint command whenever one exists.

## Core standard

Prefer code where:

- External data is parsed once at the boundary where it enters the program.
- Internal functions accept and return named domain types.
- Inference remains precise instead of being widened preemptively.
- Branches use established domain discriminants rather than representation
  checks.
- Tests exercise explicit seams rather than replacing module internals.
- Assertions are removed when code can prove the same fact.

Treat a diagnostic as evidence of a design problem, not a string-matching
exercise. Fix the underlying information flow.

## Remediation order

When code looks imprecise or a lint rule reports a finding:

1. Identify whether the value is external, persisted, user-controlled, or
   otherwise untrusted.
2. If it is untrusted, parse it at the actual I/O boundary.
3. If it is already internal, preserve or recover its existing domain type
   without adding another parser.
4. Prefer inference or a named owner contract over an anonymous widened type.
5. Remove assertions by changing control flow, lookup handling, or data
   construction.
6. Add a `SAFETY:` comment only when an assertion is genuinely unavoidable and
   the comment names the invariant that makes it sound.
7. Validate behavior, not merely the disappearance of a diagnostic.

## Boundary parsing

Parse at real boundaries such as:

- HTTP responses and request bodies.
- JSON, JSONL, YAML, or persisted state.
- CLI output and environment-derived configuration.
- Tool, hook, extension, or factory arguments.
- Messages received from another process or service.

Use the repository's existing schema library. When TypeBox is already
available, define the runtime schema and derive the TypeScript contract with
`Static<typeof Schema>`. Use `Value.Check` for intentionally tolerant input
and `Value.Parse` when malformed data must fail.

Do not spread schema checks throughout business logic. Parse once, then pass a
domain value.

For a dependency-free standalone script, keep it dependency-free unless the
user chooses otherwise. Use a small explicit parser, a standard-library
facility, or a scoped lint exception rather than adding a package solely to
satisfy a rule.

## Preserve type evidence

Avoid:

- Explicit return annotations that widen a more precise inferred value.
- `Record<string, unknown>` when the owner knows the value contract.
- `unknown` parameters or returns between internal functions.
- `type Json = unknown` or similar aliases that only rename uncertainty.
- Widening a value and then asserting it back to the desired type.
- `as unknown as T`, chained assertions, or converting uncertainty to `any`.

Prefer:

- Named domain interfaces and discriminated unions.
- Schema-derived JSON or persisted-data contracts.
- `Record<Key, Value>` with concrete key and value types.
- `Map<Key, Value>` when keys are dynamic and ownership is explicit.
- `satisfies` when a constructed value should be checked without widening.
- Inferred local return types when no public owner contract is needed.

Do not introduce a generic `<T>` merely to hide an `unknown` parameter. A
generic is appropriate only when the implementation truly preserves the
caller's type relationship.

## Runtime branching

Runtime representation checks are appropriate while parsing an untrusted
value. They are usually the wrong abstraction after parsing.

Do not move `typeof`, `Array.isArray`, or property-existence checks into a
trivial helper just to silence a finding. That preserves the same ambiguity
under a different name.

For internal values:

- Branch on a discriminant such as `kind`, `type`, or `status`.
- Use normal control-flow narrowing for a known union.
- Change the caller contract if the callee should never receive multiple
  representations.

## Assertions

First try to eliminate an assertion by:

- Checking a lookup result before use.
- Returning early when a value is absent.
- Parsing external data.
- Giving a constant its precise literal or branded type at construction.
- Extracting a typed helper for framework-specific values.
- Building an object under a named interface instead of casting it afterward.

When an assertion is unavoidable, place a concise `SAFETY:` comment
immediately before it. The comment must state the checked invariant, lifecycle
guarantee, or framework constraint. Comments such as "needed for TypeScript"
or "this is safe" are not evidence.

## Testing and module boundaries

Do not mock a module to replace private imports when a small explicit seam is
available.

Prefer:

- Dependency-injected registration functions.
- Ports or adapters for filesystem, process, network, and SDK behavior.
- Pure builders that return registration options.
- Direct tests of the injected boundary.

Keep production defaults at the outermost entrypoint so normal startup remains
simple.

## Collection and object construction

Prefer straightforward transformations:

- Replace `filter(...).map(...)` with `flatMap`, a loop, or a single pass when
  the intermediate collection adds no meaning.
- Avoid copying an accumulator on every `reduce` iteration. Use a loop, mutate
  a local accumulator, or use `Object.fromEntries`.
- Replace conditional empty-object spreads with an explicit branch or a
  clearly constructed optional property.
- Give object parameters and returned structures named contracts when they
  represent a domain concept.
- Avoid reflective `Reflect.get` or `Reflect.apply` when ordinary typed
  property access or function calls express the contract.

Use blank lines to separate setup, guards, transformations, and return values.
Readable spacing should expose the program's phases rather than maximize line
density.

## Names

Name values after their domain purpose, not their incidental representation.
Avoid vague names such as `shape`, `payloadShape`, or `responseShape` when a
specific contract name is available.

Examples:

- `PullRequestDetails`, not `PullRequestShape`.
- `PersistedRuntime`, not `RuntimeObject`.
- `ProviderDiscoveryResponse`, not `ResponseData`.

## Patterns to reject

Do not "fix" Anti-Slop concerns by:

- Adding trivial guard wrappers around the same runtime checks.
- Replacing `unknown` with `any`.
- Adding assertions plus comments without establishing an invariant.
- Parsing already trusted internal values repeatedly.
- Introducing TypeBox or another parser into every helper.
- Adding a build or install step to a deliberately dependency-free script
  without user approval.
- Disabling a rule repository-wide because one boundary needs a scoped policy.
- Running a broad autofixer without reviewing semantic changes.

## Working with repository enforcement

If the repository already has Anti-Slop or equivalent lint tooling:

1. Read its scripts, configuration, scoped overrides, and generated-output
   ignores.
2. Run the smallest lint command covering the changed files.
3. Classify findings by root cause before editing.
4. Use autofix only for demonstrably mechanical changes such as readable
   spacing.
5. Inspect the diff after autofix and restore unrelated semantic rewrites.
6. Re-run the repository's required tests and typechecks.

If the repository does not have enforcement, follow this skill as design
guidance and continue with the repository's existing toolchain.
