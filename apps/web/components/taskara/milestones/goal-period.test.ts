import { describe, expect, test } from 'bun:test';
import { goalPeriodRange } from './goal-period';

describe('team goal planning periods', () => {
   test('uses Saturday through Friday and the Tehran day near midnight', () => {
      expect(goalPeriodRange('WEEKLY', 0, new Date('2026-10-16T21:00:00Z'))).toEqual({
         startsOn: '2026-10-17',
         targetOn: '2026-10-23',
      });
      expect(goalPeriodRange('WEEKLY', -1, new Date('2026-10-17T09:00:00Z'))).toEqual({
         startsOn: '2026-10-10',
         targetOn: '2026-10-16',
      });
   });
   test('uses Jalali month boundaries, including leap Esfand and year rollover', () => {
      expect(goalPeriodRange('MONTHLY', 0, new Date('2025-03-10T12:00:00Z'))).toEqual({
         startsOn: '2025-02-19',
         targetOn: '2025-03-20',
      });
      expect(goalPeriodRange('MONTHLY', 1, new Date('2025-03-10T12:00:00Z'))).toEqual({
         startsOn: '2025-03-21',
         targetOn: '2025-04-20',
      });
   });
});
