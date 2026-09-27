---
name: principle-test-behavior-not-implementation
description: "Apply when writing, changing, reviewing, or keeping tests in any language. Exercise a caller-visible contract and check an independently specified outcome; avoid assertions tied only to mocks, fixtures, constants, or private steps."
---

# Test Behavior, Not Implementation

A test should fail when the behavior its caller relies on breaks, not when an incidental implementation detail changes. This applies equally to Go, Rust, Zig, C, C++, and JavaScript/TypeScript. Choose the boundary the consumer actually uses: a function's result or error, a CLI's output and exit status, a file written, a protocol response, or an effect at an external port.

When writing or reviewing a test:

1. Name the behavior and one plausible defect the test must catch. Choose a concrete input that distinguishes correct from incorrect behavior, including a failure case where it matters.
2. Invoke the subject through its normal caller-facing boundary. Replace only uncontrollable dependencies, such as a clock, network, or filesystem, at an explicit seam; do not mock the subject or its private collaborators.
3. Assert a specific observable outcome against an independent oracle: a literal example, an external specification, a known fixture produced outside the subject, or a property checked over varied inputs. Do not compute the expected value by calling the same logic again.
4. Check that the test fails if the named defect is introduced. For a risky or ambiguous test, temporarily inject that defect or mutate the subject and run the focused test, then restore it. If no realistic defect would make the test fail, strengthen it or remove it.

For example, check that `slugify("Hello, World!")` yields `"hello-world"`, not that it called a lowercasing helper. In Go, compare a result and error to a known case; in Rust, assert the `Result` or state seen by the caller; in Zig, use `expectEqual` on the outcome; in C or C++, assert the returned value, output buffer, or externally visible effect. The assertion syntax changes, not the standard of evidence.

**Investigate these weak patterns in any language:**

- No assertions, or only broad checks such as "not null," "did not panic," "success," or "called once," when the intended contract specifies more.
- Assertions only about a stub, a fixture constructed by the test, or a constant copied from production, without exercising the behavior that consumes it.
- Self-referential expectations, such as comparing `f(x)` with `f(x)` or deriving the expected output from the same algorithm under test.
- Checks of private helpers, internal call counts, or intermediate representation when the caller-visible result could be asserted instead.

These are review prompts, not blanket bans. An empty result, rejection, no panic, callback invocation, precise error, or ordering can itself be the contract. Assert it with a case that would expose a defect. A mock at an external boundary can verify the meaningful payload or effect, not merely that the mock was called. Keep relational invariants across data, property-based and fuzz tests with real oracles, and compile-time/type checks (including `*.test-d.ts`) even when they do not assert a literal runtime value. Avoid pinning a constant unless its exact value is itself a published contract.
