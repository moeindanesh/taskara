import { describe, expect, test } from 'bun:test';
import { isRedacted, readable } from '@/lib/redacted';

/**
 * The distinction the client has to keep: **absent** and **withheld** are different answers, and
 * only one of them is true when the server sends a placeholder (#58, #60).
 *
 * `readable` collapses both to `null` on purpose — a component reaching for `.name` should get
 * nothing either way — but `isRedacted` has to stay able to tell them apart, because that is what
 * decides between «بدون پروژه» and «پروژه‌ای که دسترسی به آن ندارید». A helper that lost the
 * difference would let every call site quietly state the falsehood.
 */
describe('redacted relations', () => {
   test('a withheld relation reads as no relation, and still says which it is', () => {
      const withheld = { redacted: true } as const;

      expect(readable(withheld)).toBeNull();
      expect(isRedacted(withheld)).toBe(true);
   });

   test('a genuinely absent relation is not reported as withheld', () => {
      expect(readable(null)).toBeNull();
      expect(readable(undefined)).toBeNull();
      expect(isRedacted(null)).toBe(false);
      expect(isRedacted(undefined)).toBe(false);
   });

   test('a relation the reader may open comes back whole', () => {
      const project = { id: 'project-1', name: 'Core', keyPrefix: 'CORE' };

      expect(readable(project)).toBe(project);
      expect(isRedacted(project)).toBe(false);
   });

   test('a falsy `redacted` is not a placeholder', () => {
      expect(isRedacted({ redacted: false })).toBe(false);
      expect(readable({ redacted: false, name: 'Core' })).toEqual({ redacted: false, name: 'Core' });
   });
});
