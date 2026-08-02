# A comment body is plain text, and a comment mention has no writer

`TaskComment.body` stays plain text. Taskara deliberately does **not** adopt one body format across
a Task's two bodies: a description may hold the web editor's serialised document, a comment never
does. The consequence is stated rather than hidden — a mention in a comment notifies correctly and
**nothing can write one**, so the tracker doc, the CLI notice, the MCP tool description and
`CONTEXT.md` all say so in as many words.

## Why

A mention in Taskara is a rich-text **node**, never a spelling (#53). The web editor writes those
nodes into a description; no comment composer writes one anywhere, so the rule #55 shipped — a
comment mention notifies the person it names, subscribes them, and supersedes the ambient
`task_commented` row — is a rule a human cannot trigger. The two obvious ways to give them one are
each closed by a decision this effort already took:

- **Mount the rich editor on the comment box.** `TaskComment.body` becomes Lexical JSON, and every
  non-web reader of that column reads it as text: `taskara task view --comments`, MCP's `task_read`,
  the `GET /tasks/:idOrKey` response and the `commented` sync payload. That is
  [#52](https://github.com/moeindanesh/taskara/issues/52)'s regression verbatim, one field over, and
  it would land in the field an agent reads most.
- **A plain body plus a structured `mentionUserIds`.** A second addressing form alongside the node,
  which [#53](https://github.com/moeindanesh/taskara/issues/53) refused for descriptions and refuses
  here for the same reason: two spellings of one concept in one field, one of which a client renders
  as a chip and the other as nothing at all.

That leaves the honest third question — one body format across both, with a single answer for every
non-web reader. It loses, and not on size.

**Neither direction of "one format" is actually available.**

- *Markdown everywhere* means teaching the web editor to parse and emit markdown instead of
  serialising its own state. #52 left that out on purpose ("teaching anything to parse the markdown
  … is a new feature with its own fidelity questions"), and it has a consequence fatal to the very
  thing this decision is about: **a mention node cannot survive a markdown round trip.** Markdown has
  no spelling for *this run of text is user `<uuid>`*, and inventing one is exactly the text syntax
  #53 refused. The format that would make a comment mention-capable is the one that destroys
  mentions.
- *Lexical JSON everywhere* means the CLI's markdown writes are converted on the way in — the same
  missing parser, now on the write path — and it puts JSON into an **Effort** body, which #52 made
  read-only in the web precisely to keep markdown in that column. The Decisions-so-far index is a
  document other sessions read.

**And the uniformity cannot be bought by normalising on read.** The tempting shortcut is a
server-side `bodyText` applied when a body is serialised out, so every non-web reader sees text
whatever the column holds. It is worse than the problem. #53 relies on the round trip preserving the
editor state — *a session that reads a body with `task view` and writes it back is sending an editor
state, and the mentions in it still fire.* Normalising on read would turn every live mention in a
description into the literal characters `@Sara` the next time an agent appended a line to it. A read
that quietly disarms the writes made through it is not a fix, and it would break real mentions to
tidy up unreachable ones.

**What the field is worth as it stands.** `Task.description` is already two formats in one column:
the editor's JSON when the web wrote it, markdown when the CLI did, and both the CLI and MCP hand
the raw value to an agent. `TaskComment.body` is the one body in Taskara where every reader gets the
characters the writer typed, from every client. Adopting a format spends that and buys no
uniformity, because the description half stays mixed either way.

## Consequences

- **A comment mention is a rule with no writer, and every surface says so.** The sentence a caller
  is given differs by body on purpose: a description's mention names its writer, because it has one
  and a session can hand the request to a human; a comment's says there is none, because pointing at
  "the web editor" there sends a session to ask a human for something no human can do.
- **The notification rule stays** — see below.
- **The web comment box gains no mention affordance**, and no notice either. It is silent rather
  than wrong; the CLI warns because its caller is a machine that must be told the outcome of a write
  it cannot see.
- **This is a declaration, not an API refusal.** `POST /tasks/:idOrKey/comments` still accepts any
  string, so the one client that can send an editor state is not broken and making comment bodies
  rich later remains a real option rather than a migration this decision forced.

## The rule #55 shipped stays, and is not dead code

Worth arguing, because #38's lesson was that dead code is its own hazard: `ActorType.AGENT` had zero
producers and was removed. This is not that.

- **It is not zero-producer.** A comment body that *is* an editor state notifies the people its
  nodes name, and `taskara task comment --body-file -` can send one — proved live against a real API
  in `agent-cli.test.ts`. Undocumented and not recommended, but reachable, and correct when reached.
- **The #38 hazard is code that implies something false.** `ActorType.AGENT` implied agent authorship
  was recorded when provenance actually came from a client header — the enum lied about the system.
  The comment mention path implies *a mention node in a comment notifies*, which is true. What lied
  was the prose around it, and that is what this decision removes.
- **Deleting it would make the two bodies disagree.** The identical node would notify in a
  description and not in a comment, so `CONTEXT.md` would need two definitions of one word — the
  drift #37, #53 and #55 each had to spend a ticket undoing.
- **Deleting it does not even save a test.** You would want one pinning that a comment mention does
  *not* notify: the same hypothetical, spelled negatively, guarding the worse behaviour.
- **It is the half that would have to be rebuilt first.** If the comment box ever becomes rich, this
  is the code that makes it work.

## Considered options

- **Mount the mention-capable editor on the comment box.** The feature everyone wants. Rejected:
  Lexical JSON in `TaskComment.body` for every non-web reader — #52's regression in the field agents
  read most, and the one body field that is currently clean.
- **Plain body plus `mentionUserIds`.** Keeps the column readable. Rejected as #53's second
  addressing form.
- **One body format across descriptions and comments.** The right size of question, and it loses in
  both directions: markdown everywhere destroys mention nodes, JSON everywhere needs a markdown
  parser and re-converts Effort bodies.
- **Normalise bodies to text at the API boundary.** Would give every non-web reader one answer.
  Rejected: it strips live mention nodes from a description on the next round-trip write.
- **Refuse a non-plain-text comment body at the API.** Would make the format structural rather than
  stated. Rejected: it breaks the one client that can write a comment mention today and converts a
  future product decision into a migration, for a guarantee nothing needs.
