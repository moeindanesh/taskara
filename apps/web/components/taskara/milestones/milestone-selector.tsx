'use client';

import { useEffect, useMemo, useState } from 'react';
import { Diamond, Plus } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fa } from '@/lib/fa-copy';
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue } from '@/lib/select-utils';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraMilestone, TaskaraMilestoneListResponse } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { milestoneKindMeta, milestoneStatusMeta } from './primitives';

const CREATE_VALUE = '__create_milestone__';

type MilestoneSelectorOption = Pick<
   TaskaraMilestone,
   'archivedAt' | 'id' | 'kind' | 'name' | 'projectId' | 'status'
>;

export function MilestoneSelector({
   className,
   currentMilestone,
   disabled = false,
   milestones: providedMilestones,
   open,
   placeholder = fa.milestone.selectMilestone,
   projectId,
   value,
   variant = 'field',
   onChange,
   onCreate,
   onOpenChange,
}: {
   className?: string;
   currentMilestone?: MilestoneSelectorOption | null;
   disabled?: boolean;
   milestones?: TaskaraMilestone[];
   open?: boolean;
   placeholder?: string;
   projectId?: string | null;
   value?: string | null;
   variant?: 'field' | 'pill';
   onChange: (milestoneId: string | null) => void | Promise<void>;
   onCreate?: (projectId: string) => void;
   onOpenChange?: (open: boolean) => void;
}) {
   const [loadedMilestones, setLoadedMilestones] = useState<TaskaraMilestone[]>([]);
   const [loading, setLoading] = useState(false);

   useEffect(() => {
      if (providedMilestones || !projectId) {
         setLoadedMilestones([]);
         return;
      }

      let canceled = false;
      setLoading(true);
      const params = new URLSearchParams({
         projectId,
         status: 'PLANNED,ACTIVE',
         limit: '100',
      });
      void taskaraRequest<TaskaraMilestoneListResponse>(`/milestones?${params.toString()}`)
         .then((result) => {
            if (!canceled) setLoadedMilestones(result.items);
         })
         .catch(() => {
            if (!canceled) setLoadedMilestones([]);
         })
         .finally(() => {
            if (!canceled) setLoading(false);
         });

      return () => {
         canceled = true;
      };
   }, [projectId, providedMilestones]);

   const options = useMemo(() => {
      const pool = (providedMilestones || loadedMilestones).filter(
         (milestone) =>
            milestone.projectId === projectId &&
            !milestone.archivedAt &&
            (milestone.status === 'PLANNED' || milestone.status === 'ACTIVE')
      );
      if (currentMilestone && !pool.some((milestone) => milestone.id === currentMilestone.id)) {
         return [currentMilestone, ...pool];
      }
      return pool;
   }, [currentMilestone, loadedMilestones, projectId, providedMilestones]);

   function handleValueChange(nextValue: string) {
      if (nextValue === CREATE_VALUE) {
         if (!projectId) return;
         if (onCreate) onCreate(projectId);
         else {
            window.dispatchEvent(
               new CustomEvent('taskara:create-milestone', {
                  detail: { projectId },
               })
            );
         }
         return;
      }
      void onChange(fromSelectValue(nextValue) || null);
   }

   return (
      <Select
         disabled={disabled || !projectId}
         open={open}
         value={toSelectValue(value || '')}
         onValueChange={handleValueChange}
         onOpenChange={onOpenChange}
      >
         <SelectTrigger
            aria-label={fa.milestone.title}
            className={cn(
               variant === 'pill'
                  ? 'h-7 w-auto min-w-28 rounded-full border-border/70 bg-muted/55 px-2.5 text-xs text-foreground'
                  : 'h-9 w-full rounded-md border-border/70 bg-card text-sm text-foreground',
               className
            )}
         >
            <SelectValue placeholder={loading ? fa.app.loading : placeholder} />
         </SelectTrigger>
         <SelectContent className="max-h-80 rounded-xl border-border bg-popover p-1.5 text-popover-foreground [direction:rtl]">
            <SelectItem className="rounded-lg" value={EMPTY_SELECT_VALUE}>
               <span className="flex items-center gap-2 text-muted-foreground">
                  <span className="inline-flex size-5 items-center justify-center rounded border border-dashed border-border">
                     <Diamond className="size-3" />
                  </span>
                  {fa.milestone.noMilestone}
               </span>
            </SelectItem>
            {options.map((milestone) => {
               const kind = milestoneKindMeta[milestone.kind];
               const status = milestoneStatusMeta[milestone.status];
               const KindIcon = kind.icon;
               return (
                  <SelectItem className="rounded-lg" key={milestone.id} value={milestone.id}>
                     <span className="flex min-w-0 items-center gap-2">
                        <KindIcon className="size-3.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
                        <span className="truncate">{milestone.name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{status.label}</span>
                     </span>
                  </SelectItem>
               );
            })}
            <SelectItem className="mt-1 rounded-lg border-t border-border/60 pt-2 text-indigo-500 dark:text-indigo-200" value={CREATE_VALUE}>
               <span className="flex items-center gap-2">
                  <Plus className="size-3.5" />
                  {fa.milestone.create}
               </span>
            </SelectItem>
         </SelectContent>
      </Select>
   );
}
