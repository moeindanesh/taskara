'use client';

import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
   AlertTriangle,
   Archive,
   CheckCircle2,
   CircleDot,
   FolderKanban,
   Minus,
   PauseCircle,
   SignalHigh,
   SignalLow,
   SignalMedium,
   UserRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fa } from '@/lib/fa-copy';
import { getProjectColorsFromName, getUserColorsFromName } from '@/lib/name-colors';

type IconType = ComponentType<{ className?: string }>;

export function LinearStatusBacklogIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle
            cx="8"
            cy="8"
            r="5.75"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
            strokeDasharray="0.8 3.05"
         />
      </svg>
   );
}

export function LinearStatusTodoIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="2.25" />
      </svg>
   );
}

export function LinearStatusProgressIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="2" />
         <path d="M8 2.25a5.75 5.75 0 0 1 5.75 5.75H8z" fill="currentColor" />
      </svg>
   );
}

export function LinearStatusReviewIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="2" />
         <path d="M8 2.25a5.75 5.75 0 1 1-5.75 5.75H8z" fill="currentColor" />
      </svg>
   );
}

export function LinearStatusBlockedIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="2" />
         <path d="M5.4 5.4 10.6 10.6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
   );
}

export function LinearStatusDoneIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle cx="8" cy="8" fill="currentColor" r="6.4" />
         <path
            d="m4.8 8.1 2 2 4.4-4.6"
            stroke="#17171a"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.9"
         />
      </svg>
   );
}

export function LinearStatusCanceledIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle cx="8" cy="8" fill="currentColor" r="6.4" />
         <path
            d="m5.65 5.65 4.7 4.7m0-4.7-4.7 4.7"
            stroke="#17171a"
            strokeLinecap="round"
            strokeWidth="1.9"
         />
      </svg>
   );
}

export function NoAssigneeIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle
            cx="8"
            cy="8"
            r="6.2"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.2"
            strokeDasharray="0.8 3.2"
         />
         <circle cx="8" cy="6.6" r="1.8" stroke="currentColor" strokeWidth="0.8" />
         <path d="M4.7 12.1c.65-1.55 1.8-2.35 3.3-2.35s2.65.8 3.3 2.35" stroke="currentColor" strokeLinecap="round" strokeWidth="0.8" />
      </svg>
   );
}

export function SidebarInboxIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <path
            d="M3.9 3.5h8.2l1.35 4.25v3.15a1.6 1.6 0 0 1-1.6 1.6h-7.7a1.6 1.6 0 0 1-1.6-1.6V7.75z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.55"
         />
         <path d="M2.75 7.85h3.5c.25.95.9 1.45 1.75 1.45s1.5-.5 1.75-1.45h3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.55" />
      </svg>
   );
}

export function SidebarMyIssuesIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <rect
            height="11.2"
            rx="3"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.8"
            strokeDasharray="1.2 3.1"
            width="11.2"
            x="2.4"
            y="2.4"
         />
         <circle cx="8" cy="8" fill="currentColor" r="1.25" />
      </svg>
   );
}

export function SidebarIssueIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <rect height="7" rx="1.7" stroke="currentColor" strokeWidth="1.75" width="7" x="2.9" y="2.9" />
         <rect height="7" rx="1.7" stroke="currentColor" strokeWidth="1.75" width="7" x="6.1" y="6.1" />
      </svg>
   );
}

export function SidebarProjectIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <path d="M8 2.4 13 5.1v5.8L8 13.6 3 10.9V5.1z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.55" />
         <path d="M3.25 5.25 8 7.95l4.75-2.7M8 8v5.25" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.55" />
      </svg>
   );
}

export function SidebarViewIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <path d="M8 3.1 13 5.7 8 8.3 3 5.7z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.55" />
         <path d="M3 9.35 8 12l5-2.65" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.55" />
      </svg>
   );
}

export function SidebarMoreIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <circle cx="3.7" cy="8" fill="currentColor" r="1.35" />
         <circle cx="8" cy="8" fill="currentColor" r="1.35" />
         <circle cx="12.3" cy="8" fill="currentColor" r="1.35" />
      </svg>
   );
}

