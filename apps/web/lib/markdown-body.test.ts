import { describe, expect, test } from 'bun:test';
import { hasMarkdownFormatting } from './markdown-body';

/**
 * A body as an agent files one, copied from the description an import put on screen as characters.
 *
 * The document this fix is about is not a markdown sampler — it is Persian prose with a bold lead on
 * every paragraph, identifiers in backticks and a rule before the footer, and every one of those was
 * rendered as its own syntax. Keeping the real shape here is what makes the plain-prose cases below
 * mean something: the two have to land on different loaders.
 */
const importedBody = [
   '**مشکل:** interceptor مقدار `{success:true, queued:true}` را مثل یک پاسخ ۲۰۰ عادی resolve می‌کند.',
   '',
   '**تغییر:** در `hooks/client.ts:166` با خطای نوع‌دار `OfflineQueuedError` رد شود.',
   '',
   '---',
   '',
   'منبع: `mobile/docs/MOBILE_AUDIT_2026-08-03.md`',
].join('\n');

describe('a body written as markdown', () => {
   test('the imported body that prompted this is markdown', () => {
      expect(hasMarkdownFormatting(importedBody)).toBe(true);
   });

   test('each construct is enough on its own', () => {
      expect(hasMarkdownFormatting('## Destination')).toBe(true);
      expect(hasMarkdownFormatting('> a quoted line')).toBe(true);
      expect(hasMarkdownFormatting('- one\n- two')).toBe(true);
      expect(hasMarkdownFormatting('1. one\n2. two')).toBe(true);
      expect(hasMarkdownFormatting('- [ ] not yet\n- [x] done')).toBe(true);
      expect(hasMarkdownFormatting('```ts\nconst a = 1;\n```')).toBe(true);
      expect(hasMarkdownFormatting('above\n\n---\n\nbelow')).toBe(true);
      expect(hasMarkdownFormatting('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true);
      expect(hasMarkdownFormatting('see [the ticket](https://example.test/1)')).toBe(true);
      expect(hasMarkdownFormatting('a **bold** lead')).toBe(true);
      expect(hasMarkdownFormatting('~~withdrawn~~ and replaced')).toBe(true);
      expect(hasMarkdownFormatting('run `bun run test:web` first')).toBe(true);
   });

   test('a single line counts, because a stored body is not a pasted snippet', () => {
      // The paste path wants two lines before it restructures a document somebody is typing into.
      // A body arrives whole, so a one-line `**مشکل:** …` is the entire document and renders.
      expect(hasMarkdownFormatting('**مشکل:** پاسخ صف مثل پاسخ سرور خوانده می‌شود')).toBe(true);
   });
});

describe('a body that is prose', () => {
   test('prose stays on the loader that reproduces it exactly', () => {
      expect(hasMarkdownFormatting('یک توضیح ساده در یک پاراگراف.')).toBe(false);
      expect(hasMarkdownFormatting('Two lines of plain text.\nThe second one.')).toBe(false);
      expect(hasMarkdownFormatting('')).toBe(false);
      expect(hasMarkdownFormatting(null)).toBe(false);
      expect(hasMarkdownFormatting(undefined)).toBe(false);
   });

   test('punctuation that resembles markup is not markup', () => {
      // `#` without a space, a bare `*`, a decimal, and a lone underscore in a path — the four ways
      // ordinary text brushes against the syntax. Each would restructure a body if it counted.
      expect(hasMarkdownFormatting('بلاک کننده #3 هنوز باز است')).toBe(false);
      expect(hasMarkdownFormatting('rate is 99.9% * headroom')).toBe(false);
      expect(hasMarkdownFormatting('نسخه 1.2 منتشر شد')).toBe(false);
      expect(hasMarkdownFormatting('the file is apps/web/lib/task_text_ai.ts')).toBe(false);
   });

   test('emphasis alone is not a signal', () => {
      // Deliberate: `*` is punctuation more often than it is markup, and a body that is markdown at
      // all trips another signal. This one is about what does *not* move prose onto the parser.
      expect(hasMarkdownFormatting('a *starred* word')).toBe(false);
   });
});
