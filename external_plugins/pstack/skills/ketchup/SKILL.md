---
name: ketchup
description: "Catch the user up on what changed in this chat since their last message, in plain words and small visuals. List every item waiting on them with what they need to decide it from the reply alone. Use for /ketchup."
---

# Ketchup

Catch the user up on what changed in this chat since the last message they wrote before `/ketchup`. Help them understand each change, not only where it stands. Then lay out every call waiting on them so they can make it from the reply alone. Notifications and subagent results are not their messages. Assume the user remembers their last message and nothing after it.

Use [`/bro`](../bro/SKILL.md)'s voice, not its task. Use plain words, short sentences, and no jargon. Say what changed for the user, not how you did it. Say "the tests pass", not "CI is green". Leave out hashes, paths, commands, build numbers, and test counts unless the user needs one to act. Name each PR, branch, or agent as the user knows it. If a fact needs context to make sense, give the context or leave it out.

## Gather what changed

Keep this turn read-only. Make visuals only from evidence you already have. Do not change code, start an app or a job, or post anything externally. Collect your own work since that message, reports from agents, and other messages in this chat. Check the current state of each PR, check run, or agent this chat touched through the available host tools. Scope session-history queries to this conversation or its known agents. If a live read is unavailable, distinguish reported state from confirmed state. Check each number against its source, and say when you correct one.

An action item is a decision or step only the user can take, such as a product choice, an approval, an irreversible action, or access you lack. Include any still waiting on the user, even one raised before their last message. Work you can do yourself is not an action item. Never invent a call to fill the reply. An unasked step the work does not need is not an action item, unless it is irreversible and already waiting on the user. Give that step one action line and no visual.

One call can cover many items, such as each PR in a set awaiting merge. For each item, collect its link, what it changes for users, the evidence behind your pick, its risk, and your pick. Write "unknown" for a fact the call needs that you do not know. Leave out a link you do not have.

## Write the reply

Spend words on the calls, not on the story. Keep what happened under 100 words, not counting pictures, and shorter when less happened. Leave out work that changed nothing for the user. Give each item about 30 words. The reply grows with the number of items: two items need well under 150 words in all, not counting pictures, and thirty need far more. Never cut items or shrink them to stay under a word count: no count in place of a list, and no link in place of an item. A link can add depth, but the reply alone must be enough to decide.

Open with one short sentence naming what waits on the user, or saying nothing does. The action items give the detail. If nothing happened and nothing waits on the user, say so and stop.

Show what happened, pictures first. Embed existing screenshots and videos when the host supports them, then any diagram explaining a change. Give one short bullet per thing the user asked for, stating the outcome and whether it is done, still running, failed, or not checked. Name bugs found and fixed on the way. Each line must stay true alone. Never mark something done that still waits on the user, and do not repeat action items. Add at most three short lines that change what the user knows or must do. Name work you can still do yourself in one line.

List action items as plain bullets, never as a diagram. State the decision and your pick. Include prerequisites and irreversible consequences in the pick. Give the number or link of each PR, issue, or agent a call is about, including a call between options.

A call about one item is one bullet: the call, your pick, what it changes for users, the evidence behind your pick, and its risk, with the item named once. When items share a call, write the call and your pick once, then give each item its own bullet, riskiest first: its link and name, what it changes for users, the evidence behind your pick, and its risk. Name an item's pick only where it differs from the call's. Give each item's risk even when it is low. Say what waiting costs only when it is more than a delay, such as a deadline or lost data.

Use `ask_user` for a real user-owned decision and the host's plan/approval tools for their corresponding gates. Do not ask for approval in ordinary reply text, invent a reply token, answer for the user, or take the action during catch-up. Present independent facts before stopping on a question.

For a call between options, give every option the work weighed, each with what it gets the user and what it costs, and the current state when there is one. Those costs are the call's risk, so add no separate risk line. If existing screenshots show the options, put those tradeoffs under the screenshots instead of drawing a second visual.

## Visuals

A visual is an existing screenshot or video, a Mermaid diagram, or a chart rendered by an available host tool from known evidence. A Markdown table is not a visual. No companion visualization plugin is required.

When a picture explains a change better than sentences, show how things connect, a before and after, or options side by side. Do not draw a status list, action items, or disconnected boxes. Do not give a fact twice, in text or across visuals.

Keep a diagram to at most six boxes, with at most eight plain words per box. A fact needing a sentence belongs in text.

If a visible change has no capture, mark its summary "No screenshot yet" and say what changed on screen. Do not launch the app to capture it in this turn. Never invent a number or draw a screen you did not capture. Link or attach only artifacts that exist, using supported host presentation tools without posting externally.
