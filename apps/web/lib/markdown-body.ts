/**
 * Whether a stored body is markdown, and so should be rendered rather than shown.
 *
 * `Task.description` is two formats in one column — the editor's serialised document when the web
 * wrote it, markdown when the CLI or MCP did (`CONTEXT.md`, «Body»). The editor recognises its own
 * document and loads it; everything else it used to load with `$setPlainTextValue`, one paragraph
 * per line, which is correct for prose and wrong for the half of the column an agent writes: a body
 * imported by `taskara task create` rendered its own `**` and `##` as characters on screen.
 *
 * `docs/adr/0003` named this — «teaching the web editor to parse … markdown … is a new feature with
 * its own fidelity questions» — and refused it as a *storage* answer, because emitting markdown back
 * destroys mention nodes. This is the read half only: the editor still serialises its own document
 * on write, and this decides which of the two loaders a stored body goes to.
 *
 * The recogniser is a set of signals rather than a parse, for the same reason the paste path (which
 * now shares it) uses one: `$convertFromMarkdownString` is not a no-op on text that isn't markdown —
 * it collapses blank lines and joins adjacent ones — so plain prose has to stay on the plain-text
 * loader and reach the screen exactly as it was typed. Every signal below is a construct that only
 * appears in a body someone meant as markdown, and each one is worth acting on alone: a body whose
 * only markup is `- ` is a list, and a body whose only markup is a backtick is quoting an
 * identifier.
 *
 * Italics are deliberately absent. A single `*` or `_` carries no intent — it is punctuation in
 * prose and a wildcard in a path — and it is the one signal that would pull ordinary text onto the
 * markdown loader. Nothing is lost by leaving it out: a body that is markdown at all trips one of
 * the others, and `*emphasis*` is then rendered by the transformer set like everything else.
 */
const markdownSignals = [
   // `# Heading` through `###### Heading`. The space is required, so `#3` and a `#tag` are text.
   /^\s{0,3}#{1,6}\s+\S/m,
   // `> quoted`.
   /^\s{0,3}>\s+\S/m,
   // `- item`, `* item`, `+ item`.
   /^\s{0,3}(?:[-*+])\s+\S/m,
   // `1. item`.
   /^\s{0,3}\d+\.\s+\S/m,
   // `- [ ] item` and `[x] item`.
   /^\s{0,3}(?:[-*+]\s*)?\[(?: |x)\]\s+\S/im,
   // A fence opening a code block.
   /^\s{0,3}```[\w-]*\s*$/m,
   // A thematic break: `---`, `***`, `___`.
   /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m,
   // A table row. A `|` at both ends is the shape; whether it is a table is `parseMarkdownTable`'s
   // question, and a run of pipes that isn't one still renders as the text it is.
   /^\s{0,3}\|.*\|\s*$/m,
   // `[label](target)`, for the targets a description actually links to.
   /\[[^\]\n]+]\((?:https?:\/\/|mailto:|\/|#)[^)]+\)/,
   // `**bold**`, requiring content between the pairs so a row of stars is not one.
   /(^|[^*])\*\*[^*\n][\s\S]*?[^*\n]\*\*/,
   // `~~struck~~`.
   /(^|[^~])~~[^~\n][\s\S]*?[^~\n]~~/,
   // `` `code` ``, on one line. The fence signal above catches the multi-line form first.
   /(^|[^`\n])`[^`\n]+`(?!`)/m,
];

export function hasMarkdownFormatting(value: string | null | undefined): boolean {
   const text = value?.trim() ?? '';
   // Shorter than the shortest thing any signal can match, so no pattern has to defend itself
   // against a one-character body.
   if (text.length < 3) return false;

   return markdownSignals.some((pattern) => pattern.test(text));
}
