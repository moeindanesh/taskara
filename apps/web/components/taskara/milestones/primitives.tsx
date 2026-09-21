'use client';

import type { ComponentType, ReactNode } from 'react';
import {
   AlertTriangle,
   CalendarDays,
   Check,
   CheckCircle2,
   CircleDot,
   Target,
   Flag,
   Layers3,
   PauseCircle,
   ShieldAlert,
   Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fa } from '@/lib/fa-copy';
import type {
   TaskaraMilestone,
   TaskaraMilestoneHealth,
   TaskaraMilestoneKind,
   TaskaraMilestoneStatus,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

type IconType = ComponentType<{ className?: string }>;

export const milestoneKindMeta: Record<
   TaskaraMilestoneKind,
   { label: string; icon: IconType; className: string }
> = {
   FEATURE: {
      label: fa.milestone.feature,
      icon: Sparkles,
      className: 'border-violet-400/25 bg-violet-400/10 text-violet-700 dark:text-violet-200',
   },
   PHASE: {
      label: fa.milestone.phase,
      icon: Layers3,
      className: 'border-sky-400/25 bg-sky-400/10 text-sky-700 dark:text-sky-200',
   },
   OTHER: {
      label: fa.milestone.other,
      icon: Flag,
      className: 'border-border bg-muted/70 text-muted-foreground',
   },
};

export const milestoneStatusMeta: Record<
   TaskaraMilestoneStatus,
   { label: string; icon: IconType; className: string }
> = {
   PLANNED: {
      label: fa.milestone.planned,
      icon: CircleDot,
      className: 'border-border bg-muted/70 text-muted-foreground',
   },
   ACTIVE: {
      label: fa.milestone.active,
      icon: Flag,
      className: 'border-indigo-400/25 bg-indigo-400/10 text-indigo-700 dark:text-indigo-200',
   },
   COMPLETED: {
      label: fa.milestone.completed,
      icon: CheckCircle2,
      className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-700 dark:text-emerald-200',
   },
   CANCELED: {
      label: fa.milestone.canceled,
      icon: PauseCircle,
      className: 'border-border bg-muted/70 text-muted-foreground',
   },
};

export const milestoneHealthMeta: Record<
   TaskaraMilestoneHealth,
   { label: string; icon: IconType; className: string }
> = {
   ON_TRACK: {
      label: fa.milestone.healthOnTrack,
      icon: Check,
      className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-700 dark:text-emerald-200',
   },
   AT_RISK: {
      label: fa.milestone.healthAtRisk,
      icon: AlertTriangle,
      className: 'border-amber-400/25 bg-amber-400/10 text-amber-700 dark:text-amber-200',
   },
   OFF_TRACK: {
      label: fa.milestone.healthOffTrack,
      icon: ShieldAlert,
      className: 'border-rose-400/25 bg-rose-400/10 text-rose-700 dark:text-rose-200',
   },
};

export function MilestoneGlyph({ className }: { className?: string }) {
   return (
      <span
         aria-hidden="true"
         className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-emerald-700 dark:text-emerald-400',
            className
         )}
      >
         <Target className="size-5" />
      </span>
   );
}

export function MilestoneBadge({
   className,
   icon: Icon,
   label,
}: {
   className?: string;
   icon: IconType;
   label: string;
}) {
   return (
      <span className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px]', className)}>
         <Icon className="size-3" />
         {label}
      </span>
   );
}

