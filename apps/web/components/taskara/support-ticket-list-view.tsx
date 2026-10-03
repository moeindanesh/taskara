import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Loader2, MessageSquareText, RefreshCw, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatJalaliDateTime } from '@/lib/jalali';
import {
   supportTicketClient,
   type SupportTicket,
   type SupportTicketStatus,
} from '@/lib/support-ticket-client';
import type { SupportCasePriority } from '@/lib/support-types';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';

const statusLabels: Record<SupportTicketStatus, string> = {
   NEW: 'جدید',
   OPEN: 'در گفتگو',
   CLOSED: 'بسته',
};

const priorityLabels: Record<SupportCasePriority, string> = {
   LOW: 'کم',
   NORMAL: 'عادی',
   HIGH: 'زیاد',
   URGENT: 'فوری',
};

export function SupportTicketListView() {
   const runtime = useWorkspaceRuntime();
   const [items, setItems] = useState<SupportTicket[]>([]);
   const [query, setQuery] = useState('');
   const [submittedQuery, setSubmittedQuery] = useState('');
   const [status, setStatus] = useState<SupportTicketStatus | ''>('');
   const [priority, setPriority] = useState<SupportCasePriority | ''>('');
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         const result = await supportTicketClient.list({
            q: submittedQuery || undefined,
            status: status || undefined,
            priority: priority || undefined,
         });
         setItems(result.items);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری تیکت‌ها ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, [priority, status, submittedQuery]);

   useEffect(() => { void load(); }, [load]);

   function search(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setSubmittedQuery(query.trim());
   }

   return (
      <main dir="rtl" className="flex h-full min-h-0 flex-col bg-[#101011] text-zinc-200">
         <div className="flex flex-col gap-3 border-b border-white/7 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
            <form className="flex w-full max-w-xl items-center gap-2" onSubmit={search}>
               <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-zinc-600" />
                  <Input
                     aria-label="جستجو در تیکت‌ها"
                     className="h-9 border-white/10 bg-[#0a0a0b] pe-3 ps-9"
                     placeholder="جستجو با عنوان، شماره یا تلفن…"
                     value={query}
                     onChange={(event) => setQuery(event.target.value)}
                  />
               </div>
               <Button type="submit" variant="secondary">جستجو</Button>
            </form>
            <div className="flex items-center gap-2">
               <select className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as SupportTicketStatus | '')}>
                  <option value="">همه وضعیت‌ها</option>
                  {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
               </select>
               <select className={selectClass} value={priority} onChange={(event) => setPriority(event.target.value as SupportCasePriority | '')}>
                  <option value="">همه اولویت‌ها</option>
                  {Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
               </select>
               <Button aria-label="تازه‌سازی" size="icon" variant="ghost" onClick={() => void load()}>
                  <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
               </Button>
            </div>
         </div>
         {error ? <div role="alert" className="m-4 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/8 p-3 text-red-200"><AlertTriangle className="size-4" />{error}</div> : null}
         <div className="min-h-0 flex-1 overflow-auto">
            {loading && !items.length ? (
               <div className="flex h-56 items-center justify-center gap-2 text-zinc-500"><Loader2 className="size-4 animate-spin" />در حال بارگذاری…</div>
            ) : items.length ? (
               <div className="divide-y divide-white/6">
                  {items.map((ticket) => (
                     <Link
                        key={ticket.id}
                        className="grid min-h-24 gap-3 px-4 py-4 transition hover:bg-white/[0.025] lg:grid-cols-[minmax(0,1fr)_150px_140px]"
                        to={`/${runtime.workspaceSlug}/support/tickets/${encodeURIComponent(ticket.key)}`}
                     >
                        <div className="min-w-0">
                           <div className="flex items-center gap-2">
                              <bdi dir="ltr" className="font-mono text-xs text-zinc-500">{ticket.key}</bdi>
                              <h2 className="truncate text-sm text-zinc-100">{ticket.title}</h2>
                              {ticket.caseKey ? <Badge variant="outline" className="border-lime-300/20 text-lime-200">پرونده {ticket.caseKey}</Badge> : null}
                           </div>
                           <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-600">
                              <bdi dir="ltr">{ticket.contact?.phone || 'بدون تلفن'}</bdi>
                              <span>{formatJalaliDateTime(ticket.updatedAt)}</span>
                           </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs"><MessageSquareText className="size-4 text-zinc-600" />{statusLabels[ticket.status]}</div>
                        <div className="flex items-center"><Badge variant="outline">{priorityLabels[ticket.priority]}</Badge></div>
                     </Link>
                  ))}
               </div>
            ) : (
               <div className="flex h-72 flex-col items-center justify-center gap-3 text-center text-zinc-500">
                  <MessageSquareText className="size-8" />
                  <p>تیکتی برای بررسی وجود ندارد.</p>
               </div>
            )}
         </div>
      </main>
   );
}

const selectClass = 'h-9 rounded-md border border-white/10 bg-[#0a0a0b] px-3 text-xs text-zinc-300';
