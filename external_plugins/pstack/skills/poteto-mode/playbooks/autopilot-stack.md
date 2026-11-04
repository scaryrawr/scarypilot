### Autopilot-stack

Run the [Autopilot-full](autopilot-full.md) playbook, but do not merge, enqueue, or arm auto-merge. All of its operator gates, ownership, receipt audits, and stop rules still apply.

1. **In place of step 5, stop at verified.** Stop when each PR is verified and green at its current head, then hand the PRs to the operator. After the handoff, nobody pushes without the operator's go. Every loop tick prompt names this file, so each tick sees the no-merge rule.
2. **Stack a PR only when it builds on another PR.** This is the one exception to step 3. Base the PR on the other PR's branch in place of trunk, per **Size and stacks** in `playbooks/opening-a-pr.md`. In place of step 2's rebase onto trunk, each owner rebases its PR onto its parent PR's branch, and the stack root rebases onto trunk. A new head on a lower PR requires its descendants' owners to restack in order; no coordinator or sibling writes their branches. Before accepting a new verdict, follow the base-freshness rule in `playbooks/shipping.md`. Any parent or trunk movement requires fresh CI and required live/perf evidence on the combined base and head. An unchanged patch-id does not preserve stale integration receipts.

Independent PRs stay independent. The handoff does not install gh-stack, adopt an untracked chain, or authorize Shipping. Shipping is a separate approved operation over an explicitly verified prefix and unambiguous ceiling.

**Reply:** list each PR with its verdict, in place of what merged.
