import { useCallback, useEffect, useMemo, useState } from 'react';
import {
   Activity,
   AlertTriangle,
   CheckCircle2,
   Clock3,
   Inbox,
   Loader2,
   RefreshCw,
   RotateCcw,
   ServerCog,
   ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportOperationsClient } from '@/lib/support-operations-client';
import type {
   SupportIntakeDeadLetter,
   SupportIntakeDeadLetterPage,
   SupportIntakeHealth,
   SupportIntakeReceiptStatus,
} from '@/lib/support-operations-types';
import { cn } from '@/lib/utils';

const statusLabels: Record<SupportIntakeReceiptStatus, string> = {
   RECEIVED: 'دریافت‌شده',
   PROCESSING: 'در حال پردازش',
   RETRY_PENDING: 'در انتظار تلاش مجدد',
   PROCESSED: 'پردازش‌شده',
   REJECTED: 'ردشده',
   DEAD_LETTER: 'ناموفق نهایی',
};

export function SupportIntakeAdminView() {
   const [health, setHealth] = useState<SupportIntakeHealth>();
   const [deadLetters, setDeadLetters] = useState<SupportIntakeDeadLetterPage>({ items: [], nextCursor: null });
   const [connectorId, setConnectorId] = useState('');
   const [loadingHealth, setLoadingHealth] = useState(true);
   const [loadingLetters, setLoadingLetters] = useState(true);
   const [loadingMore, setLoadingMore] = useState(false);
   const [error, setError] = useState('');
   const [selected, setSelected] = useState<SupportIntakeDeadLetter>();
   const [detailLoading, setDetailLoading] = useState(false);
   const [confirmRetry, setConfirmRetry] = useState(false);
   const [retrying, setRetrying] = useState(false);

   const loadHealth = useCallback(async () => {
      setLoadingHealth(true);
      setError('');
      try {
         setHealth(await supportOperationsClient.getIntakeHealth());
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری سلامت ورودی‌ها ناموفق بود.');
      } finally {
         setLoadingHealth(false);
      }
   }, []);

   const loadDeadLetters = useCallback(async (nextConnectorId: string) => {
      setLoadingLetters(true);
      setError('');
      try {
         setDeadLetters(await supportOperationsClient.listDeadLetters({
            limit: 50,
            connectorId: nextConnectorId || undefined,
         }));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری ورودی‌های ناموفق نهایی ناموفق بود.');
      } finally {
         setLoadingLetters(false);
      }
   }, []);

   useEffect(() => {
      void Promise.all([loadHealth(), loadDeadLetters('')]);
   }, [loadDeadLetters, loadHealth]);

   const connectors = useMemo(() => health?.items.map((item) => item.connector) || [], [health]);

   async function selectReceipt(receipt: SupportIntakeDeadLetter) {
      setSelected(receipt);
      setDetailLoading(true);
      setError('');
      try {
         setSelected(await supportOperationsClient.getDeadLetter(receipt.receiptId));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری جزئیات رکورد ناموفق بود.');
         setSelected(undefined);
      } finally {
         setDetailLoading(false);
      }
   }

   async function loadMore() {
      if (!deadLetters.nextCursor) return;
      setLoadingMore(true);
      setError('');
      try {
         const next = await supportOperationsClient.listDeadLetters({
            limit: 50,
            cursor: deadLetters.nextCursor,
            connectorId: connectorId || undefined,
         });
         setDeadLetters((current) => ({ items: [...current.items, ...next.items], nextCursor: next.nextCursor }));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری ادامه فهرست ناموفق بود.');
      } finally {
         setLoadingMore(false);
      }
   }

   async function retry() {
      if (!selected) return;
      setRetrying(true);
      setError('');
      try {
         await supportOperationsClient.retryDeadLetter(selected.receiptId);
         setDeadLetters((current) => ({ ...current, items: current.items.filter((item) => item.receiptId !== selected.receiptId) }));
         setConfirmRetry(false);
         setSelected(undefined);
         await loadHealth();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'زمان‌بندی تلاش مجدد ناموفق بود.');
         setConfirmRetry(false);
      } finally {
         setRetrying(false);
      }
   }

   return (
      <main dir="rtl" className="min-h-full bg-[#101011] px-4 py-5 text-zinc-200 sm:px-5" data-testid="support-intake-admin-screen">
         <div className="mx-auto max-w-7xl space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-400/15 bg-sky-400/[0.04] px-4 py-3.5">
               <p className="max-w-4xl text-sm leading-7 text-sky-100/70"><ShieldCheck className="me-1 inline size-4 text-sky-300" />این صفحه فقط وضعیت عملیاتی پاک‌سازی‌شده را نشان می‌دهد؛ payload، کلید رویداد، کلید idempotency، خطای خام، پیکربندی و راز اتصال هرگز وارد مرورگر نمی‌شوند.</p>
               <Button aria-label="تازه‌سازی سلامت ورودی‌ها" className="border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" size="sm" type="button" variant="secondary" onClick={() => void Promise.all([loadHealth(), loadDeadLetters(connectorId)])}><RefreshCw className={cn('size-4', (loadingHealth || loadingLetters) && 'animate-spin')} />تازه‌سازی</Button>
            </div>
            {error ? <InlineError message={error} /> : null}
            <HealthSummary health={health} loading={loadingHealth} />
            <ConnectorHealth health={health} loading={loadingHealth} />

            <Card className="border-white/8 bg-[#171719] text-zinc-100">
               <CardHeader className="flex flex-col gap-3 border-b border-white/7 sm:flex-row sm:items-start sm:justify-between">
                  <div><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="size-4 text-amber-300" />ورودی‌های ناموفق نهایی</CardTitle><CardDescription className="mt-1.5 leading-6 text-zinc-500">رکوردهایی که پس از تلاش‌های ایمن نیازمند بررسی مدیر هستند</CardDescription></div>
                  <select aria-label="فیلتر اتصال ورودی" className={cn(selectClass, 'sm:w-64')} value={connectorId} onChange={(event) => { const next = event.target.value; setConnectorId(next); void loadDeadLetters(next); }}><option value="">همه اتصال‌ها</option>{connectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.name}</option>)}</select>
               </CardHeader>
               <CardContent className="p-0">
                  {loadingLetters ? <LoadingLine label="در حال بارگذاری رکوردهای ناموفق…" /> : null}
                  {!loadingLetters && !deadLetters.items.length ? <EmptyState /> : null}
                  <div className="divide-y divide-white/6">
                     {deadLetters.items.map((item) => (
                        <button key={item.receiptId} className="grid w-full gap-3 px-4 py-4 text-right transition hover:bg-white/[0.025] sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_120px_170px] sm:items-center" type="button" onClick={() => void selectReceipt(item)}>
                           <span className="min-w-0"><span className="block truncate text-sm font-medium text-zinc-200">{item.connector.name}</span><span className="mt-1 block truncate text-xs text-zinc-600">{item.error?.message || 'علت عمومی پردازش ثبت نشده است.'}</span></span>
                           <span className="min-w-0 text-xs text-zinc-500">{item.case ? <>پرونده <bdi dir="ltr" className="font-mono text-zinc-400">{item.case.key}</bdi></> : 'پرونده‌ای ساخته نشده'}</span>
                           <span className="text-xs text-zinc-500">{item.attempts.toLocaleString('fa-IR')} تلاش</span>
                           <span className="text-xs text-zinc-600">{formatJalaliDateTime(item.deadLetteredAt || item.updatedAt)}</span>
                        </button>
                     ))}
                  </div>
                  {deadLetters.nextCursor ? <div className="border-t border-white/7 p-3 text-center"><Button className="border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" disabled={loadingMore} type="button" variant="secondary" onClick={() => void loadMore()}>{loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}نمایش موارد بیشتر</Button></div> : null}
               </CardContent>
            </Card>
         </div>

         <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open && !retrying) setSelected(undefined); }}>
            <DialogContent dir="rtl" className="max-w-xl border-white/10 bg-[#171719] text-zinc-100">
               <DialogHeader className="text-right"><DialogTitle>جزئیات ورودی ناموفق</DialogTitle><DialogDescription className="leading-6 text-zinc-500">نمای پاک‌سازی‌شده برای تشخیص مسیر اتصال و خطای عمومی</DialogDescription></DialogHeader>
               {detailLoading ? <LoadingLine label="در حال دریافت جزئیات…" /> : selected ? <SupportIntakeDeadLetterDetails item={selected} /> : null}
               <DialogFooter className="gap-2 sm:justify-start"><Button className="bg-amber-300 text-amber-950 hover:bg-amber-200" disabled={detailLoading || retrying || selected?.connector.status !== 'ACTIVE'} type="button" onClick={() => setConfirmRetry(true)}><RotateCcw className="size-4" />تلاش مجدد</Button><Button type="button" variant="ghost" onClick={() => setSelected(undefined)}>بستن</Button></DialogFooter>
            </DialogContent>
         </Dialog>

         <Dialog open={confirmRetry} onOpenChange={(open) => { if (!retrying) setConfirmRetry(open); }}>
            <DialogContent dir="rtl" className="max-w-md border-white/10 bg-[#171719] text-zinc-100">
               <DialogHeader className="text-right"><DialogTitle>زمان‌بندی تلاش مجدد؟</DialogTitle><DialogDescription className="leading-7 text-zinc-500">پردازش با همان محتوای رمزگذاری‌شده روی سرور دوباره زمان‌بندی می‌شود. محتوای ورودی در این صفحه خوانده یا کپی نمی‌شود.</DialogDescription></DialogHeader>
               <DialogFooter className="gap-2 sm:justify-start"><Button className="bg-amber-300 text-amber-950 hover:bg-amber-200" disabled={retrying} type="button" onClick={() => void retry()}>{retrying ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}تأیید تلاش مجدد</Button><Button disabled={retrying} type="button" variant="ghost" onClick={() => setConfirmRetry(false)}>انصراف</Button></DialogFooter>
            </DialogContent>
         </Dialog>
      </main>
   );
}

