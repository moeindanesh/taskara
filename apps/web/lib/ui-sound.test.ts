import { describe, expect, test } from 'bun:test';
import { isTaskArrivalSoundSuppressed, suppressTaskArrivalSound } from './ui-sound';

describe('task arrival suppression', () => {
   test('silences arrivals for the window after a create, then lets them through again', () => {
      suppressTaskArrivalSound(1500, 10_000);

      expect(isTaskArrivalSoundSuppressed(10_000)).toBe(true);
      expect(isTaskArrivalSoundSuppressed(11_400)).toBe(true);
      expect(isTaskArrivalSoundSuppressed(11_500)).toBe(false);
      expect(isTaskArrivalSoundSuppressed(20_000)).toBe(false);
   });

   test('a later create extends the window rather than being ignored', () => {
      suppressTaskArrivalSound(1000, 50_000);
      suppressTaskArrivalSound(1000, 50_500);

      expect(isTaskArrivalSoundSuppressed(51_000)).toBe(true);
      expect(isTaskArrivalSoundSuppressed(51_500)).toBe(false);
   });

   test('is not suppressed before anything has been created', () => {
      // Far past any window opened by the tests above.
      expect(isTaskArrivalSoundSuppressed(9_000_000)).toBe(false);
   });
});
