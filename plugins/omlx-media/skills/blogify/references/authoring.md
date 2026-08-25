# Authoring: turning artifacts into docs / blogs

Guidance for shaping `transcript.md`, takeaways, and a classified frame manifest
into the requested output, with optional repo integration.

## Ask for intent first

Before drafting, confirm from the user (or the invoking prompt):

- **Output type** — reference doc, tutorial, blog post, changelog, release
  notes, meeting notes.
- **Audience & tone** — internal engineers vs external readers; neutral/how-to
  vs narrative/punchy.
- **Length & scope** — comprehensive vs highlights; which topics to include.

## Grounding rules (non-negotiable)

- Only assert what the transcript (or slides/chat) actually supports. If the
  audio was unclear or a term looks mistranscribed, verify or flag it — never
  paper over a gap with a confident-sounding invention.
- Prefer the primary source when sources conflict; an existing doc or the slide
  deck usually beats a garbled transcript phrase.
- A transcript alone often can't attribute opinions in a group discussion. Pull
  speaker attribution from the meeting chat or attendee list if it matters, and
  present shared opinions neutrally rather than guessing who said what.

## Synthesizing takeaways

- Group the transcript into topics, then write per-topic takeaways in the
  reader's voice — not a play-by-play of the talk.
- Keep concrete, reusable specifics (commands, links, exact names, gotchas) and
  drop live-demo filler ("let me full-screen this", "one sec").
- Sub-agents can fan out per-topic synthesis in parallel for long recordings.

## Screenshots must earn their place

Add an image only when it makes the surrounding text **easier to understand** —
not for decoration. Strong candidates are frames that make an abstract idea
concrete (a UI, a terminal state, a settings pane, a numbered how-to slide).
Weak candidates are talking-heads, plain search results, or anything the prose
already conveys.

- Place each image right next to the concept it illustrates.
- Write descriptive alt text that states what the image shows.
- Use frame timestamps to pull the exact moment the speaker references.

## Optional: wiring into a repo

If the target is a docs repo, mirror that repo's conventions instead of assuming:

- **Find the docs' image convention** (e.g. a sibling `.images/` folder) and put
  images there. Check whether the repo uses **Git LFS** for binaries
  (`.gitattributes`) — if so, staged PNGs should become LFS pointers.
- **Embedding video/slides.** Many docs sites allow `<iframe>` (check the
  markdown-lint config's allowed elements). SharePoint/Stream needs the
  frame-able embed URL, not the raw share link: video via
  `…/_layouts/15/embed.aspx?UniqueId={GUID}`, PowerPoint via
  `…/_layouts/15/Doc.aspx?sourcedoc={%7BGUID%7D}&action=embedview&wdAr=1.7778`.
  Resolve the `UniqueId`/`sourcedoc` GUID from a share link or drive item via
  Microsoft Graph (`/shares/{id}/driveItem` or `/drives/{id}/items/{id}` with
  `$select=sharepointIds`) — framing the raw `:v:`/`:p:` link is blocked by CSP.
- **Validate** with the repo's own tooling (markdown lint, link check, TOC
  check) and fix what it reports.
- **Respect PR conventions.** Some repos want changes left in the working tree
  until the author explicitly commits; check the repo's `AGENTS.md`/contributing
  guide before staging, committing, or pushing.

## Save the artifacts

Keep `transcript.md`, `chunks.json`, the takeaways, the frame manifest, and the
selected/cropped frames in the user's workspace so the work is reviewable and
re-runnable — not only the final prose.