function HealthSummary({ health, loading }: { health?: SupportIntakeHealth; loading: boolean }) {
   if (loading && !health) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-xl border border-white/7 bg-[#171719]" />)}</div>;
   const cards = [
      { label: 'اتصال‌های فعال', value: health?.summary.activeConnectorCount || 0, suffix: `از ${(health?.summary.connectorCount || 0).toLocaleString('fa-IR')}`, icon: ServerCog, tone: 'text-indigo-300' },
      { label: 'در انتظار پردازش', value: health?.summary.pendingCount || 0, suffix: health?.summary.oldestPendingAt ? `قدیمی‌ترین: ${formatJalaliDateTime(health.summary.oldestPendingAt)}` : 'صف جاری خالی است', icon: Clock3, tone: 'text-amber-300' },
      { label: 'پردازش‌شده', value: health?.summary.receiptCounts.PROCESSED || 0, suffix: 'در همه اتصال‌ها', icon: CheckCircle2, tone: 'text-lime-300' },
      { label: 'ناموفق نهایی', value: health?.summary.deadLetterCount || 0, suffix: 'نیازمند بررسی مدیر', icon: AlertTriangle, tone: 'text-red-300' },
   ];
   return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ icon: Icon, ...card }) => <Card key={card.label} className="border-white/8 bg-[#171719] text-zinc-100"><CardContent className="flex items-start gap-3 p-4"><span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.035]', card.tone)}><Icon className="size-4" /></span><div><p className="text-xs text-zinc-600">{card.label}</p><p className="mt-1 text-2xl font-semibold text-zinc-200">{card.value.toLocaleString('fa-IR')}</p><p className="mt-1 text-[11px] leading-5 text-zinc-600">{card.suffix}</p></div></CardContent></Card>)}</div>;
}

