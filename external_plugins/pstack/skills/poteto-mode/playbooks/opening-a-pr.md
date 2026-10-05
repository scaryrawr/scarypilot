### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main. Parallel writers use separate worktrees or disjoint file scopes. Never assume Task agents receive isolated worktrees automatically. Preserve dirty work and create a fresh worktree instead of resetting it.

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable.

**PRs.** Run `/deslop` over the diff before commit. Then run the repository's formatter and linter. Run `/no-comments` before review. Write every PR title, PR description, and commit body with `/technical-writing`, then apply `/unslop`. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.

**Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. Use the changed area, such as `pstack` or `poteto-mode`, as the scope. Keep the subject short and imperative. Name a real symbol when one carries the change. For example, `fix(pstack): retarget opening-a-pr babysit trigger`. Do not add a trailing period.

**Descriptions.** The PR body is a briefing, not the lab notebook. A reviewer who has the diff should learn why the change exists, what it leaves out, what it could break, and how you proved it works, in under a minute. Write short, simple sentences with few identifiers. Do not write walls of text. The squash commit body is the PR body. If the body would make the squash commit longer than about 40 lines, cut the body.

Put each section under a `##` heading, not a bold lead-in. Use these sections in order. Drop an empty optional section, but always state the scope.

- `## Why` gives the problem and the approach in one to three short sentences. Do not list SHAs or rebase genealogy. Do not add a "based on main" preamble.
- `## What changed` has one to three short bullets. Name a real symbol or path only when it carries the change. Name both sides of a rename or retarget.
- `## Scope` always names what the PR covers and what it deliberately leaves out, for example a related follow-up or a known gap. Use one to three short items. Do not list symbols or paths, and do not write a file-by-file essay.
- `## Tradeoffs` names only rejected alternatives that a reviewer would otherwise ask about. Skip this section when there was no real choice.
- `## Blast Radius` gives one or two sentences on who or what the change touches and why that is safe or risky. If main is red, state the cost of leaving it red.
- `## Verification` has one to three bullets. Each bullet names a real run path and its outcome. For a performance change, report one primary number with its unit in `before → after` form. Link the arena or swarm directory for the remaining evidence. Do not include sample-size methodology, swarm recitals, or metric tables.

After these sections, attach videos or screenshots when they prove a claim. Put full SHAs, lane recitals, and detailed checklists in a linked artifact. A commit body does not restate its subject. Follow required repository templates. Append `- Generated with AI 🤖` once at the end of agent-authored published PR descriptions, comments, and review replies. Do not attribute user-authored or third-party text.

**Built-in PR tools.** When the host provides a PR creation or update tool for the requested operation, use it instead of the forge CLI. Follow its scope and failure instructions. Do not use a tool that cannot target the intended repository, branch, base, or PR. Unsupported retarget or readiness operations still use the available forge workflow. Without a matching built-in tool, use GitHub CLI (`gh`) or the repository's configured forge.

**Size and stacks.** Prefer five narrow PRs to one large PR. Keep dependent changes in an ordered base-branch chain. Branch from main only for independent work. Use the repository's Graphite workflow when it tracks stacks; otherwise target each child PR at its parent branch. Rebase on `main` before substantial stack work.

**Readiness.** Unless the user or repository workflow requires a draft, open every PR ready. Set `draft: false` on PR creation calls. If it opens as a draft unexpectedly, use a supported ready operation, such as `gh pr ready <number>`. Do not change an existing intentional draft without approval. Read live PR state through the available tool before you refer to its status.

**Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass only when the user asks for one after the whole stack exists. A babysit for each new PR stalls the build and spends checks on commits that later waves restart. Push back when feedback drifts from intent.

A subagent that opens a PR runs `interrogate`, `/unslop`, and `/no-comments`. It posts the URL, then returns to the parent without babysitting, unless it is an Autopilot-full or Autopilot-stack owner. That owner's brief assigns the babysit loop and is the ask `playbooks/babysit.md` waits for. The owner starts the loop after its code-ready report and reports merge-ready or STACK-READY as its playbook says. The rules here and in `playbooks/babysit.md` that hold babysitting until a whole stack is built do not apply to that owner.
