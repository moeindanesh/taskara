import { isValidJalaaliDate, jalaaliToDateObject } from 'jalaali-js';

const dateFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
   year: 'numeric',
   month: 'short',
   day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
   year: 'numeric',
   month: 'short',
   day: 'numeric',
   hour: '2-digit',
   minute: '2-digit',
});

const monthYearFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
   year: 'numeric',
   month: 'long',
});

const dateTimeInputFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
   year: 'numeric',
   month: '2-digit',
   day: '2-digit',
   hour: '2-digit',
   minute: '2-digit',
   hourCycle: 'h23',
});

const persianDigitMap: Record<string, string> = {
   '۰': '0',
   '۱': '1',
   '۲': '2',
   '۳': '3',
   '۴': '4',
   '۵': '5',
   '۶': '6',
   '۷': '7',
   '۸': '8',
   '۹': '9',
   '٠': '0',
   '١': '1',
   '٢': '2',
   '٣': '3',
   '٤': '4',
   '٥': '5',
   '٦': '6',
   '٧': '7',
   '٨': '8',
   '٩': '9',
};

export function formatJalaliDate(value?: string | null): string {
   if (!value) return 'بدون تاریخ';
   return dateFormatter.format(new Date(value));
}

export function formatJalaliDateTime(value?: string | null): string {
   if (!value) return 'بدون تاریخ';
   return dateTimeFormatter.format(new Date(value));
}

export function formatJalaliMonthYear(value?: string | null): string {
   if (!value) return 'بدون تاریخ';
   return monthYearFormatter.format(new Date(value));
}

export function formatJalaliDateTimeInput(value?: string | null): string {
   if (!value) return '';

   const date = new Date(value);
   if (Number.isNaN(date.getTime())) return '';

   const parts = Object.fromEntries(
      dateTimeInputFormatter
         .formatToParts(date)
         .filter((part) => part.type !== 'literal')
         .map((part) => [part.type, part.value])
   );

   return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

export function parseJalaliDateTime(value?: string | null): string | null {
   if (!value?.trim()) return null;

   const normalized = toLatinDigits(value)
      .replace(/[.\-]/g, '/')
      .replace(/[،,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

   const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2}))?)?$/);
   if (!match) return null;

   const [, jyRaw, jmRaw, jdRaw, hourRaw = '0', minuteRaw = '0'] = match;
   const jy = Number(jyRaw);
   const jm = Number(jmRaw);
   const jd = Number(jdRaw);
   const hour = Number(hourRaw);
   const minute = Number(minuteRaw);

   if (
      Number.isNaN(jy) ||
      Number.isNaN(jm) ||
      Number.isNaN(jd) ||
      Number.isNaN(hour) ||
      Number.isNaN(minute) ||
      !isValidJalaaliDate(jy, jm, jd) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
   ) {
      return null;
   }

   const date = jalaaliToDateObject(jy, jm, jd);
   if (Number.isNaN(date.getTime())) return null;

   date.setHours(hour, minute, 0, 0);
   return date.toISOString();
}

export function toDateTimeLocalValue(value?: string | null): string {
   if (!value) return '';
   const date = new Date(value);
   const year = date.getFullYear();
   const month = String(date.getMonth() + 1).padStart(2, '0');
   const day = String(date.getDate()).padStart(2, '0');
   const hours = String(date.getHours()).padStart(2, '0');
   const minutes = String(date.getMinutes()).padStart(2, '0');
   return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function toLatinDigits(value: string): string {
   return value.replace(/[۰-۹٠-٩]/g, (digit) => persianDigitMap[digit] || digit);
}
