'use client';

import type { ReactNode } from 'react';
import { CalendarClock, XCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { cn } from '@/lib/utils';

export function makeDueDate(daysFromNow: number) {
   const dueDate = new Date();
   dueDate.setDate(dueDate.getDate() + daysFromNow);
   dueDate.setHours(18, 0, 0, 0);
   return dueDate.toISOString();
}

export function makeEndOfIranWorkWeek() {
   const dueDate = new Date();
   const day = dueDate.getDay();
   const daysUntilFriday = (5 - day + 7) % 7 || 7;
   dueDate.setDate(dueDate.getDate() + daysUntilFriday);
   dueDate.setHours(18, 0, 0, 0);
   return dueDate.toISOString();
}

export function TaskDueDateControl({
   dueAt,
   className,
   iconClassName,
   onChange,
}: {
   dueAt?: string | null;
   className?: string;
   iconClassName?: string;
   onChange: (dueAt: string | null) => void;
}) {
   return (
      <Popover>
         <PopoverTrigger asChild>
            <button
               aria-label={fa.issue.dueAt}
               className={cn(
                  'inline-flex h-7 w-40 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs transition hover:border-white/8 hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-indigo-400/50 focus-visible:outline-none',
                  dueAt ? 'text-zinc-400' : 'text-zinc-600',
                  className
               )}
               type="button"
               onClick={(event) => event.stopPropagation()}
               onDoubleClick={(event) => event.stopPropagation()}
            >
               <CalendarClock className={cn('size-3.5 shrink-0', iconClassName)} />
               <span className="min-w-0 flex-1 truncate text-end">{dueAt ? formatJalaliDate(dueAt) : fa.issue.dueAt}</span>
            </button>
         </PopoverTrigger>
         <PopoverContent align="start" className="w-80 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl">
            <DueDateMenuOption
               icon={<CalendarClock className="size-4 text-zinc-400" />}
               label="امروز"
               onClick={() => onChange(makeDueDate(0))}
            />
            <DueDateMenuOption
               icon={<CalendarClock className="size-4 text-zinc-400" />}
               label="فردا"
               onClick={() => onChange(makeDueDate(1))}
            />
            <DueDateMenuOption
               icon={<CalendarClock className="size-4 text-zinc-400" />}
               label="پایان این هفته"
               onClick={() => onChange(makeEndOfIranWorkWeek())}
            />
            <DueDateMenuOption
               icon={<CalendarClock className="size-4 text-zinc-400" />}
               label="یک هفته دیگر"
               onClick={() => onChange(makeDueDate(7))}
            />
            {dueAt ? (
               <DueDateMenuOption
                  icon={<XCircle className="size-4 text-zinc-500" />}
                  label={fa.issue.clearDueAt}
                  onClick={() => onChange(null)}
               />
            ) : null}
            <div className="border-t border-white/8 p-3">
               <div className="mb-2 text-xs font-medium text-zinc-500">{fa.issue.dueAt}</div>
               <LazyJalaliDatePicker ariaLabel={fa.issue.dueAt} value={dueAt || null} onChange={onChange} />
            </div>
         </PopoverContent>
      </Popover>
   );
}

function DueDateMenuOption({
   icon,
   label,
   onClick,
}: {
   icon: ReactNode;
   label: string;
   onClick: () => void;
}) {
   return (
      <button
         className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-zinc-300 outline-none transition hover:bg-white/[0.06] focus:bg-white/[0.08]"
         type="button"
         onClick={onClick}
      >
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className="min-w-0 flex-1 truncate text-start">{label}</span>
      </button>
   );
}
