/**
 * What in a body looks like an attempt to address a person — and never does.
 *
 * An @-mention in Taskara is a **mention node** in a rich-text body. The server reads those nodes
 * and nothing else, so a markdown body — which is every body this surface sends — notifies nobody,
 * whatever it says. #53 settled that this stays true: a text spelling would be a second addressing
 * form that only one client can write and no client renders.
 *
 * So this module exists to end the *silence*, not the rule. A body that reads as if it addressed
 * somebody gets said back to the caller, who can then reach the person by a means that works.
 *
 * Which means differs by body, and that is `MentionedBody` below. A description's nodes are written
 * by a human in the web editor's autocomplete; a comment's are written by nothing at all, because
 * #56 keeps `TaskComment.body` plain text and the editor is mounted on descriptions only. Telling a
 * session «the web editor writes those» about a comment would be a true-sounding sentence that
 * sends it to ask a colleague for something the colleague cannot do either.
 *
 * The bar for firing is deliberately high. A warning that goes off on `@types/node` is one a caller
 * learns to ignore, and an ignored warning is worse than none — it costs a line of stderr on every
 * write and still lets the real case through. So code spans are removed before looking, an `@`
 * glued to the end of a word is an address rather than a handle, and a scoped package name is not a
 * person.
 */

/**
 * A handle: `@` at a word boundary, then a name, optionally an address.
 *
 * The lookbehind is what tells `@robin` from `robin@example.test` — a plain email in prose is not
 * somebody being addressed, it is a line of text with an address in it, and the reflog's `HEAD@{1}`
 * is not even that. `/` excludes a URL's `…/@robin`; the scoped-package case is the character
 * *after* the match and is checked below.
 */
const MENTION_PATTERN = /(?<![\w@/])@([A-Za-z][\w.+-]*(?:@[A-Za-z0-9][\w-]*(?:\.[A-Za-z0-9][\w-]*)+)?)/g;

/** ```lang … ``` and ~~~ … ~~~, closed or left open by a truncated paste. */
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^[ \t]*\1[^\n]*$|[\s\S]*$)/gm;
const INLINE_CODE = /`[^`\n]*`/g;

/** Every distinct handle the body appears to address, in the order it first writes them. */
export function findMentionAttempts(body: string | null | undefined): string[] {
  if (!body || !body.includes('@')) return [];
  // A body that came back from `task view` is Lexical JSON, and its mention nodes carry their own
  // `@Sara` text. Those mentions work. Warning about them would be false, and a caller acting on it
  // would strip a live mention out of a body it was only appending to.
  if (isSerializedEditorValue(body)) return [];

  const prose = body.replace(FENCED_BLOCK, '').replace(INLINE_CODE, '');
  const found = new Set<string>();

  for (const match of prose.matchAll(MENTION_PATTERN)) {
    // `@types/node`, `@taskara/db`: a scope, not a colleague.
    if (prose[match.index + match[0].length] === '/') continue;
    // A sentence ends in a full stop and a handle does not, but `@robin.example` is one name.
    const handle = match[1].replace(/[.+-]+$/, '');
    if (handle) found.add(`@${handle}`);
  }

  return [...found];
}

/**
 * Which of a Task's two bodies a write is landing in.
 *
 * They are the same rule and they do **not** have the same explanation, which is the whole reason
 * this argument exists rather than a default. A description has a writer — a human picking a
 * colleague out of the web editor's autocomplete — so a caller told «you cannot, the web can» has
 * somewhere to send the request. A comment has none: the web comment box is a plain `<textarea>`
 * and the mention-capable editor is mounted on descriptions only (#56). Naming the same writer
 * there would send a session to ask a human for something no human can do.
 *
 * `'description'` covers `task create --body` and `task edit --body`, which both write
 * `Task.description`. It is spelled for the field and not for the verb so that a fourth writing
 * surface has to answer the question rather than inherit an answer.
 */
export type MentionedBody = 'description' | 'comment';

/**
 * The line a writing surface says back when a body reads as if it addressed somebody.
 *
 * It names the handles rather than only stating the rule, for two reasons: a true one is
 * actionable — the caller sees exactly who is still waiting to be told — and a false one is
 * obvious, because `@media` in the list reads as the misfire it is instead of leaving the caller
 * hunting a body for a mention that was never there.
 *
 * `reach` is the caller's, because the two shells over this core do not spell the same act the same
 * way: the CLI takes an email on `--add-assignee` while MCP's `assigneeId` is a uuid (#49). One
 * rule, and each surface names verbs its own caller can actually type.
 *
 * `into` is the body's, for the reason on `MentionedBody`. The rule is identical in both — nodes,
 * never a spelling — and only the sentence explaining *who could have written one* differs, so both
 * sentences live here and neither shell composes its own.
 */
export function mentionNotice(
  body: string | null | undefined,
  reach: string,
  into: MentionedBody
): string | undefined {
  const attempts = findMentionAttempts(body);
  if (!attempts.length) return undefined;

  const shown = attempts.slice(0, 3).join(', ');
  const rest = attempts.length - 3;
  const listed = rest > 0 ? `${shown} and ${rest} more` : shown;

  const reads = attempts.length === 1 ? 'looks like a mention' : 'look like mentions';
  const rule =
    into === 'comment'
      // Not «and a markdown body carries none», which would read as a limit of this surface. The
      // limit is Taskara's: the rule notifies correctly and nothing can trigger it, so the honest
      // thing to say is that there is no writer at all rather than to point at a better client.
      ? 'a mention is a node and no comment box writes one — the web\'s is plain text too, '
        + 'so a human cannot make one for you.'
      : 'a mention is a node the web editor writes, and a markdown body carries none.';

  return `${listed} ${reads} and notified nobody: ${rule} ${reach}`;
}

function isSerializedEditorValue(body: string): boolean {
  if (!body.trimStart().startsWith('{')) return false;

  try {
    const parsed = JSON.parse(body) as { root?: { type?: unknown; children?: unknown } } | null;
    return Boolean(parsed?.root && parsed.root.type === 'root' && Array.isArray(parsed.root.children));
  } catch {
    return false;
  }
}
