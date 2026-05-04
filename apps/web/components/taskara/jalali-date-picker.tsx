'use client';

import { useMemo } from 'react';
import DatePicker from 'react-multi-date-picker';
import type { DateObject } from 'react-multi-date-picker';
import persian from 'react-date-object/calendars/persian';
import persianFa from 'react-date-object/locales/persian_fa';
import TimePicker from 'react-multi-date-picker/plugins/time_picker';
import { CalendarClock, X } from 'lucide-react';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';

export function JalaliDatePicker({
   ariaLabel,
   value,
   onChange,
   showTime = false,
}: {
   ariaLabel: string;
   value?: string | null;
   onChange: (value: string | null) => void;
   showTime?: boolean;
}) {
   const pickerValue = useMemo(() => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
   }, [value]);

   return (
      <div className="flex min-w-0 items-center gap-1">
         <DatePicker
            calendar={persian}
            locale={persianFa}
            value={pickerValue}
            format={showTime ? 'YYYY/MM/DD HH:mm' : 'YYYY/MM/DD'}
            editable={false}
            plugins={showTime ? [<TimePicker key="time-picker" position="bottom" hideSeconds />] : undefined}
            calendarPosition="bottom-right"
            className="taskara-jalali-calendar"
            containerClassName="w-full"
            zIndex={90}
            onChange={(date) => onChange(dateObjectToIso(date, showTime))}
            render={(displayValue, openCalendar) => (
               <button
                  aria-label={ariaLabel}
                  className={cn(
                     'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-white/8 bg-transparent px-3 text-start text-sm outline-none transition hover:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-indigo-400/60',
                     displayValue ? 'text-zinc-300' : 'text-zinc-600'
                  )}
                  type="button"
                  onClick={openCalendar}
               >
                  <span className="truncate">{displayValue || fa.issue.dueAtPlaceholder}</span>
                  <CalendarClock className="size-4 shrink-0 text-zinc-500" />
               </button>
            )}
         />
         {value ? (
            <button
               aria-label={fa.issue.clearDueAt}
               className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/6 hover:text-zinc-200"
               title={fa.issue.clearDueAt}
               type="button"
               onClick={() => onChange(null)}
            >
               <X className="size-4" />
            </button>
         ) : null}
      </div>
   );
}

function dateObjectToIso(date: DateObject | null, showTime: boolean): string | null {
   if (!date?.isValid) return null;
   const jsDate = date.toDate();
   if (Number.isNaN(jsDate.getTime())) return null;
   if (!showTime) jsDate.setHours(0, 0, 0, 0);
   else jsDate.setSeconds(0, 0);
   return jsDate.toISOString();
}