export function MilestoneProgress({
   compact = false,
   milestone,
}: {
   compact?: boolean;
   milestone: TaskaraMilestone;
}) {
   const { completedTasks, eligibleTasks, percentage } = milestone.progress;
   const safePercentage = percentage === null ? null : Math.max(0, Math.min(100, Math.round(percentage)));
   const text = percentage === null
      ? fa.milestone.noEligibleTasks
      : `${safePercentage?.toLocaleString('fa-IR')}٪ • ${fa.milestone.progressCount(completedTasks, eligibleTasks)}`;

   return (
      <div className={cn('min-w-0', compact ? 'space-y-1' : 'space-y-2')}>
         <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>{fa.milestone.progress}</span>
            <span className="truncate tabular-nums">{text}</span>
         </div>
         <div
            aria-label={`${fa.milestone.progress}: ${text}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={safePercentage ?? undefined}
            aria-valuetext={text}
            className={cn('flex w-full items-stretch justify-start overflow-hidden rounded-full bg-muted', compact ? 'h-1.5' : 'h-2')}
            role="progressbar"
         >
            {safePercentage !== null ? (
               <span
                  className={cn(
                     'h-full rounded-full transition-[width] duration-300',
                     safePercentage === 100 ? 'bg-emerald-400' : 'bg-indigo-400'
                  )}
                  style={{ width: `${safePercentage}%` }}
               />
            ) : null}
         </div>
      </div>
   );
}

export function MilestoneEmptyState({
   action,
   children,
   description,
}: {
   action?: ReactNode;
   children: ReactNode;
   description?: ReactNode;
}) {
   return (
      <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
         <MilestoneGlyph className="mb-4 size-11" />
         <h2 className="text-sm font-semibold text-foreground">{children}</h2>
         {description ? <p className="mt-2 max-w-sm text-xs leading-6 text-muted-foreground">{description}</p> : null}
         {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
      </div>
   );
}

export function MilestoneListSkeleton() {
   return (
      <div className="divide-y divide-border" aria-label={fa.app.loading}>
         {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="p-4">
               <div className="flex gap-3">
                  <Skeleton className="size-10 rounded-lg bg-muted" />
                  <div className="min-w-0 flex-1 space-y-2">
                     <Skeleton className="h-4 w-3/4 bg-muted" />
                     <Skeleton className="h-3 w-1/2 bg-muted/70" />
                  </div>
                  <Skeleton className="size-7 rounded-full bg-muted/70" />
               </div>
            </div>
         ))}
      </div>
   );
}

export function MilestoneDetailSkeleton() {
   return (
      <div className="mx-auto w-full max-w-[920px] px-5 py-6 lg:px-8">
         <div className="mb-7 flex items-center justify-between">
            <Skeleton className="h-5 w-40 bg-muted" />
            <Skeleton className="h-8 w-28 rounded-full bg-muted" />
         </div>
         <Skeleton className="h-9 w-3/4 bg-muted" />
         <div className="mt-5 space-y-3">
            <Skeleton className="h-4 w-full bg-muted/70" />
            <Skeleton className="h-4 w-11/12 bg-muted/70" />
            <Skeleton className="h-4 w-2/3 bg-muted/70" />
         </div>
         <div className="mt-8 rounded-lg border border-border/70 p-5">
            <Skeleton className="h-5 w-40 bg-muted" />
            <Skeleton className="mt-4 h-2 w-full rounded-full bg-muted/80" />
            <div className="mt-5 grid grid-cols-3 gap-3">
               <Skeleton className="h-16 bg-muted/70" />
               <Skeleton className="h-16 bg-muted/70" />
               <Skeleton className="h-16 bg-muted/70" />
            </div>
         </div>
      </div>
   );
}

export function formatMilestoneDateOnly(value?: string | null): string {
   const date = dateOnlyToLocalNoon(value);
   if (!date) return fa.app.noDate;
   return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
   }).format(date);
}

export function isMilestoneOverdue(milestone: TaskaraMilestone, now = new Date()): boolean {
   if (!milestone.targetOn || milestone.status === 'COMPLETED' || milestone.status === 'CANCELED') return false;
   const todayKey = [
      String(now.getUTCFullYear()).padStart(4, '0'),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
   ].join('-');
   return milestone.targetOn < todayKey;
}

export function primaryMilestoneAttention(milestone: TaskaraMilestone): {
   icon: IconType;
   isOverdue: boolean;
   label: string;
   tone: string;
} {
   const isOverdue = isMilestoneOverdue(milestone);
   if (isOverdue) return { icon: AlertTriangle, isOverdue, label: fa.milestone.overdue, tone: 'text-rose-600 dark:text-rose-300' };
   if (milestone.progress.blockedTasks > 0) {
      return {
         icon: ShieldAlert,
         isOverdue,
         label: fa.milestone.blockedCount(milestone.progress.blockedTasks),
         tone: 'text-amber-700 dark:text-amber-300',
      };
   }
   if (milestone.progress.overdueTasks > 0) {
      return {
         icon: AlertTriangle,
         isOverdue,
         label: fa.milestone.overdueCount(milestone.progress.overdueTasks),
         tone: 'text-amber-700 dark:text-amber-300',
      };
   }
   if (
      milestone.progress.percentage === 100 &&
      milestone.status !== 'COMPLETED' &&
      milestone.status !== 'CANCELED'
   ) {
      return { icon: CheckCircle2, isOverdue, label: fa.milestone.readyToComplete, tone: 'text-emerald-700 dark:text-emerald-300' };
   }
   if (!milestone.owner) return { icon: CircleDot, isOverdue, label: fa.milestone.missingOwner, tone: 'text-muted-foreground' };
   if (!milestone.targetOn) return { icon: CalendarDays, isOverdue, label: fa.milestone.missingTarget, tone: 'text-muted-foreground' };
   if (milestone.health) {
      const health = milestoneHealthMeta[milestone.health];
      return {
         icon: health.icon,
         isOverdue,
         label: health.label,
         tone:
            milestone.health === 'OFF_TRACK'
               ? 'text-rose-600 dark:text-rose-300'
               : milestone.health === 'AT_RISK'
                 ? 'text-amber-700 dark:text-amber-300'
                 : 'text-emerald-700 dark:text-emerald-300',
      };
   }
   return { icon: Check, isOverdue, label: fa.milestone.noAttention, tone: 'text-muted-foreground' };
}

function dateOnlyToLocalNoon(value?: string | null): Date | null {
   if (!value) return null;
   const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
   if (!match) return null;
   const year = Number(match[1]);
   const month = Number(match[2]);
   const day = Number(match[3]);
   const date = new Date(year, month - 1, day, 12, 0, 0, 0);
   return Number.isNaN(date.getTime()) ? null : date;
}

export function CompactActionButton({
   children,
   className,
   ...props
}: React.ComponentProps<typeof Button>) {
   return (
      <Button
         className={cn('h-8 rounded-full px-3 text-xs font-normal', className)}
         size="sm"
         {...props}
      >
         {children}
      </Button>
   );
}
