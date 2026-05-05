'use client';

import { lazy, Suspense } from 'react';
import { CalendarClock } from 'lucide-react';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDateTime } from '@/lib/jalali';
import { cn } from '@/lib/utils';

export type JalaliDatePickerProps = {
   ariaLabel: string;
   value?: string | null;
   onChange: (value: string | null) => void;
   showTime?: boolean;
};

const JalaliDatePickerImpl = lazy(() =>
   import('@/components/taskara/jalali-date-picker').then((module) => ({ default: module.JalaliDatePicker }))
);

export function LazyJalaliDatePicker(props: JalaliDatePickerProps) {
   return (
      <Suspense fallback={<JalaliDatePickerFallback ariaLabel={props.ariaLabel} value={props.value} />}>
         <JalaliDatePickerImpl {...props} />
      </Suspense>
   );
}

function JalaliDatePickerFallback({ ariaLabel, value }: Pick<JalaliDatePickerProps, 'ariaLabel' | 'value'>) {
   return (
      <div className="flex min-w-0 items-center gap-1">
         <button
            aria-label={ariaLabel}
            className={cn(
               'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-white/8 bg-transparent px-3 text-start text-sm',
               value ? 'text-zinc-300' : 'text-zinc-600'
            )}
            disabled
            type="button"
         >
            <span className="truncate">{value ? formatJalaliDateTime(value) : fa.issue.dueAtPlaceholder}</span>
            <CalendarClock className="size-4 shrink-0 text-zinc-500" />
         </button>
      </div>
   );
}
