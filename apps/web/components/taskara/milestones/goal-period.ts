import { jalaaliMonthLength, toGregorian, toJalaali } from 'jalaali-js';
import type { GoalPeriod } from '@/lib/taskara-types';

export const goalPeriodLabels: Record<GoalPeriod, string> = {
   WEEKLY: 'هفتگی',
   MONTHLY: 'ماهانه',
   CUSTOM: 'بازه آزاد',
};
const dayMs = 86_400_000;

/** Team weeks run Saturday–Friday; months follow the Persian calendar in Tehran. */
export function goalPeriodRange(period: GoalPeriod, offset = 0, now = new Date()) {
   const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
   }).format(now);
   const date = new Date(`${today}T00:00:00Z`);
   if (period === 'WEEKLY') {
      const start = date.getTime() - ((date.getUTCDay() + 1) % 7) * dayMs + offset * 7 * dayMs;
      return { startsOn: dateKey(start), targetOn: dateKey(start + 6 * dayMs) };
   }
   if (period === 'MONTHLY') {
      const jalali = toJalaali(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
      const months = jalali.jy * 12 + jalali.jm - 1 + offset;
      const year = Math.floor(months / 12),
         month = (months % 12) + 1;
      const start = toGregorian(year, month, 1);
      const end = toGregorian(year, month, jalaaliMonthLength(year, month));
      return {
         startsOn: dateKey(Date.UTC(start.gy, start.gm - 1, start.gd)),
         targetOn: dateKey(Date.UTC(end.gy, end.gm - 1, end.gd)),
      };
   }
   return { startsOn: '', targetOn: '' };
}
function dateKey(value: number) {
   return new Date(value).toISOString().slice(0, 10);
}
