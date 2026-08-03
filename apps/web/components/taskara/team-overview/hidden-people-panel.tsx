'use client';

import { Eye, EyeOff } from 'lucide-react';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';
import type { HiddenPerson } from './use-team-overview-graph';

export interface HiddenPeoplePanelProps {
   hidden: HiddenPerson[];
   onShowAll: () => void;
   onShowPerson: (userId: string) => void;
}

/**
 * The way back from hiding someone.
 *
 * It only exists while somebody is hidden, and it carries the count on its face: a graph that is
 * quietly missing a third of the team, with nothing on screen saying so, is a graph that lies.
 */
export function HiddenPeoplePanel({ hidden, onShowAll, onShowPerson }: HiddenPeoplePanelProps) {
   if (!hidden.length) return null;

   return (
      <Popover>
         <PopoverTrigger
            aria-label={fa.teamOverview.hiddenPeopleCount(hidden.length)}
            className={cn(
               'inline-flex h-9 items-center gap-1.5 rounded-full border border-white/8 px-3',
               'bg-white/[0.03] text-zinc-500 backdrop-blur-sm transition-all duration-200',
               'hover:bg-white/[0.07] hover:text-zinc-300 data-[state=open]:text-zinc-200'
            )}
            data-testid="hidden-people-trigger"
            title={fa.teamOverview.hiddenPeopleCount(hidden.length)}
            type="button"
         >
            <EyeOff className="size-4" />
            <span className="text-[12px] tabular-nums">{hidden.length.toLocaleString('fa-IR')}</span>
         </PopoverTrigger>

         <PopoverContent
            align="start"
            className="w-72 border-white/10 bg-[#0b0b0c] p-2 text-zinc-100 [direction:rtl]"
            side="top"
         >
            <div className="px-2 pb-1.5 pt-1">
               <p className="text-[12px] text-zinc-300">{fa.teamOverview.hiddenPeople}</p>
               <p className="mt-0.5 text-[10px] leading-4 text-zinc-600">{fa.teamOverview.hiddenPeopleNote}</p>
            </div>

            <div className="max-h-64 overflow-y-auto" data-testid="hidden-people-list">
               {hidden.map((person) => (
                  <button
                     aria-label={fa.teamOverview.showPerson(person.name)}
                     className={cn(
                        'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start transition-colors',
                        'hover:bg-white/[0.06]'
                     )}
                     data-testid="hidden-person-row"
                     data-user-id={person.userId}
                     key={person.userId}
                     onClick={() => onShowPerson(person.userId)}
                     title={fa.teamOverview.showPerson(person.name)}
                     type="button"
                  >
                     <LinearAvatar className="size-6" name={person.name} src={person.avatarUrl} />
                     <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] text-zinc-200">{person.name}</span>
                        <span className="block text-[10px] text-zinc-600">
                           {fa.teamOverview.hiddenPersonLoad(person.taskCount)}
                        </span>
                     </span>
                     <Eye className="size-3.5 shrink-0 text-zinc-600 transition-colors group-hover:text-indigo-300" />
                  </button>
               ))}
            </div>

            {hidden.length > 1 ? (
               <button
                  className="mt-1 w-full rounded-lg border-t border-white/6 px-2 py-2 text-[12px] text-zinc-500 transition-colors hover:text-indigo-300"
                  data-testid="show-all-people"
                  onClick={onShowAll}
                  type="button"
               >
                  {fa.teamOverview.showAllPeople}
               </button>
            ) : null}
         </PopoverContent>
      </Popover>
   );
}
