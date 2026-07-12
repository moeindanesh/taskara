'use client';

import { useMemo } from 'react';
import DatePicker from 'react-multi-date-picker';
import type { DateObject } from 'react-multi-date-picker';
import persian from 'react-date-object/calendars/persian';
import persianFa from 'react-date-object/locales/persian_fa';
import { CalendarDays, X } from 'lucide-react';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';

export function MilestoneDatePicker({
   ariaLabel,
   disabled = false,
   placeholder,
   value,
   onChange,
}: {
   ariaLabel: string;
   disabled?: boolean;
   placeholder?: string;
   value?: string | null;
   onChange: (value: string | null) => void;
}) {
   const pickerValue = useMemo(() => dateOnlyToLocalDate(value), [value]);

   return (
      <div className="flex min-w-0 items-center gap-1">
         <DatePicker
            calendar={persian}
            calendarPosition="bottom-right"
            className="taskara-jalali-calendar"
            containerClassName="w-full"
            disabled={disabled}
            editable={false}
            format="YYYY/MM/DD"
            locale={persianFa}
            portal
            value={pickerValue}
            zIndex={90}
            onChange={(date) => onChange(dateObjectToDateOnly(date))}
            render={(displayValue, openCalendar) => (
               <button
                  aria-label={ariaLabel}
                  className={cn(
                     'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border/70 bg-card px-3 text-start text-sm outline-none transition hover:bg-muted focus-visible:border-indigo-400/70 focus-visible:ring-2 focus-visible:ring-indigo-400/30 disabled:cursor-not-allowed disabled:opacity-50',
                     displayValue ? 'text-foreground' : 'text-muted-foreground'
                  )}
                  disabled={disabled}
                  type="button"
                  onClick={openCalendar}
               >
                  <span className="truncate">{displayValue || placeholder || fa.app.noDate}</span>
                  <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
               </button>
            )}
         />
         {value ? (
            <button
               aria-label={`${fa.app.cancel} ${ariaLabel}`}
               className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
               disabled={disabled}
               title={`${fa.app.cancel} ${ariaLabel}`}
               type="button"
               onClick={() => onChange(null)}
            >
               <X className="size-4" />
            </button>
         ) : null}
      </div>
   );
}

function dateOnlyToLocalDate(value?: string | null): Date | null {
   if (!value) return null;
   const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
   if (!match) return null;
   const year = Number(match[1]);
   const month = Number(match[2]);
   const day = Number(match[3]);
   const date = new Date(year, month - 1, day, 12, 0, 0, 0);
   if (
      Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
   ) {
      return null;
   }
   return date;
}

function dateObjectToDateOnly(date: DateObject | null): string | null {
   if (!date?.isValid) return null;
   const localDate = date.toDate();
   if (Number.isNaN(localDate.getTime())) return null;
   const year = String(localDate.getFullYear()).padStart(4, '0');
   const month = String(localDate.getMonth() + 1).padStart(2, '0');
   const day = String(localDate.getDate()).padStart(2, '0');
   return `${year}-${month}-${day}`;
}
