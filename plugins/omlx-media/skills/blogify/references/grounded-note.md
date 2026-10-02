# Create an independently checked note

Use `blogify-grounded-note` only when the user wants the optional factual gate.
Keep audio extraction, transcription, and frame preparation in the existing
native tools. The workflow does not prepare media or write an article.

1. Check registration with `dynamic_workflows_manage` using `operation: "list"`.
   Dynamic workflows are experimental. CLI users must enable `/experimental on`
   or `--experimental`. If the workflow is absent, use the ordinary blogify
   authoring path. Direct skill installation does not supply the extension.
2. Obtain explicit permission to send the prepared transcript text to hosted
   Copilot drafting and checking workers. This permission is separate from
   local OMLX preparation and any remote OMLX endpoint permission. Do not set
   `allow_agent_transmission: true` without that consent.
3. Read the complete recording manifest from `omlx_transcribe` recording mode.
   Compute its SHA256 with `shasum -a 256 <absolute-manifest-path>`. Pin that
   digest before calling the workflow. Do not edit the manifest to correct
   jargon or make an oversized source fit.
4. Call `run_dynamic_workflow` with `name: "blogify-grounded-note"` and these
   arguments. Fill the intent from the user's request.

   ```json
   {
     "manifest": "/absolute/prepared-recording/manifest.json",
     "expected_manifest_sha256": "<64 lowercase hexadecimal characters>",
     "allow_agent_transmission": true,
     "intent": {
       "audience": "developers",
       "tone": "plain",
       "scope": "a short note about the demonstrated behavior"
     }
   }
   ```

5. Read the completed run's returned artifact. Inspect its `draft`, `review`,
   `source_chunks`, and `markdown` against the recording. The fixed title adds
   no factual claim. Every rendered claim has an exact quote and chunk boundary.
   A checker can still be wrong. Quote existence alone does not prove truth,
   and the workflow does not verify transcription accuracy.
6. Keep the host result as the reviewed artifact, or save its exact JSON and
   Markdown to fresh workspace files with the usual file tools. The host owns
   the durable run journal and result. The extension is the sole artifact
   producer and writes no files, so it needs no `output_dir` or ownership
   marker and cannot collide with an earlier output directory.
7. Keep the note pending human review. A completed run returns
   `status: "user_review_required"` and `publication_approved: false`.
   No workflow result authorizes publication. New prose or images added during
   editorial work are outside the independent claim review.

## Bounds and failures

The complete manifest must be at most 64 KiB with at most 12 sequential chunks.
Chunk endpoints and adjacent boundaries allow only the preparation producer's
one-sample (1/16,000 second) resampling tolerance; projected timestamps are not changed.
Projected transcript text is limited to 32 KiB in total.
Each chunk has at most 16,384 characters.
Audience, tone, and scope each have at most 256 characters.
The writer returns 1 to 6 claims, each at most 1,000 characters, with 1 to 3
distinct citations. Each quote has at most 2,000 characters.
The checker returns exactly one unique explained verdict per claim.
Worker JSON responses are limited to 16 KiB.

The workflow calls one restricted writer, then one restricted checker.
Both have `tools: []` and `infer: false`, registered with the workflow in the
same session attachment. Reports use raw JSON responses and full TypeBox
validation, not the SDK's ignored fine-grained schema constraints or automatic
structured-output retries. Invalid reports fail rather than spawning repairs.

The extension rereads the pinned source on every attempt, before checking,
and before returning. Stable versioned journal keys bind the source digest
and intent. Retries reuse validated reports; they never adopt a different
source or another run's outputs. Source changes produce `STALE_SOURCE`.
Unsupported claims produce `UNSUPPORTED_CLAIM`, with no reviewed note.
Inspect the workflow reports and correct the underlying problem before a new
run. Never relabel a rejected draft as reviewed.

There is no built-in checkpoint and no automatic resume. A host-paused run is
not completion or approval. Resume only on the user's explicit instruction.
Host cancellation is cooperative; a worker can consume credits before it stops.
The extension checks the cancellation signal around reads and worker calls.
The no-tool worker restriction does not sandbox extension code.

This adds an independent factual gate and durable reviewed ownership.
It does not establish better prose, lower cost, faster execution, real OMLX
accuracy, or availability on every host. For a large article, use the ordinary
skill-guided workflow rather than increasing these bounds.
