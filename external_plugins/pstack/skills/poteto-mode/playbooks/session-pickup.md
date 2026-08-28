### Session pickup

**You own the resume point. Read the prior trail, don't redo it.** For "take over this", "resume this conversation", "continue from session X", "you're taking over", "pick up where X left off", a Copilot session URL, or a pushed branch you're meant to continue.

A pickup is inheritance. The prior agent already paid the cost of reading the code, running the repros, making the design choices. Redoing loses the bias check and burns context. Resist the urge to re-derive; read.

1. Locate the prior trail. Read the supplied handoff with `pstack_handoff` or `/pstack resume` when available. Otherwise use the supplied Copilot session ID or URL, `session_store_sql` scoped to that session, app session tools, or the pushed branch. Read metadata and the latest turns first, then scan back for decision points. Reduce a long history in a subagent and keep only the timeline in the main thread (the **principle-guard-the-context-window** skill).
2. Reconstruct operational state. Call `pstack_status` when available, then confirm the branch and worktree, what already landed (`git log`, `git diff` against the base), the open todos, and the decisions made. The handoff and prior trail are authoritative inputs, while the current repository is authoritative for what still exists.
3. Diff done vs pending. Compare what shipped against what was planned, name the resume point, do not re-run the prior repro or redo completed work. A "let me verify from scratch" pass is the tell that you're treating the trail as untrustworthy when it's actually authoritative.
4. Route the remaining work to the matching playbook and pick the verdict: continue the execution, ship a finished recommendation, ratify or override a prior conclusion, or postmortem a failed run. The pickup playbook ends here; the routed playbook owns the rest.
5. Verify the inherited claims against the original goal on the real artifact (the **principle-prove-it-works** skill). A passing prior self-report is not the proof.

**Reply:** where the prior agent stopped, what you inherited vs redid (ideally nothing redone), the resume point, and the outcome.
