/**
 * A body written as `\n` and meant as a line break.
 *
 * Every body this toolkit sends inline arrives through a keyhole that cannot carry the thing the
 * writer meant. `--body "a\nb"` is argv, and no shell turns those two characters into a newline
 * inside quotes; an MCP `description` is a string in a JSON-RPC document, and a model that escapes
 * it once for the field and once more for the shell it imagines behind the field sends the two
 * characters as well. Both land in `Task.description` verbatim, and every reader shows them: the web
 * editor renders `**bold**` as bold and `\n\n` as a backslash and an n, the inbox card the same, and
 * `task view` hands the next agent back exactly what the last one broke.
 *
 * So this reads a body the way it was written rather than the way it was quoted. It is the one place
 * in Taskara that stores characters other than the ones it was sent, which is a real cost and the
 * reason the rule below is so much narrower than "replace the escapes".
 *
 * **A file body never comes here.** `--body-file` and stdin are bytes somebody chose, asserted
 * byte-faithful by `agent-cli.test.ts` («--body-file - reads the body from stdin»), and a `\n` in a
 * map body is a code sample quoting one. That is what the name is for: `readInlineBody` cannot be
 * applied to a file body by a caller who has not noticed which of the two it holds.
 *
 * The bar for firing follows `mentions.ts` — «a warning that goes off on `@types/node` is one a
 * caller learns to ignore» — with the stakes raised, because this changes the body rather than
 * remarking on it. Five conditions, and each one is a body that must come back untouched:
 *
 *   - **It is the editor's document, not prose.** One column holds two formats, and in the web's
 *     half a `\n` is JSON's own escape for a newline inside a text node — which is how a code block
 *     serialises, since the editor keeps its lines in one node. Decoding that leaves a string
 *     literal with a raw break in it, and the document stops parsing: `syncEditorValue` falls
 *     through its catch to a plain-text load, and every mention node in the body is gone. The path
 *     is ordinary rather than exotic — `task_view` returns the body, MCP has no file route, so a
 *     session that reads a body and writes it back sends it inline by construction. `mentions.ts`
 *     refuses the same bodies for the neighbouring reason, and this is the sharper version of it:
 *     that module would have said something untrue, this one would have destroyed the document.
 *   - **It already has a line of its own.** A body with a real newline was not flattened by argv,
 *     so the escapes still in it are its subject: a snippet, a sample, a regex.
 *   - **A backslash it did not write.** Every backslash outside a quoted span has to be one of the
 *     breaks about to be decoded. `a\nb\tc` speaks a language with more words than this one knows,
 *     and giving back half of them is worse than giving back none. This is also what makes `\\n` the
 *     in-band way to insist on the characters: the doubled backslash is not part of any break, so
 *     the whole body comes back exactly as written.
 *   - **A backslash under quotes.** `` `\n` `` and `'\n'` are a body *about* the escape, which is a
 *     body this repo writes — the task that would have described this fix is one.
 *   - **A drive letter.** `C:\node` is the one path shape that collides with the rule head-on. A
 *     drive letter is exactly one letter, which is what keeps `اهمیت:\nفوری` — a label, a colon and
 *     a real break — from being read as one.
 *
 * What survives all four and is still wrong is a single line whose only backslash begins an `n`:
 * `\newbuild` in a bare Windows path, say. No structural rule separates that from `line1\nline2`,
 * because there is no structure to separate — which is why `lineBreakNotice` exists and why every
 * caller prints it. The writer is told at the moment of writing, when re-sending costs one command.
 */

import { isSerializedEditorValue } from './types';

/** `\n` and `\r\n` as the characters that reach here: a backslash and a letter, not a break. */
const ESCAPED_BREAK = /\\r\\n|\\n/g;

/** `` `\n` `` — a code span, where a backslash is the subject rather than the syntax. */
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * `'\n'` and `"\n"` — a literal being quoted rather than a phrase being said.
 *
 * Space-free on purpose. A quoted *phrase* is prose and may hold anything, and this must not mask a
 * real break inside one; an apostrophe in `it's the user's` finds no partner across a space either,
 * so ordinary writing never reaches this pattern at all.
 */
const QUOTED_LITERAL = /(['"])(?:(?!\1)\S)*\1/g;

/** `C:\node`, and never `اهمیت:\n` — the single letter is the whole discrimination. */
const WINDOWS_PATH = /(?:^|[^A-Za-z])[A-Za-z]:\\/;

export interface InlineBody {
  /** The characters to send. */
  text: string;
  /** How many line breaks were given back, and 0 when the body is exactly as it arrived. */
  restored: number;
}

/** A body chosen byte by byte — from a file, or from stdin — sent as the bytes it is. */
export function readFileBody(text: string): InlineBody {
  return { text, restored: 0 };
}

/** A body that came through argv or a JSON field, read as the document it was written as. */
export function readInlineBody(text: string): InlineBody {
  if (text.includes('\n') || WINDOWS_PATH.test(text)) return { text, restored: 0 };
  // Asked after the cheap tests and before anything else, because it parses: a body that already
  // holds a real newline is not the editor's single-line document anyway.
  if (isSerializedEditorValue(text)) return { text, restored: 0 };

  const masked = maskQuotedSpans(text);
  const breaks = [...masked.matchAll(ESCAPED_BREAK)];
  if (breaks.length === 0) return { text, restored: 0 };

  const escaped = new Set<number>();
  for (const match of breaks) {
    for (let index = match.index; index < match.index + match[0].length; index += 1) escaped.add(index);
  }
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === '\\' && !escaped.has(index)) return { text, restored: 0 };
  }

  // Rebuilt from the original at the masked copy's offsets, which is why the mask replaces each
  // span with its own length rather than removing it.
  let read = '';
  let cursor = 0;
  for (const match of breaks) {
    read += `${text.slice(cursor, match.index)}\n`;
    cursor = match.index + match[0].length;
  }

  return { text: read + text.slice(cursor), restored: breaks.length };
}

/**
 * The line a writing surface says back when it read a body differently than it received one.
 *
 * Unconditional at every caller, and the reason the rule is allowed to be a heuristic at all. A
 * write that silently reinterprets its input is one nobody can audit; a write that names what it did
 * is one whose rare misfire is a visible line rather than a body quietly rewritten.
 *
 * `reach` is the caller's, as in `mentionNotice`, because the two shells have different ways out. A
 * shell caller has `--body-file -`; a conversation has no file route at all and must be told the
 * field itself carries real breaks, or it will keep escaping them for a shell that is not there.
 */
export function lineBreakNotice(body: InlineBody | undefined, reach: string): string | undefined {
  if (!body?.restored) return undefined;

  const counted =
    body.restored === 1 ? 'One \\n was read as a line break' : `${body.restored} \\n were read as line breaks`;
  return `${counted}, because a body that reaches here escaped cannot carry one. `
    + `Double the backslash to keep the characters instead. ${reach}`;
}

function maskQuotedSpans(text: string): string {
  const blank = (match: string) => 'x'.repeat(match.length);
  // Code spans first: a span may quote a quote, and the outer construct is the one that decides.
  return text.replace(INLINE_CODE, blank).replace(QUOTED_LITERAL, blank);
}
