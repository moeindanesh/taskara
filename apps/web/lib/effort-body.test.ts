import { describe, expect, test } from 'bun:test';
import type { TaskaraTask } from '@/lib/taskara-types';
import { editorValueToPlainText } from '@/lib/task-text-ai';
import { effortBodyText, isBodyReadOnly, isEditorBody } from './effort-body';

/**
 * The body of `TKR-35` as the editor left it, copied out of the workspace it was measured in.
 *
 * This is the artifact the ticket is about rather than a hand-built imitation of one: a short
 * markdown body, one keystroke («ZZTOP») typed into the description, 1,396 characters of editor
 * JSON written back — the conversion measured in
 * https://github.com/moeindanesh/taskara/issues/35. Recovering it is the round-trip the fix has to
 * guarantee, so the fixture is the real column value rather than a shape resembling it.
 */
const convertedBody = '{"root":{"children":[{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"## Heading","type":"text","version":1}],"direction":"ltr","format":"","indent":0,"type":"paragraph","version":1,"textFormat":0,"textStyle":""},{"children":[],"direction":"rtl","format":"","indent":0,"type":"paragraph","version":1,"textFormat":0,"textStyle":""},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"A paragraph with **bold**.","type":"text","version":1}],"direction":"ltr","format":"","indent":0,"type":"paragraph","version":1,"textFormat":0,"textStyle":""},{"children":[],"direction":"rtl","format":"","indent":0,"type":"paragraph","version":1,"textFormat":0,"textStyle":""},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"- one","type":"text","version":1}],"direction":"ltr","format":"","indent":0,"type":"paragraph","version":1,"textFormat":0,"textStyle":""},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"- two","type":"text","version":1}],"direction":"ltr","format":"","indent":0,"type":"paragraph","version":1,"textFormat":0,"textStyle":""},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"ZZTOP","type":"text","version":1}],"direction":"ltr","format":"","indent":0,"type":"paragraph","version":1,"textFormat":0,"textStyle":""}],"direction":null,"format":"","indent":0,"type":"root","version":1}}';

const mapBody = [
   '## Destination',
   '',
   'Taskara is the issue tracker for agent-driven engineering work.',
   '',
   '## Decisions so far',
   '',
   '- [An earlier ticket](https://example.test/1) — settled.',
   '',
].join('\n');

describe('who writes a task body', () => {
   test('an effort body is not written from the web', () => {
      expect(isBodyReadOnly(task({ kind: 'EFFORT' }))).toBe(true);
   });

   test('a work body is', () => {
      expect(isBodyReadOnly(task({ kind: 'WORK' }))).toBe(false);
   });
});

describe('recognising a body the editor has already converted', () => {
   test('the measured conversion is recognised', () => {
      expect(isEditorBody(convertedBody)).toBe(true);
   });

   test('a markdown body is not, however it starts', () => {
      expect(isEditorBody(mapBody)).toBe(false);
      expect(isEditorBody('{ this is a brace, not a document }')).toBe(false);
      expect(isEditorBody('')).toBe(false);
      expect(isEditorBody(null)).toBe(false);
   });

   test('a body that merely parses as JSON is not an editor document', () => {
      // A map may well hold a fenced JSON block, and a `root` key is a word before it is a node.
      expect(isEditorBody('{"root":"see the Destination section"}')).toBe(false);
      expect(isEditorBody('{"schema":{"root":{"type":"root"}}}')).toBe(false);
      expect(isEditorBody('[1, 2, 3]')).toBe(false);
   });
});

describe('recovering a converted body', () => {
   test('the measured conversion comes back as the markdown that went in', () => {
      expect(effortBodyText(convertedBody)).toBe(
         ['## Heading', '', 'A paragraph with **bold**.', '', '- one', '- two', 'ZZTOP'].join('\n')
      );
   });

   test('a body the editor never touched is returned exactly as stored', () => {
      expect(effortBodyText(mapBody)).toBe(mapBody);
   });

   test('an empty body is empty rather than absent', () => {
      expect(effortBodyText(null)).toBe('');
      expect(effortBodyText('')).toBe('');
   });

   test('a body that only looks like a document is never walked for text', () => {
      // The walk returns the text it finds and nothing else, so a `root` that is a string recovers
      // to «» — and offering to write that over a map is worse than showing the JSON.
      const decoy = '{"root":"see the Destination section"}';

      expect(editorValueToPlainText(decoy)).toBe('');
      expect(effortBodyText(decoy)).toBe(decoy);
   });
});

function task(overrides: Partial<TaskaraTask>): TaskaraTask {
   return {
      id: 'task-1',
      key: 'CORE-1',
      title: 'Task',
      status: 'TODO',
      priority: 'NO_PRIORITY',
      ...overrides,
   };
}
