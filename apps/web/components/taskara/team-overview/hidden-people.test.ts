import { describe, expect, test } from 'bun:test';
import { parseHiddenPeople, withHiddenPeople } from './hidden-people';

describe('parseHiddenPeople', () => {
   test('reads a workspace back as the set of people that were hidden', () => {
      expect(parseHiddenPeople('{"avantech":["user-a","user-b"]}')).toEqual({ avantech: ['user-a', 'user-b'] });
   });

   test('treats missing, malformed and foreign values as nobody hidden', () => {
      expect(parseHiddenPeople(null)).toEqual({});
      expect(parseHiddenPeople('')).toEqual({});
      expect(parseHiddenPeople('not json')).toEqual({});
      expect(parseHiddenPeople('["user-a"]')).toEqual({});
      expect(parseHiddenPeople('"user-a"')).toEqual({});
   });

   test('drops entries that are not lists of ids rather than failing the whole read', () => {
      expect(parseHiddenPeople('{"avantech":["user-a",3,null,""],"other":"user-b","empty":[]}')).toEqual({
         avantech: ['user-a'],
      });
   });
});

describe('withHiddenPeople', () => {
   test('keeps other workspaces untouched', () => {
      const stored = { avantech: ['user-a'], dastak: ['user-b'] };

      expect(withHiddenPeople(stored, 'avantech', new Set(['user-c']))).toEqual({
         avantech: ['user-c'],
         dastak: ['user-b'],
      });
   });

   test('forgets a workspace once nobody there is hidden, so the record does not accumulate', () => {
      expect(withHiddenPeople({ avantech: ['user-a'], dastak: ['user-b'] }, 'avantech', new Set())).toEqual({
         dastak: ['user-b'],
      });
   });

   test('does not mutate what it was given', () => {
      const stored = { avantech: ['user-a'] };
      withHiddenPeople(stored, 'avantech', new Set(['user-a', 'user-b']));

      expect(stored).toEqual({ avantech: ['user-a'] });
   });
});
