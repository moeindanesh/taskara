import { describe, expect, test } from 'bun:test';
import { supportDueLabel } from './support-presenters';
import { formatJalaliDateTime } from './jalali';

describe('Persian Support dates', () => {
   test('renders timestamps with Persian digits and the Jalali calendar', () => {
      const rendered = formatJalaliDateTime('2026-08-23T12:00:00.000Z');
      expect(rendered).toMatch(/[۰-۹]/);
      expect(rendered).not.toContain('2026');
   });

   test('calls out overdue work in Persian relative time', () => {
      expect(supportDueLabel('2026-08-23T10:00:00.000Z', Date.parse('2026-08-23T12:00:00.000Z'))).toBe('۲ ساعت دیرکرد');
   });
});
