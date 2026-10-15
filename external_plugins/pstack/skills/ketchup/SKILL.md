---
name: ketchup
description: "Catch the user up on what changed in this chat since their last message, in a few plain sentences and small visuals. Give each action item just enough context to make the call. Use for /ketchup."
---

# Ketchup

Catch the user up on what changed in this chat since the last message they wrote before `/ketchup`. Help them understand each change, not only where it stands. Notifications and subagent results are not their messages. Assume the user remembers their last message and nothing after it.

Use [`/bro`](../bro/SKILL.md)'s voice, not its task. Use plain words, short sentences, and no jargon. Say what changed for the user, not how you did it. Say "the tests pass", not "CI is green". Leave out hashes, paths, commands, build numbers, and test counts unless the user needs one to act. Name each PR, branch, or agent as the user knows it. If a fact needs context to make sense, give the context or leave it out.

## Gather what changed

Keep this turn read-only. Make visuals only from evidence you already have. Do not change code, start an app or a job, or post anything externally. Collect your own work since that message, reports from agents, and other messages in this chat. Check the current state of each PR, check run, or agent this chat touched through the available host tools. Scope session-history queries to this conversation or its known agents. If a live read is unavailable, distinguish reported state from confirmed state. Check each number against its source, and say when you correct one.

An action item is a decision or step only the user can take, such as a product choice, an approval, an irreversible action, or access you lack. Include any still waiting on the user, even one raised before their last message. Work you can do yourself is not an action item. Never invent a call to fill the reply. An unasked step the work does not need is not an action item, unless it is irreversible and already waiting on the user. Give that step one action line, no visual, and no no-answer prediction.

## Write the reply

Keep the whole reply well under 150 words, not counting visuals. When a picture explains a change better than sentences, show how things connect, a before and after, or options side by side. Do not draw a status list or disconnected boxes. Do not give a fact twice, in text or across visuals. Leave out work that changed nothing for the user. Cut history before action items.

Open with one sentence saying how many things need the user, or that nothing does. If nothing happened and nothing waits on the user, say so and stop.

Show what happened, pictures first. Embed existing screenshots and videos when the host supports them, then any diagram explaining a change. Give one short bullet per thing the user asked for, stating the outcome and whether it is done, still running, failed, or not checked. Name bugs found and fixed on the way. Each line must stay true alone. Never mark something done that still waits on the user, and do not repeat action items. Add at most three short lines that change what the user knows or must do. Name work you can still do yourself in one line.

List action items as plain bullets, never as a diagram. State the decision with your recommendation and why, then what happens without an answer. Give an unasked irreversible step only one line. Include prerequisites and irreversible consequences in the recommendation. Write "unknown" for what you do not know. Link to existing detail.

Use `ask_user` for a real user-owned decision and the host's plan/approval tools for their corresponding gates. Do not ask for approval in ordinary reply text, invent a reply token, answer for the user, or take the action during catch-up. Present independent facts before stopping on a question.

When choices need a comparison, show each option's gain and cost after the list. If existing screenshots show the options, put those tradeoffs under the screenshots instead of drawing a second visual.

## Visuals

A visual is an existing screenshot or video, a Mermaid diagram, or a chart rendered by an available host tool from known evidence. A Markdown table is not a visual. No companion visualization plugin is required.

Keep a diagram to at most six boxes, with at most eight plain words per box. A fact needing a sentence belongs in text.

If a visible change has no capture, mark its summary "No screenshot yet" and say what changed on screen. Do not launch the app to capture it in this turn. Never invent a number or draw a screen you did not capture. Link or attach only artifacts that exist, using supported host presentation tools without posting externally.
