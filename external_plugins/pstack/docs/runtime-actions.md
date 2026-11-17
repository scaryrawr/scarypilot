# Resolve runtime actions

Use action descriptions as search keywords, not tool names or invocation syntax.
Discover the current host's advertised capabilities and read the selected tool's
schema before calling it. Deferred tools need discovery first. A keyword match
does not prove a capability exists or grant permission.

| Action | Required evidence and limits |
| --- | --- |
| Launch an independent worker | Confirm a launch capability and supported roles. Use a read-only exploration role, a diff-review role, or an implementation role as the task needs. Request only supported settings. If custom agents are not registered, give a suitable worker the relevant body from `agents/` as a prompt reference. These files are not Codex agent registrations. |
| Select a worker model | Read the role mapping explicitly available to this session. Missing configuration, a missing role, `auto`, and `inherit-parent` all mean omit explicit model selection. Use a concrete ID only when the host supports it and the user's configuration authorizes it. Do not send aliases or invent model IDs or effort variants. A pre-start model rejection permits only the calling skill's fallback. Never replay a worker that may have written. |
| Wait, read results, or message a worker | Retain the identity returned by launch. Use that identity for status, terminal results, and same-task follow-ups. Do not confuse worker identities with persistent session identities. Use notifications when available, not duplicate launches or busy polling. Independent work needs a fresh worker. |
| Isolate writing work | Supply a separate checkout and branch, or a worker-specific scratch directory for non-repository artifacts. Launching a worker does not prove isolation. A read-only brief is not an enforced tool restriction. If stronger isolation is required but unavailable, report the gap. |
| Search scoped history | Prefer supported history search over private transcript files. Bound the time, active repository or explicitly supplied session reference, and topic before searching. Read metadata first and only matching turns afterward. Never search unrelated projects. Without history access, use visible conversation and live repository state and label the missing coverage. |
| Read or coordinate a persistent session | Confirm the host provides session status, messaging, or scheduling separately from worker launch. Retain its returned identity. A worker is not a persistent session. If the required capability is absent, use only a documented bounded fallback or report blocked. |
| Ask for a decision or permission | Use the supported question, plan, or approval action for that gate. Never answer for the user or invent an approval token. Tool availability and skill installation do not authorize external writes, capture, uploads, installs, paid runs, or merging. |
| Read or write project instructions and skills | Discover the directories the current host actually loads. Copilot commonly uses `.github/skills/`; Codex uses `.agents/skills/`. Path examples do not establish discovery. Preserve the project's conventions and use an approved writable destination, never the installed plugin cache. |

If independent review is required and no independent worker can run, report that
gate blocked. Self-review, CI, or a lexical check cannot replace it. If parallel
execution is unavailable but independent workers can run serially, disclose the
serial execution. Preserve per-skill panel sizing, evidence, and permission gates.

Read [setup-pstack](../skills/setup-pstack/SKILL.md) for native configuration
locations. Shared skills use only the role mapping loaded or explicitly supplied
to the current session. A file in another client's home is not configuration for
this host.

In path templates, replace `<project-skills>` and `<personal-skills>` with the
confirmed discovery directories for this host before reading or writing.
They are placeholders, not literal directory names.