function ConnectorHealth({ health, loading }: { health?: SupportIntakeHealth; loading: boolean }) {
   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader className="border-b border-white/7"><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4 text-sky-300" />سلامت اتصال‌ها</CardTitle><CardDescription className="mt-1.5 leading-6 text-zinc-500">آخرین دریافت، پردازش و خطای نهایی هر منبع</CardDescription></CardHeader>
         <CardContent className="p-0">
            {loading && !health ? <LoadingLine label="در حال بارگذاری اتصال‌ها…" /> : null}
            {!loading && !health?.items.length ? <p className="px-4 py-10 text-center text-sm text-zinc-600">اتصال ورودی ثبت نشده است.</p> : null}
            <div className="divide-y divide-white/6">{health?.items.map((item) => <div key={item.connector.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_120px_120px_minmax(180px,1fr)] sm:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium text-zinc-200">{item.connector.name}</span><Badge variant="outline" className={item.connector.status === 'ACTIVE' ? 'border-lime-400/20 bg-lime-400/8 text-lime-300' : 'border-white/10 text-zinc-500'}>{item.connector.status === 'ACTIVE' ? 'فعال' : 'لغوشده'}</Badge></div><p className="mt-1 text-xs text-zinc-600">کانال {item.connector.sourceChannel}</p></div><Count label="در انتظار" value={item.pendingCount} /><Count label="ناموفق نهایی" value={item.deadLetterCount} danger={item.deadLetterCount > 0} /><div className="text-[11px] leading-6 text-zinc-600">آخرین دریافت: {item.lastReceivedAt ? formatJalaliDateTime(item.lastReceivedAt) : 'هنوز دریافت نشده'}<br />آخرین پردازش: {item.lastProcessedAt ? formatJalaliDateTime(item.lastProcessedAt) : 'هنوز پردازش نشده'}</div></div>)}</div>
         </CardContent>
      </Card>
   );
}

export function SupportIntakeDeadLetterDetails({ item }: { item: SupportIntakeDeadLetter }) {
   return (
      <div className="space-y-3" data-testid="support-dead-letter-detail">
         <div className="rounded-lg border border-amber-300/15 bg-amber-300/[0.035] px-3 py-3 text-sm leading-7 text-amber-100/75"><AlertTriangle className="me-1 inline size-4" />{item.error?.message || 'خطای عمومی پردازش ثبت شده است.'}<bdi dir="ltr" className="mt-1 block font-mono text-[11px] text-amber-200/55">{item.error?.code || 'NO_PUBLIC_ERROR_CODE'}</bdi></div>
         <dl className="grid gap-3 rounded-lg border border-white/7 bg-black/10 p-4 text-xs sm:grid-cols-2">
            <Detail label="شناسه دریافت" value={item.receiptId} ltr />
            <Detail label="اتصال" value={`${item.connector.name} · ${item.connector.sourceChannel}`} />
            <Detail label="وضعیت اتصال" value={item.connector.status === 'ACTIVE' ? 'فعال' : 'لغوشده'} />
            <Detail label="تعداد تلاش" value={item.attempts.toLocaleString('fa-IR')} />
            <Detail label="پرونده" value={item.case?.key || 'ساخته نشده'} ltr={Boolean(item.case)} />
            <Detail label="دریافت" value={formatJalaliDateTime(item.receivedAt)} />
            <Detail label="ناموفق نهایی" value={formatJalaliDateTime(item.deadLetteredAt || item.updatedAt)} />
         </dl>
         {item.case ? <Button asChild className="w-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" variant="secondary"><Link to={`../support/cases/${encodeURIComponent(item.case.key)}`}>بازکردن پرونده <bdi dir="ltr" className="font-mono">{item.case.key}</bdi></Link></Button> : null}
         <div className="rounded-lg border border-sky-400/10 bg-sky-400/[0.025] px-3 py-2.5 text-xs leading-6 text-sky-100/60"><ShieldCheck className="me-1 inline size-3.5" />جزئیات حساس ورودی و اتصال عمداً در این نما موجود نیست.</div>
      </div>
   );
}

function Count({ danger, label, value }: { danger?: boolean; label: string; value: number }) {
   return <div><p className="text-[11px] text-zinc-600">{label}</p><p className={cn('mt-1 text-base font-medium text-zinc-300', danger && 'text-red-300')}>{value.toLocaleString('fa-IR')}</p></div>;
}

function Detail({ label, ltr, value }: { label: string; ltr?: boolean; value: string }) {
   return <div><dt className="text-zinc-600">{label}</dt><dd dir={ltr ? 'ltr' : undefined} className={cn('mt-1 break-words text-zinc-300', ltr && 'text-left font-mono')}>{value}</dd></div>;
}

function EmptyState() {
   return <div className="px-4 py-14 text-center"><Inbox className="mx-auto size-8 text-zinc-700" /><p className="mt-3 text-sm text-zinc-400">ورودی ناموفق نهایی وجود ندارد.</p><p className="mt-1 text-xs leading-6 text-zinc-600">صف سالم است یا همه موارد قبلی بررسی و دوباره زمان‌بندی شده‌اند.</p></div>;
}

function LoadingLine({ label }: { label: string }) {
   return <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" />{label}</div>;
}

function InlineError({ message }: { message: string }) {
   return <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm leading-6 text-red-200">{message}</p>;
}

const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
