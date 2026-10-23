---
name: principle-prove-it-works
description: "Use when implementing a feature, fixing a bug, changing behavior, or refactoring code, including ordinary implement/fix/change requests that do not ask for proof. Check the actual acceptance condition and return proportionate evidence by default, or name the blocked verification gap. Not a separate workflow for conceptual questions or wording suggestions."
---

# Prove It Works

## Completion gate

1. Recover the original acceptance condition. Name what a caller or user must observe, including behavior that must stay unchanged.
2. Choose the smallest adequate direct check. Reuse existing tests, fixtures and project verification skills before adding machinery. Run the relevant input through the changed code to its actual output or effect. Build and lint can support this check, not replace it.
3. Inspect the observed result yourself. For a fix, preserve the original repro and check it again against the fixed behavior. For a refactor, hold the caller-visible contract against the original baseline. A failed check requires investigation of both the observation method and the system, not an assumed pass.
4. Put useful proof beside the outcome without waiting to be asked. Briefly say what ran and what it showed, with a real command, output or artifact pointer when useful. Name partial or blocked verification and the exact missing check. Do not declare behavior working when only source or build checks ran.

No fixed report format, new JSON receipt, full suite, app launch or extra agent is required. A tiny caller-facing test can be enough. For read-only answers, cite the inspected source and distinguish inference from execution. For documentation-only edits, inspect the actual change and relevant links. Do not turn a typo fix into a runtime demonstration.

## Match the observation to the claim

- **UI interaction or state.** Drive the original scenario and fresh fixed behavior on the relevant running build with the existing project verifier or supported control tools. Prefer a short genuine runtime replay when it clarifies the interaction and capture is explicitly authorized. Use an original repro plus the fixed flow; before/after comparison is useful only when it adds information. Never recreate a before-state by reverting user work. Label an unavailable baseline.
- **Static visuals.** Prefer a relevant fresh screenshot or visual comparison over mandatory video. Pixel-exact claims retain the existing [Visual parity](../poteto-mode/playbooks/visual-parity.md) workflow.
- **Persistence.** Write through the intended boundary, then independently read back through a fresh process, reopened app or real storage reader as appropriate. A setter echo or in-memory getter does not prove persistence.
- **CLI or service.** Exercise the real command/request flow. Inspect meaningful output, exit/status and relevant effects, including the full communication path for integrations. Check process liveness directly if that is the claim.
- **Library or parser.** Caller-visible tests or replayed inputs may be the direct proof. Launching an unrelated app is not stronger evidence.
- **Performance.** Use [benchmark-checklist](../benchmark-checklist/SKILL.md) before measuring or reporting speed. Compare matched useful work and correct outputs, not skipped rows, cached/no-op paths or errors. Keep its measurement limits and inconclusive verdicts. A video alone is not a speedup measurement.

## Evidence honesty and replay

Check that evidence corresponds to the current relevant code/build, scenario and inputs. An existing path or recent timestamp is not enough. Reuse prior evidence only after establishing that it still covers the claim; otherwise rerun or label the gap. Inspect actual delegated artifacts and results, not a delegate's summary. Schema validity, a green unrelated build and cached screenshots do not establish runtime behavior.

Name the surface actually exercised. A browser harness can prove its browser flow, not an untested native app. Never substitute an animation, mockup or generated clip for runtime evidence.

This skill is not capture authorization. Respect separate audio, privacy, installation, mutation and upload approvals. Missing runtime, consent or dependencies means partial/blocked verification, not fabricated success. Use synthetic data and approved local storage. Avoid sensitive content; do not publish raw private material.

When authorized, reuse installed screen-record/media workflows and their evidence-video editing standards. Do not bundle or install a recorder just for this gate. Preserve raw originals and meaningful waits; edits must not hide failed transitions or change timing to imply success. Review the actual raw and final content before citing it. Keep raw evidence accessible and confirm referenced files survive cleanup.

Make a supported local clip easy to review with the host's attachment or local-link surface when available. Do not auto-upload to get a public URL. If presentation is unavailable, give the real local path and the limitation. Keep long logs out of the main reply.

## Script the check when you can

Prefer a deterministic rerunnable check over a one-time eyeball when it earns its cost. Reuse the project's existing verification skill; do not generate a whole verifier for each edit.

For large or unattended work, use [show-me-your-work](../show-me-your-work/SKILL.md) for the decision trail. A log of decisions is not itself proof of behavior. Keep artifacts local unless publication or committing is authorized.