export function SidebarTeamIcon({ className }: { className?: string }) {
   return (
      <svg aria-hidden="true" className={className} fill="none" height="16" viewBox="0 0 16 16" width="16">
         <path
            d="M2.5 5.15c0-.9.7-1.6 1.6-1.6h2.35l1.25 1.6h4.2c.9 0 1.6.7 1.6 1.6v4.45c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.65"
         />
         <path d="M2.75 7.05h10.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.65" />
      </svg>
   );
}

export const linearStatusMeta: Record<
   string,
   { label: string; icon: IconType; iconClassName: string; groupClassName: string }
> = {
   BACKLOG: {
      label: fa.status.BACKLOG,
      icon: LinearStatusBacklogIcon,
      iconClassName: 'text-zinc-500',
      groupClassName: 'bg-zinc-500/6',
   },
   TODO: {
      label: fa.status.TODO,
      icon: LinearStatusTodoIcon,
      iconClassName: 'text-zinc-300',
      groupClassName: 'bg-zinc-400/6',
   },
   IN_PROGRESS: {
      label: fa.status.IN_PROGRESS,
      icon: LinearStatusProgressIcon,
      iconClassName: 'text-yellow-400',
      groupClassName: 'bg-yellow-400/7',
   },
   IN_REVIEW: {
      label: fa.status.IN_REVIEW,
      icon: LinearStatusReviewIcon,
      iconClassName: 'text-violet-400',
      groupClassName: 'bg-violet-400/7',
   },
   BLOCKED: {
      label: fa.status.BLOCKED,
      icon: LinearStatusBlockedIcon,
      iconClassName: 'text-red-400',
      groupClassName: 'bg-red-400/7',
   },
   DONE: {
      label: fa.status.DONE,
      icon: LinearStatusDoneIcon,
      iconClassName: 'text-[#5e6ad2]',
      groupClassName: 'bg-indigo-400/7',
   },
   CANCELED: {
      label: fa.status.CANCELED,
      icon: LinearStatusCanceledIcon,
      iconClassName: 'text-zinc-500',
      groupClassName: 'bg-zinc-500/6',
   },
};

export const linearPriorityMeta: Record<string, { label: string; icon: IconType; className: string }> = {
   NO_PRIORITY: { label: fa.priority.NO_PRIORITY, icon: Minus, className: 'text-zinc-500' },
   LOW: { label: fa.priority.LOW, icon: SignalLow, className: 'text-sky-400' },
   MEDIUM: { label: fa.priority.MEDIUM, icon: SignalMedium, className: 'text-yellow-400' },
   HIGH: { label: fa.priority.HIGH, icon: SignalHigh, className: 'text-orange-400' },
   URGENT: { label: fa.priority.URGENT, icon: AlertTriangle, className: 'text-red-400' },
};

export const linearProjectStatusMeta: Record<string, { label: string; icon: IconType; className: string }> = {
   ACTIVE: { label: fa.projectStatus.ACTIVE, icon: CircleDot, className: 'text-yellow-400' },
   PAUSED: { label: fa.projectStatus.PAUSED, icon: PauseCircle, className: 'text-zinc-400' },
   COMPLETED: { label: fa.projectStatus.COMPLETED, icon: CheckCircle2, className: 'text-indigo-400' },
   ARCHIVED: { label: fa.projectStatus.ARCHIVED, icon: Archive, className: 'text-zinc-500' },
};

export function LinearPill({
   children,
   className,
   title,
}: {
   children: ReactNode;
   className?: string;
   title?: string;
}) {
   return (
      <span
         title={title}
         className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full border border-white/8 bg-[#2a2a2d] px-2.5 text-xs font-medium text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]',
            className
         )}
      >
         {children}
      </span>
   );
}

