import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleOff, Headset, Link2, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatJalaliDateTime } from '@/lib/jalali';
import { useLiveRefresh } from '@/lib/live-refresh';
import { supportHandoffClient } from '@/lib/support-handoff-client';
import type { TeamTaskSupportLinkProjection } from '@/lib/support-handoff-types';
import { cn } from '@/lib/utils';

export const teamTaskSupportLinksRefreshPolicy = {
   fireOnMount: false,
   intervalMs: 30_000,
   refreshOnFocus: true,
   refreshOnInterval: true,
   refreshOnOnline: true,
   refreshOnPageShow: true,
   refreshOnVisibility: true,
   refreshOnWorkspaceEvent: true,
} as const;

export function TeamTaskSupportLinks({ taskKey }: { taskKey: string }) {
   const [links, setLinks] = useState<TeamTaskSupportLinkProjection[]>([]);
   const [loadedTaskKey, setLoadedTaskKey] = useState('');
   const requestSequence = useRef(0);

   const load = useCallback(async (clearCurrent = false) => {
      const requestId = ++requestSequence.current;
      if (clearCurrent) {
         setLinks([]);
         setLoadedTaskKey('');
      }
      try {
         const items = await supportHandoffClient.listTaskSupportLinks(taskKey);
         if (requestId === requestSequence.current) {
            setLinks(items);
            setLoadedTaskKey(taskKey);
         }
      } catch {
         if (requestId === requestSequence.current) {
            setLinks([]);
            setLoadedTaskKey(taskKey);
         }
      }
   }, [taskKey]);

   useEffect(() => {
      void load(true);
      return () => { requestSequence.current += 1; };
   }, [load]);

   useLiveRefresh(() => load(), teamTaskSupportLinksRefreshPolicy);

   if (loadedTaskKey !== taskKey || !links.length) return null;

   return (
      <section className="mt-3 overflow-hidden rounded-lg border border-white/7 bg-black/10" data-testid="team-task-support-links">
         <div className="flex items-center gap-2 border-b border-white/6 px-3 py-2.5 text-xs font-medium text-zinc-400"><Headset className="size-4 text-indigo-300" /> ارجاع‌های پشتیبانی</div>
         <TeamTaskSupportLinkListView links={links} />
      </section>
   );
}

export function TeamTaskSupportLinkListView({ links }: { links: TeamTaskSupportLinkProjection[] }) {
   return (
      <div className="divide-y divide-white/6">
         {links.map((link) => {
            const frozen = Boolean(link.tombstone.connectionRevokedAt);
            const unlinked = Boolean(link.tombstone.unlinkedAt);
            return (
               <article key={link.linkId} className={cn('px-3 py-3', (frozen || unlinked) && 'bg-amber-400/[0.025]')}>
                  <div className="flex items-start gap-2.5">
                     {unlinked ? <CircleOff className="mt-0.5 size-4 shrink-0 text-zinc-500" /> : frozen ? <Unplug className="mt-0.5 size-4 shrink-0 text-amber-300" /> : <Link2 className="mt-0.5 size-4 shrink-0 text-indigo-300" />}
                     <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5"><bdi dir="ltr" className="font-mono text-[11px] text-indigo-300">{link.caseKey}</bdi><Badge variant="outline" className="border-white/10 text-[10px] text-zinc-500">{caseSignalLabel(link.status)}</Badge></div>
                        <h4 className="mt-1.5 break-words text-xs leading-6 text-zinc-300">{link.title}</h4>
                        <p className="mt-1 text-[11px] leading-5 text-zinc-600">{link.supportWorkspaceName} · آخرین سیگنال: {formatJalaliDateTime(link.lastSignalAt)}</p>
                        {unlinked ? <p className="mt-1 text-[11px] text-amber-200/75">پیوند برداشته شده؛ این نمای تاریخی باقی مانده است.</p> : frozen ? <p className="mt-1 text-[11px] text-amber-200/75">اتصال لغو و این نما در آخرین وضعیت تأییدشده منجمد شده است.</p> : null}
                     </div>
                  </div>
               </article>
            );
         })}
      </div>
   );
}

function caseSignalLabel(status: TeamTaskSupportLinkProjection['status']): string {
   if (status === 'RESOLVED') return 'حل‌شده';
   if (status === 'CLOSED') return 'بسته';
   return 'باز';
}
