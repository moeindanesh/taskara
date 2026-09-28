'use client';

import { useMemo, useState } from 'react';
import { Archive, ChevronLeft, ChevronRight, CloudUpload, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import type { TaskaraMilestone, TaskaraMilestoneStatus } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import {
   formatMilestoneDateOnly,
   isMilestoneOverdue,
   MilestoneProgress,
   milestoneStatusMeta,
   primaryMilestoneAttention,
} from './primitives';

const statuses: TaskaraMilestoneStatus[] = ['ACTIVE', 'PLANNED', 'COMPLETED', 'CANCELED'];
const dayMs = 86_400_000;

export function GoalCollection({
   items, layout, onSelect,
}: {
   items: TaskaraMilestone[];
   layout: 'list' | 'timeline';
   onSelect: (id: string) => void;
}) {
   const [weekOffset, setWeekOffset] = useState(0);
   const windowStart = useMemo(() => {
      const today = new Date();
      return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 7 + weekOffset * 7);
   }, [weekOffset]);
   const windowEnd = windowStart + 42 * dayMs;
   const ticks = Array.from({ length: 7 }, (_, index) => windowStart + index * 7 * dayMs);
   const today = Date.now();
   const todayPosition = (today - windowStart) / (windowEnd - windowStart) * 100;

   return (
      <div>
         {layout === 'timeline' ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3">
               <span className="text-xs text-muted-foreground">
                  {formatMilestoneDateOnly(dateKey(windowStart))} تا {formatMilestoneDateOnly(dateKey(windowEnd))}
               </span>
               <div className="flex items-center gap-1">
                  <Button aria-label="شش هفته قبل" title="شش هفته قبل" size="icon" variant="ghost" className="size-8" onClick={() => setWeekOffset((offset) => offset - 6)}><ChevronRight className="size-4" /></Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setWeekOffset(0)}>امروز</Button>
                  <Button aria-label="شش هفته بعد" title="شش هفته بعد" size="icon" variant="ghost" className="size-8" onClick={() => setWeekOffset((offset) => offset + 6)}><ChevronLeft className="size-4" /></Button>
               </div>
            </div>
         ) : null}
         <div className={cn(layout === 'timeline' && 'overflow-x-auto')}>
            <div className={cn(layout === 'timeline' && 'min-w-[760px]')}>
               <div className={cn(
                  'items-center gap-4 border-b border-border px-3 py-3 text-[11px] text-muted-foreground',
                  layout === 'list' ? 'hidden lg:grid lg:grid-cols-[minmax(200px,1fr)_150px_170px_160px]' : 'grid grid-cols-[240px_minmax(0,1fr)]'
               )}>
                  <span>هدف / پروژه</span>
                  {layout === 'list' ? <><span>{fa.milestone.owner}</span><span>{fa.milestone.targetDate}</span><span>{fa.milestone.progress}</span></> : (
                     <div className="flex justify-between" dir="ltr">
                        {ticks.map((tick) => <span key={tick}>{new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(tick)}</span>)}
                     </div>
                  )}
               </div>
               {statuses.map((status) => {
                  const goals = items.filter((item) => item.status === status);
                  if (!goals.length) return null;
                  const meta = milestoneStatusMeta[status];
                  return (
                     <section key={status} aria-label={meta.label}>
                        <h2 className="flex h-11 items-center gap-2 border-b border-border/60 bg-muted/35 px-3 text-xs font-medium">
                           <meta.icon className="size-3.5" />
                           {meta.label}
                           <span className="text-muted-foreground">{goals.length.toLocaleString('fa-IR')}</span>
                        </h2>
                        {goals.map((goal) => {
                           const attention = primaryMilestoneAttention(goal);
                           const bar = goalTimelinePlacement(goal, windowStart, windowEnd);
                           return (
                              <div key={goal.id} className="border-b border-border/60">
                                 <div role="button" tabIndex={0} aria-label={goal.name}
                                    onClick={() => onSelect(goal.id)}
                                    onKeyDown={(event) => {
                                       if (event.key !== 'Enter' && event.key !== ' ') return;
                                       event.preventDefault();
                                       onSelect(goal.id);
                                    }}
                                    className={cn(
                                    'grid cursor-pointer items-center gap-x-4 gap-y-3 px-3 py-4 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                                    layout === 'list' ? 'grid-cols-2 lg:grid-cols-[minmax(200px,1fr)_150px_170px_160px]' : 'grid-cols-[240px_minmax(0,1fr)]'
                                 )}>
                                    <div className={cn('flex min-w-0 items-start gap-2', layout === 'list' && 'col-span-2 lg:col-span-1')}>
                                       <div className="min-w-0 flex-1 text-start">
                                          <span className="flex items-center gap-2 text-sm font-medium">
                                             <span className="break-words">{goal.name}</span>
                                             {goal.syncState === 'pending' ? <CloudUpload aria-label={fa.sync.mutationQueued} className="size-3.5 shrink-0" /> : null}
                                             {goal.archivedAt ? <Archive aria-label={fa.milestone.archived} className="size-3.5 shrink-0" /> : null}
                                          </span>
                                          <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                                             {goal.project.name}{goal.project.team?.name ? ` · ${goal.project.team.name}` : ''}
                                          </span>
                                       </div>
                                    </div>
                                    {layout === 'list' ? (
                                       <>
                                          <span className="flex min-w-0 items-center gap-2 text-xs" title={fa.milestone.owner}>
                                             {goal.owner ? <LinearAvatar className="size-6 shrink-0" name={goal.owner.name} src={goal.owner.avatarUrl} /> : <UserRound className="size-4 shrink-0 text-muted-foreground" />}
                                             <span className="truncate">{goal.owner?.name || fa.milestone.noOwner}</span>
                                          </span>
                                          <span className="min-w-0 text-xs">
                                             <span className={cn('block', isMilestoneOverdue(goal) && 'text-rose-600 dark:text-rose-400')}>{goal.targetOn ? formatMilestoneDateOnly(goal.targetOn) : fa.milestone.noTarget}</span>
                                             <span className={cn('mt-1 flex items-center gap-1 text-[10px]', attention.tone)}><attention.icon className="size-3 shrink-0" />{attention.label}</span>
                                          </span>
                                          <div className="col-span-2 lg:col-span-1"><MilestoneProgress compact milestone={goal} /></div>
                                       </>
                                    ) : (
                                       <div className="relative h-12" dir="ltr">
                                          {ticks.map((tick, index) => <span key={tick} aria-hidden="true" className="absolute inset-y-0 border-l border-border/60" style={{ left: `${index / 6 * 100}%` }} />)}
                                          {todayPosition >= 0 && todayPosition <= 100 ? <span aria-label="امروز" className="absolute inset-y-0 border-l border-rose-400" style={{ left: `${todayPosition}%` }} /> : null}
                                          {bar ? (
                                             <div
                                                aria-label={`زمان‌بندی ${goal.name}`}
                                                title={`${goal.name}: ${goal.startsOn ? formatMilestoneDateOnly(goal.startsOn) : 'شروع تعیین نشده'} تا ${formatMilestoneDateOnly(goal.targetOn)}`}
                                                className={cn('absolute top-2 h-8 overflow-hidden rounded border px-2 text-[11px] text-start focus-visible:ring-2 focus-visible:ring-ring', meta.className)}
                                                style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                                                dir="rtl"
                                             ><span className="block truncate">{goal.name}</span></div>
                                          ) : (
                                             <div className="absolute inset-y-0 right-2 flex items-center text-[11px] text-muted-foreground" dir="rtl">
                                                {goal.targetOn ? formatMilestoneDateOnly(goal.targetOn) : fa.milestone.noTarget}
                                                {goal.targetOn ? ' · خارج از بازه' : ''}
                                             </div>
                                          )}
                                       </div>
                                    )}
                                 </div>
                              </div>
                           );
                        })}
                     </section>
                  );
               })}
            </div>
         </div>
      </div>
   );
}

export function goalTimelinePlacement(
   goal: Pick<TaskaraMilestone, 'startsOn' | 'targetOn'>,
   windowStart: number,
   windowEnd: number
): { left: number; width: number } | null {
   if (!goal.targetOn || windowEnd <= windowStart) return null;
   const target = Date.parse(`${goal.targetOn}T00:00:00Z`);
   // A target without a start is a one-day marker, never an invented duration.
   const start = goal.startsOn ? Date.parse(`${goal.startsOn}T00:00:00Z`) : target;
   const end = target + dayMs;
   if (!Number.isFinite(start) || !Number.isFinite(end) || end <= windowStart || start >= windowEnd || start >= end) return null;
   const left = Math.max(0, (start - windowStart) / (windowEnd - windowStart) * 100);
   const right = Math.min(100, (end - windowStart) / (windowEnd - windowStart) * 100);
   return { left, width: right - left };
}

function dateKey(timestamp: number) {
   return new Date(timestamp).toISOString().slice(0, 10);
}