export function LinearSelectPill({
   value,
   onChange,
   children,
   ariaLabel,
}: {
   value: string;
   onChange: (value: string) => void;
   children: ReactNode;
   ariaLabel: string;
}) {
   return (
      <label className="relative inline-flex">
         <span className="sr-only">{ariaLabel}</span>
         <select
            aria-label={ariaLabel}
            className="h-7 cursor-pointer appearance-none rounded-full border border-white/8 bg-[#2a2a2d] py-0 ps-7 pe-3 text-xs font-medium text-zinc-300 outline-none transition hover:bg-[#303033] focus:ring-2 focus:ring-indigo-400/35"
            value={value}
            onChange={(event) => onChange(event.target.value)}
         >
            {children}
         </select>
      </label>
   );
}

export function StatusIcon({ status, className }: { status: string; className?: string }) {
   const meta = linearStatusMeta[status] || linearStatusMeta.TODO;
   const Icon = meta.icon;
   return <Icon className={cn('size-4', meta.iconClassName, className)} />;
}

export function PriorityIcon({ priority, className }: { priority: string; className?: string }) {
   const meta = linearPriorityMeta[priority] || linearPriorityMeta.NO_PRIORITY;
   const Icon = meta.icon;
   return <Icon className={cn('size-4', meta.className, className)} />;
}

export function ProjectStatusIcon({ status, className }: { status: string; className?: string }) {
   const meta = linearProjectStatusMeta[status] || linearProjectStatusMeta.ACTIVE;
   const Icon = meta.icon;
   return <Icon className={cn('size-4', meta.className, className)} />;
}

export function ShortcutKey({ children }: { children: ReactNode }) {
   return (
      <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] font-medium text-zinc-400 shadow-[inset_0_-1px_0_rgb(255_255_255/0.05)]">
         {children}
      </kbd>
   );
}

export function LinearAvatar({
   name,
   src,
   className,
}: {
   name?: string | null;
   src?: string | null;
   className?: string;
}) {
   const [imageFailed, setImageFailed] = useState(false);
   const colors = getUserColorsFromName(name);
   const initials = (name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

   useEffect(() => {
      setImageFailed(false);
   }, [src]);

   if (src && !imageFailed) {
      return (
         <img
            alt={name || fa.table.user}
            className={cn('block size-6 shrink-0 rounded-full border border-white/10 object-cover', className)}
            src={src}
            style={{ backgroundColor: colors.background, borderColor: colors.border }}
            onError={() => setImageFailed(true)}
         />
      );
   }

   return (
      <span
         className={cn(
            'inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold leading-none',
            className
         )}
         style={{ backgroundColor: colors.backgroundStrong, borderColor: colors.border, color: colors.foreground }}
      >
         {initials || <UserRound className="size-3.5" />}
      </span>
   );
}

export function LinearEmptyState({ children, className }: { children: ReactNode; className?: string }) {
   return (
      <div
         className={cn(
            'rounded-lg border border-dashed border-white/10 bg-white/[0.015] px-4 py-6 text-center text-sm text-zinc-500',
            className
         )}
      >
         {children}
      </div>
   );
}

export function LinearPanel({
   title,
   children,
   className,
}: {
   title?: ReactNode;
   children: ReactNode;
   className?: string;
}) {
   return (
      <section className={cn('rounded-lg border border-white/8 bg-[#19191b] shadow-sm', className)}>
         {title ? (
            <div className="border-b border-white/7 px-4 py-3 text-sm font-semibold text-zinc-300">{title}</div>
         ) : null}
         {children}
      </section>
   );
}

export function WorkspaceGlyph({ children = 'تس' }: { children?: ReactNode }) {
   return (
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-lime-500/30 text-[11px] font-bold text-lime-100">
         {children}
      </span>
   );
}

export function ProjectGlyph({
   className,
   iconClassName,
   name,
   style,
}: {
   className?: string;
   iconClassName?: string;
   name?: string | null;
   style?: CSSProperties;
}) {
   const colors = getProjectColorsFromName(name);

   return (
      <span
         className={cn('inline-flex size-7 items-center justify-center rounded-md border', className)}
         style={{
            backgroundColor: colors.backgroundStrong,
            borderColor: colors.border,
            color: colors.foreground,
            ...style,
         }}
      >
         <FolderKanban className={cn('size-4', iconClassName)} />
      </span>
   );
}
