'use client';

import { Bell, CalendarDays, Megaphone, Plus, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { formatJalaliDateTime } from '@/lib/jalali';
import type { TaskaraAnnouncement, TaskaraMeeting } from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';

export type CommunicationKind = 'announcement' | 'meeting';

export type CommunicationFilter = 'all' | 'announcements' | 'meetings' | 'unread' | 'mine' | 'drafts';

export type CommunicationListItem = {
   kind: CommunicationKind;
   id: string;
   title: string;
   preview: string;
   status: string;
   date: string;
   unread?: boolean;
   audienceCount?: number;
   projectName?: string;
   source: TaskaraAnnouncement | TaskaraMeeting;
};

export function CommunicationListRow({
   item,
   active,
   onSelect,
}: {
   item: CommunicationListItem;
   active: boolean;
   onSelect: () => void;
}) {
   const Icon = item.kind === 'announcement' ? Bell : Users;
   const typeLabel = item.kind === 'announcement' ? fa.communications.announcementType : fa.meeting.title;

   return (
      <button
         className={cn(
            'group grid min-h-[76px] w-full grid-cols-[32px_minmax(0,1fr)_auto] gap-3 rounded-lg px-3 py-2.5 text-start transition focus-visible:ring-1 focus-visible:ring-indigo-400/70 focus-visible:outline-none',
            active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.045]'
         )}
         type="button"
         onClick={onSelect}
      >
         <span className="relative mt-0.5 inline-flex size-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.055] text-zinc-400">
            <Icon className="size-4" />
            {item.unread ? <span className="absolute -top-0.5 -start-0.5 size-2 rounded-full bg-indigo-400 ring-2 ring-[#101011]" /> : null}
         </span>
         <span className="min-w-0">
            <span className="mb-1 flex min-w-0 items-center gap-1.5">
               <span className="truncate text-sm font-medium text-zinc-200">{item.title}</span>
               <span
                  className={cn(
                     'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]',
                     item.kind === 'announcement'
                        ? 'border-indigo-400/20 bg-indigo-400/10 text-indigo-200'
                        : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                  )}
               >
                  {typeLabel}
               </span>
            </span>
            <span className="line-clamp-1 text-xs leading-5 text-zinc-500">{item.preview || fa.inbox.noDescription}</span>
            <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-zinc-600">
               <span className="truncate">{item.status}</span>
               {item.projectName ? (
                  <>
                     <span className="size-1 rounded-full bg-zinc-700" />
                     <span className="truncate">{item.projectName}</span>
                  </>
               ) : null}
               {typeof item.audienceCount === 'number' ? (
                  <>
                     <span className="size-1 rounded-full bg-zinc-700" />
                     <span>{fa.communications.peopleCount(item.audienceCount)}</span>
                  </>
               ) : null}
            </span>
         </span>
         <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-zinc-500">{formatJalaliDateTime(item.date)}</span>
      </button>
   );
}

export function CommunicationEmptyState({
   children,
   actionLabel,
   onAction,
}: {
   children: ReactNode;
   actionLabel?: string;
   onAction?: () => void;
}) {
   return (
      <div className="rounded-lg border border-white/8 bg-white/[0.025] px-4 py-6 text-center">
         <p className="text-sm leading-6 text-zinc-500">{children}</p>
         {actionLabel && onAction ? (
            <Button
               className="mt-4 h-8 rounded-full bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-400"
               type="button"
               onClick={onAction}
            >
               {actionLabel}
            </Button>
         ) : null}
      </div>
   );
}

export function CommunicationActionRailPanel({
   children,
   title,
}: {
   children: ReactNode;
   title: string;
}) {
   return (
      <section className="rounded-lg border border-white/8 bg-[#18181a]">
         <div className="border-b border-white/7 px-4 py-3 text-sm font-semibold text-zinc-400">{title}</div>
         <div className="space-y-3 px-4 py-4">{children}</div>
      </section>
   );
}

export function CommunicationCreateMenu({
   onCreateAnnouncement,
   onCreateMeeting,
   onOpenChange,
   open,
}: {
   onCreateAnnouncement: () => void;
   onCreateMeeting: () => void;
   onOpenChange: (open: boolean) => void;
   open: boolean;
}) {
   return (
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
         <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100">
               <Plus className="size-4" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="w-48 rounded-xl border-white/10 bg-[#202023] p-1.5 text-zinc-100 [direction:rtl]">
            <DropdownMenuItem className="h-9 rounded-lg px-3 text-sm" onSelect={onCreateAnnouncement}>
               <Megaphone className="size-4 text-zinc-500" />
               {fa.announcement.newAnnouncement}
            </DropdownMenuItem>
            <DropdownMenuItem className="h-9 rounded-lg px-3 text-sm" onSelect={onCreateMeeting}>
               <Users className="size-4 text-zinc-500" />
               {fa.meeting.newMeeting}
            </DropdownMenuItem>
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

export function CommunicationListSkeleton() {
   return (
      <div className="space-y-2">
         {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="grid min-h-[76px] grid-cols-[32px_minmax(0,1fr)_72px] gap-3 rounded-lg px-3 py-2.5">
               <Skeleton className="size-8 rounded-lg bg-white/8" />
               <div className="min-w-0 space-y-2">
                  <Skeleton className="h-4 w-3/4 bg-white/8" />
                  <Skeleton className="h-3 w-full bg-white/6" />
                  <Skeleton className="h-3 w-1/2 bg-white/6" />
               </div>
               <Skeleton className="h-3 w-16 bg-white/6" />
            </div>
         ))}
      </div>
   );
}

export function CommunicationDetailSkeleton() {
   return (
      <div className="mx-auto flex min-h-full w-full max-w-[900px] flex-col px-5 py-5 lg:px-8">
         <div className="mb-7 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
               <Skeleton className="size-4 rounded-full bg-white/8" />
               <Skeleton className="h-4 w-40 bg-white/8" />
            </div>
            <Skeleton className="h-8 w-24 rounded-full bg-white/8" />
         </div>
         <Skeleton className="mb-5 h-8 w-2/3 bg-white/8" />
         <div className="space-y-3 border-b border-white/8 pb-8">
            <Skeleton className="h-4 w-full bg-white/7" />
            <Skeleton className="h-4 w-11/12 bg-white/7" />
            <Skeleton className="h-4 w-3/4 bg-white/7" />
         </div>
         <div className="mt-6 space-y-2 rounded-lg border border-white/8 bg-[#18181a] p-4">
            <Skeleton className="h-4 w-48 bg-white/8" />
            <Skeleton className="h-10 w-full bg-white/6" />
            <Skeleton className="h-10 w-full bg-white/6" />
         </div>
      </div>
   );
}

export function CommunicationKindIcon({ kind, className }: { kind: CommunicationKind; className?: string }) {
   const Icon = kind === 'announcement' ? Megaphone : CalendarDays;
   return <Icon className={className} />;
}
