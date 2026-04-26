const oneDay = 24 * 60 * 60 * 1000;

export function parseHumanDueDate(input: string): Date | null {
  const value = input.trim().toLowerCase();
  const now = new Date();

  if (['today', 'امروز'].includes(value)) return endOfLocalDay(now);
  if (['tomorrow', 'فردا'].includes(value)) return endOfLocalDay(new Date(now.getTime() + oneDay));
  if (['day-after-tomorrow', 'پسفردا', 'پس‌فردا'].includes(value)) return endOfLocalDay(new Date(now.getTime() + 2 * oneDay));

  const daysMatch = value.match(/^(?:in\s*)?(\d+)\s*(?:d|day|days|روز)$/);
  if (daysMatch) return endOfLocalDay(new Date(now.getTime() + Number(daysMatch[1]) * oneDay));

  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  return null;
}

function endOfLocalDay(date: Date): Date {
  const due = new Date(date);
  due.setHours(23, 59, 59, 999);
  return due;
}
