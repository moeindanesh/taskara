import { editorValueToPlainText } from '@/lib/task-text-ai';
import type { TaskaraTaskKind } from '@/lib/taskara-types';
import { isEffort } from '@/lib/work-tasks';

/**
 * Whether the web only reads this task's body.
 *
 * A work Task's description is prose: one person writes it, once, and the rich-text editor is the
 * right surface for it. An **Effort**'s body is not prose — it is a document with a contract. The
 * Destination, the Notes and the Decisions-so-far index are sections other tools parse, and it is
 * maintained by the sessions working the effort rather than typed by a human. Handing it to an
 * editor that serialises its own state on save replaces the markdown with the editor's JSON: 70
 * characters became 1,396 on one keystroke, measured on a real row
 * (https://github.com/moeindanesh/taskara/issues/35). Nothing is lost — the markdown is wrapped
 * rather than parsed, so `## Heading` survives inside the JSON as the text `"## Heading"` — but the
 * CLI, an agent and the API all get JSON where they expected markdown, and the Decisions-so-far
 * index stops being readable.
 *
 * So the answer to «should the web edit an Effort's body at all» is no, and read-only is the whole
 * fix rather than a smaller one. Two reasons beyond the format:
 *
 * - The page holds a snapshot that cannot refresh. Efforts are kept out of the client task cache
 *   and the sync stream it rides on (#34), so the issue page's copy of an Effort is a direct read
 *   frozen at load, and its `version` never advances. A body rewrite must carry the version it was
 *   based on (#48), so a hand edit made minutes after the page loaded is a 409 by construction.
 * - The body is written by whole-document rewrite. A human editing one section by hand, mid-session,
 *   against a stale base is exactly the write #48 exists to refuse.
 *
 * The test is `kind`, through `isEffort`, and never the shape of the body. An empty description is
 * not an effort and a JSON one is not either — a work Task whose description somebody pasted JSON
 * into is still work, and still editable.
 */
export function isBodyReadOnly(task: { kind?: TaskaraTaskKind | null }): boolean {
   return isEffort(task);
}

/**
 * Whether a stored body is the editor's serialised document rather than the text somebody wrote.
 *
 * Read-only stops the next conversion; it does not undo the ones already written. A body that went
 * through the editor before this existed still sits in its column as JSON, so the surface has to be
 * able to say so and offer the text back.
 *
 * The test is deliberately narrower than «parses as JSON with a `root`». A map body may hold a
 * fenced JSON block, and `root` is an ordinary English word that any document could use as a key —
 * so the recogniser demands the shape the editor actually emits: a `root` object typed `root` with
 * an array of children. Getting this wrong is not a cosmetic miss. The recovery walk returns the
 * text it finds and nothing else, so mistaking `{"root":"see the Destination section"}` for a
 * document would recover the empty string and offer to write it over the body.
 */
export function isEditorBody(value: string | null | undefined): boolean {
   const source = value?.trim();
   if (!source || !source.startsWith('{')) return false;

   try {
      const parsed = JSON.parse(source) as { root?: { type?: unknown; children?: unknown } };
      const root = parsed?.root;
      return (
         !!root && typeof root === 'object' && root.type === 'root' && Array.isArray(root.children)
      );
   } catch {
      return false;
   }
}

/**
 * The text of a body, recovering it when the editor has already converted it.
 *
 * Named for the body and not for the Effort that needed it first: #55 gave the comment thread the
 * same problem. A comment carrying mention nodes now notifies the person it names, and the surface
 * that renders comments as plain text would otherwise show that person the whole serialised
 * document. One recogniser and one walk serve both.
 *
 * The conversion wrapped the markdown instead of parsing it, so every character the author typed is
 * still in the document as node text — `## Heading` sits there as the string `"## Heading"`. Walking
 * the tree and joining the text puts the markdown back. That is why the damage this ticket is about
 * is a format catastrophe and not a data-loss one.
 *
 * Two things the round-trip does not promise, both from the walk that recovers it:
 * three or more consecutive blank lines collapse to one, and leading and trailing whitespace is
 * trimmed. Neither changes a line of content, and neither is worth a second serialiser to avoid.
 *
 * Anything that is not the editor's own document comes back byte-identical, including a body that
 * merely parses as JSON — see `isEditorBody`.
 */
export function bodyText(value: string | null | undefined): string {
   const source = value ?? '';
   return isEditorBody(source) ? editorValueToPlainText(source) : source;
}

/**
 * An AI suggestion with the halves that would overwrite the body removed.
 *
 * The editor is the loud way the web rewrites a body; the AI panel is the quiet one, and it is
 * worse. A conversion wraps the markdown and is recoverable — a paraphrase is not. Nothing should
 * offer to replace an Effort's Decisions-so-far index with a tidier version of it.
 *
 * The suppression happens where the suggestion is received rather than where the button is drawn,
 * because «اعمال همه پیشنهادها» sends both halves and a suggestion that is merely unrendered still
 * arrives at the apply as `null` — which the patch reads as «clear the body». Removing the offer
 * and refusing the write are two guards for one rule, and both are here on purpose.
 *
 * Work is handed back its own object, so a suggestion keeps its identity through the common path.
 */
export function withoutBodyRewrite<
   T extends { descriptionSuggestion: string | null; summarySuggestion: string | null },
>(suggestion: T, task: { kind?: TaskaraTaskKind | null }): T {
   if (!isBodyReadOnly(task)) return suggestion;
   return { ...suggestion, descriptionSuggestion: null, summarySuggestion: null };
}
