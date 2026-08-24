import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
   BookOpenCheck,
   Bot,
   Check,
   CheckCircle2,
   Clipboard,
   History,
   Lightbulb,
   Loader2,
   RefreshCw,
   RotateCcw,
   Search,
   Send,
   ShieldCheck,
   Sparkles,
   ThumbsUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
   SupportAssistanceSuggestionItem,
   SupportEnablementPreviewPanel,
   SupportKnowledgeUseHistory,
} from '@/components/taskara/support-case-maturity';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportCaseActionAccess } from '@/lib/support-access';
import { supportMaturityClient } from '@/lib/support-maturity-client';
import type {
   SupportAssistanceSuggestion,
   SupportCsatInvitation,
   SupportEnablementApplication,
   SupportEnablementDefinition,
   SupportEnablementPreview,
   SupportKnowledgeGapKind,
   SupportKnowledgeOutcome,
   SupportKnowledgePageSummary,
   SupportKnowledgeUse,
   SupportKnowledgeUsefulness,
} from '@/lib/support-maturity-types';
import type { SupportCase } from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { cn } from '@/lib/utils';

export function SupportCaseAssistanceCard({ item, onCaseChanged }: {
   item: SupportCase;
   onCaseChanged: () => void | Promise<void>;
}) {
   const support = useSupportWorkspace();
   const credentialActor = Boolean(support.access?.credentialScopes?.length);
   const canDecide = supportCaseActionAccess(item, support.access).canWork && !credentialActor;
   const [suggestions, setSuggestions] = useState<SupportAssistanceSuggestion[]>([]);
   const [reasons, setReasons] = useState<Record<string, string>>({});
   const [loading, setLoading] = useState(true);
   const [busyId, setBusyId] = useState('');
   const [error, setError] = useState('');

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         setSuggestions((await supportMaturityClient.listAssistance(item.key)).items);
      } catch (caught) {
         setError(message(caught, 'بارگذاری پیشنهادهای کمکی ناموفق بود.'));
      } finally {
         setLoading(false);
      }
   }, [item.key]);

   useEffect(() => { void load(); }, [load]);

   async function decide(suggestion: SupportAssistanceSuggestion, decision: 'ACCEPTED' | 'REJECTED') {
      const reason = reasons[suggestion.id]?.trim() || '';
      if (!canDecide || reason.length < 3 || busyId) return;
      setBusyId(suggestion.id);
      setError('');
      try {
         const mutates = ['TYPE', 'PRIORITY', 'DEPARTMENT', 'DUPLICATE'].includes(suggestion.kind);
         const updated = await supportMaturityClient.decideAssistance(suggestion.id, decision === 'REJECTED'
            ? { decision, reason }
            : { decision, reason, ...(mutates ? { baseVersion: item.version } : {}) });
         setSuggestions((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
         setReasons((current) => ({ ...current, [suggestion.id]: '' }));
         if (decision === 'ACCEPTED' && mutates) await onCaseChanged();
      } catch (caught) {
         setError(message(caught, 'ثبت تصمیم انسانی ناموفق بود؛ نسخه پرونده را تازه کنید.'));
      } finally {
         setBusyId('');
      }
   }

   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100" data-testid="support-case-assistance">
         <CardHeader className="border-b border-white/7"><div className="flex items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-sm"><Sparkles className="size-4 text-violet-300" /> کمک تصمیم‌گیری</CardTitle><CardDescription className="mt-1.5 leading-6 text-zinc-600">منشأ و اعتماد هر پیشنهاد قابل مشاهده است؛ تصمیم یا اجرا همیشه انسانی است.</CardDescription></div><Button aria-label="تازه‌سازی پیشنهادها" className="size-8 text-zinc-500" size="icon" type="button" variant="ghost" onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button></div></CardHeader>
         <CardContent className="space-y-3 p-4">{error ? <InlineError text={error} /> : null}{loading && !suggestions.length ? <Loading text="در حال بارگذاری پیشنهادها…" /> : null}{!loading && !suggestions.length ? <Empty text="پیشنهاد کمکی برای این پرونده ثبت نشده است." /> : suggestions.map((suggestion) => <SupportAssistanceSuggestionItem key={suggestion.id} busy={busyId === suggestion.id} canDecide={canDecide && (!['TYPE', 'PRIORITY', 'DEPARTMENT', 'DUPLICATE'].includes(suggestion.kind) || (item.status !== 'RESOLVED' && item.status !== 'CLOSED'))} item={suggestion} reason={reasons[suggestion.id] || ''} onReason={(reason) => setReasons((current) => ({ ...current, [suggestion.id]: reason }))} onDecide={(decision) => void decide(suggestion, decision)} />)}</CardContent>
      </Card>
   );
}

export function SupportCaseEnablementCard({ item, onCaseChanged }: {
   item: SupportCase;
   onCaseChanged: (item: SupportCase) => void;
}) {
   const support = useSupportWorkspace();
   const credentialActor = Boolean(support.access?.credentialScopes?.length);
   const canApply = supportCaseActionAccess(item, support.access).canWork
      && !credentialActor
      && !['RESOLVED', 'CLOSED'].includes(item.status);
   const canWork = canApply;
   const [definitions, setDefinitions] = useState<SupportEnablementDefinition[]>([]);
   const [selectedId, setSelectedId] = useState('');
   const [preview, setPreview] = useState<SupportEnablementPreview>();
   const [evaluations, setEvaluations] = useState<SupportEnablementPreview[]>([]);
   const [application, setApplication] = useState<SupportEnablementApplication>();
   const [loading, setLoading] = useState(true);
   const [busy, setBusy] = useState('');
   const [error, setError] = useState('');

   const load = useCallback(async () => {
      if (!canApply) {
         setLoading(false);
         return;
      }
      setLoading(true);
      setError('');
      try {
         const result = await supportMaturityClient.listDefinitions({ status: 'APPROVED', limit: 100 });
         setDefinitions(result.items);
         setSelectedId((current) => result.items.some((entry) => entry.id === current) ? current : result.items[0]?.id || '');
      } catch (caught) {
         setError(message(caught, 'بارگذاری تعریف‌های تأییدشده ناموفق بود.'));
      } finally {
         setLoading(false);
      }
   }, [canApply]);

   useEffect(() => { void load(); }, [load]);
   useEffect(() => { setPreview(undefined); setEvaluations([]); setApplication(undefined); }, [item.key]);
   useEffect(() => { setPreview(undefined); setEvaluations([]); }, [item.version]);
   useEffect(() => {
      if (application && application.caseVersionAfter !== item.version) setApplication(undefined);
   }, [application, item.version]);

   async function previewSelected() {
      if (!selectedId || busy) return;
      setBusy('preview'); setError('');
      try { setPreview(await supportMaturityClient.previewDefinition(item.key, selectedId, item.version)); }
      catch (caught) { setError(message(caught, 'پیش‌نمایش ناموفق بود؛ پرونده را تازه کنید.')); }
      finally { setBusy(''); }
   }

   async function evaluate() {
      if (busy) return;
      setBusy('evaluate'); setError('');
      try {
         const result = await supportMaturityClient.evaluateAutomations(item.key, item.version);
         setEvaluations(result.items);
         if (result.items.length === 1) setPreview(result.items[0]);
      } catch (caught) { setError(message(caught, 'ارزیابی خودکارسازی‌ها ناموفق بود.')); }
      finally { setBusy(''); }
   }

   async function apply() {
      if (!preview?.canApply || preview.case.version !== item.version || busy || !canApply) return;
      setBusy('apply'); setError('');
      try {
         const result = await supportMaturityClient.applyDefinition(item.key, preview.definition.id, { baseVersion: preview.case.version, previewHash: preview.previewHash });
         setApplication(result.application); setPreview(undefined); setEvaluations([]); onCaseChanged(result.case);
      } catch (caught) { setError(message(caught, 'اعمال ناموفق بود؛ پیش‌نمایش تازه بگیرید.')); }
      finally { setBusy(''); }
   }

   async function undo() {
      if (!application || application.caseVersionAfter !== item.version || busy || !canApply) return;
      setBusy('undo'); setError('');
      try {
         const result = await supportMaturityClient.undoApplication(application.id, item.version);
         setApplication(result.application); onCaseChanged(result.case);
      } catch (caught) { setError(message(caught, 'بازگردانی امن ممکن نبود؛ شاید فیلدها پس از اعمال تغییر کرده باشند.')); }
      finally { setBusy(''); }
   }

   if (!canApply) return null;

   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100" data-testid="support-case-enablement">
         <CardHeader className="border-b border-white/7"><CardTitle className="flex items-center gap-2 text-sm"><Bot className="size-4 text-sky-300" /> ماکرو، الگو و خودکارسازی</CardTitle><CardDescription className="mt-1.5 leading-6 text-zinc-600">تغییرها روی نسخه فعلی پیش‌نمایش می‌شوند و بدون تأیید انسان اعمال نمی‌شوند.</CardDescription></CardHeader>
         <CardContent className="space-y-3 p-4">{error ? <InlineError text={error} /> : null}{loading ? <Loading text="در حال بارگذاری تعریف‌ها…" /> : null}{!loading && !definitions.length ? <Empty text="تعریف تأییدشده‌ای در دسترس نیست." /> : null}{definitions.length ? <><select aria-label="انتخاب ماکرو یا الگو" className={selectClass} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setPreview(undefined); }}>{definitions.map((definition) => <option key={definition.id} value={definition.id}>{definitionKindLabel(definition.kind)} — {definition.name} (v{definition.version})</option>)}</select><div className="grid grid-cols-2 gap-2"><Button className="border border-white/10 bg-white/5 text-zinc-300" disabled={!selectedId || Boolean(busy)} size="sm" type="button" variant="secondary" onClick={() => void previewSelected()}>{busy === 'preview' ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} پیش‌نمایش</Button><Button className="border border-white/10 bg-white/5 text-zinc-300" disabled={Boolean(busy)} size="sm" type="button" variant="secondary" onClick={() => void evaluate()}>{busy === 'evaluate' ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />} ارزیابی خودکارسازی</Button></div></> : null}{evaluations.length ? <div className="rounded-lg border border-white/7 bg-black/10 p-2"><p className="mb-2 text-xs text-zinc-500">نتیجه ارزیابی — اعمال خودکار غیرفعال است</p>{evaluations.map((entry) => <button key={entry.definition.id} className={cn('mb-1 block w-full rounded-md px-2 py-2 text-start text-xs', entry.conditionMatched ? 'bg-lime-300/5 text-lime-100' : 'bg-white/[0.025] text-zinc-600')} type="button" onClick={() => setPreview(entry)}>{entry.definition.name} — {entry.conditionMatched ? 'منطبق' : 'نامنطبق'}</button>)}</div> : null}{preview ? <SupportEnablementPreviewPanel busy={busy === 'apply'} preview={preview} onApply={() => void apply()} onClear={() => setPreview(undefined)} /> : null}{application && !application.undoneAt ? <div className="rounded-lg border border-lime-300/15 bg-lime-300/[0.035] p-3"><p className="text-xs leading-6 text-lime-100">اعمال روی نسخه {application.caseVersionAfter.toLocaleString('fa-IR')} ثبت شد. بازگردانی فقط اگر فیلدها تغییر نکرده باشند انجام می‌شود.</p><Button className="mt-2 border border-white/10 bg-white/5 text-zinc-300" disabled={busy === 'undo'} size="sm" type="button" variant="secondary" onClick={() => void undo()}>{busy === 'undo' ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} بازگردانی امن</Button></div> : null}{!canWork && definitions.length ? <p className="rounded-lg border border-amber-300/10 bg-amber-300/[0.025] px-3 py-2 text-xs leading-6 text-amber-100/60">مشاهده پیش‌نمایش ممکن است؛ اعمال و بازگردانی فقط برای مسئول مجاز پرونده غیرنهایی فعال است.</p> : null}</CardContent>
      </Card>
   );
}

export function SupportCaseCsatCard({ item }: { item: SupportCase }) {
   const support = useSupportWorkspace();
   const credentialActor = Boolean(support.access?.credentialScopes?.length);
   const canReview = !credentialActor && Boolean(
      support.access?.workspaceWide
      || (item.departmentId && support.access?.managedDepartmentIds.includes(item.departmentId))
   );
   const terminal = item.status === 'RESOLVED' || item.status === 'CLOSED';
   const [items, setItems] = useState<SupportCsatInvitation[]>([]);
   const [token, setToken] = useState('');
   const [loading, setLoading] = useState(canReview);
   const [busy, setBusy] = useState(false);
   const [copied, setCopied] = useState(false);
   const [error, setError] = useState('');

   const load = useCallback(async () => {
      if (!canReview) return;
      setLoading(true); setError('');
      try { setItems(await supportMaturityClient.getCsat(item.key)); }
      catch (caught) { setError(message(caught, 'بارگذاری سابقه رضایت ناموفق بود.')); }
      finally { setLoading(false); }
   }, [canReview, item.key]);

   useEffect(() => { setToken(''); setCopied(false); void load(); return () => setToken(''); }, [load]);

   async function invite() {
      if (!terminal || busy) return;
      setBusy(true); setError('');
      try { const created = await supportMaturityClient.inviteCsat(item.key, { expiresInDays: 30, scaleMin: 1, scaleMax: 5 }); setToken(created.token); setCopied(false); await load(); }
      catch (caught) { setError(message(caught, 'ساخت دعوت رضایت ناموفق بود.')); }
      finally { setBusy(false); }
   }

   async function copy() {
      if (!token || typeof navigator === 'undefined' || !navigator.clipboard) return;
      try {
         await navigator.clipboard.writeText(token);
         setCopied(true);
      } catch {
         setCopied(false);
      }
   }

   if (!canReview) return null;
   return <Card className="border-white/8 bg-[#171719] text-zinc-100" data-testid="support-case-csat"><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ThumbsUp className="size-4 text-amber-200" /> رضایت مشتری</CardTitle><CardDescription className="leading-6 text-zinc-600">توکن دعوت فقط یک‌بار و فقط در حافظه همین صفحه نمایش داده می‌شود.</CardDescription></CardHeader><CardContent className="space-y-3">{error ? <InlineError text={error} /> : null}{token ? <div className="rounded-lg border border-amber-300/15 bg-amber-300/[0.03] p-3"><p className="text-xs text-amber-100">توکن تازه — اکنون کپی کنید</p><code dir="ltr" className="mt-2 block overflow-x-auto rounded bg-black/20 p-2 text-left text-[11px] text-zinc-300">{token}</code><Button className="mt-2 border border-white/10 bg-white/5 text-zinc-300" size="sm" type="button" variant="secondary" onClick={() => void copy()}>{copied ? <CheckCircle2 className="size-4" /> : <Clipboard className="size-4" />}{copied ? 'کپی شد' : 'کپی توکن'}</Button></div> : null}<Button className="w-full bg-amber-300/10 text-amber-100 hover:bg-amber-300/20" disabled={!terminal || busy} size="sm" type="button" onClick={() => void invite()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} ساخت دعوت ۱ تا ۵</Button>{!terminal ? <p className="text-xs leading-6 text-zinc-600">دعوت پس از حل یا بستن پرونده فعال می‌شود.</p> : null}{loading ? <Loading text="در حال بارگذاری سابقه…" /> : <CsatHistory items={items} />}</CardContent></Card>;
}

function CsatHistory({ items }: { items: SupportCsatInvitation[] }) {
   if (!items.length) return <Empty text="دعوت یا پاسخ رضایتی ثبت نشده است." />;
   return <div className="space-y-2"><h3 className="text-xs font-medium text-zinc-400">سابقه دعوت و پاسخ</h3>{items.map((item) => <div key={item.id} className="rounded-lg border border-white/7 bg-black/10 px-3 py-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="text-zinc-500">{formatJalaliDateTime(item.createdAt)}</span><Badge variant="outline" className={item.response ? 'border-lime-300/15 text-lime-200' : item.invalidatedAt ? 'border-zinc-500/15 text-zinc-600' : 'border-amber-300/15 text-amber-200'}>{item.response ? `امتیاز ${item.response.score.toLocaleString('fa-IR')}` : item.invalidatedAt ? 'بی‌اعتبار' : 'منتظر پاسخ'}</Badge></div>{item.response?.comment ? <p className="mt-2 whitespace-pre-wrap leading-6 text-zinc-400">{item.response.comment}</p> : null}</div>)}</div>;
}

export function SupportCaseKnowledgeCard({ item }: { item: SupportCase }) {
   const support = useSupportWorkspace();
   const credentialActor = Boolean(support.access?.credentialScopes?.length);
   const canWork = supportCaseActionAccess(item, support.access).canWork && !credentialActor;
   const [query, setQuery] = useState('');
   const [results, setResults] = useState<SupportKnowledgePageSummary[]>([]);
   const [uses, setUses] = useState<SupportKnowledgeUse[]>([]);
   const [selectedPageId, setSelectedPageId] = useState('');
   const [usefulness, setUsefulness] = useState<SupportKnowledgeUsefulness>('HELPFUL');
   const [outcome, setOutcome] = useState<SupportKnowledgeOutcome>('ADVANCED');
   const [gapKind, setGapKind] = useState<SupportKnowledgeGapKind>('MISSING');
   const [feedback, setFeedback] = useState('');
   const [busy, setBusy] = useState('');
   const [notice, setNotice] = useState('');
   const [error, setError] = useState('');

   const loadUses = useCallback(async () => {
      if (credentialActor) return;
      try { setUses(await supportMaturityClient.listKnowledgeUses(item.key)); }
      catch (caught) { setError(message(caught, 'بارگذاری سابقه استفاده از دانش ناموفق بود.')); }
   }, [credentialActor, item.key]);

   useEffect(() => { setResults([]); setSelectedPageId(''); setNotice(''); void loadUses(); }, [loadUses]);

   if (credentialActor) return null;

   async function search(event: FormEvent<HTMLFormElement>) {
      event.preventDefault(); if (!query.trim() || busy) return;
      setBusy('search'); setError(''); setNotice('');
      try { const response = await supportMaturityClient.searchKnowledge(item.key, query.trim()); setResults(response.items); setSelectedPageId((current) => response.items.some((page) => page.id === current) ? current : response.items[0]?.id || ''); }
      catch (caught) { setError(message(caught, 'جست‌وجوی دانش ناموفق بود.')); }
      finally { setBusy(''); }
   }

   async function recordUse() {
      if (!selectedPageId || busy || !canWork) return;
      setBusy('use'); setError('');
      try { const recorded = await supportMaturityClient.recordKnowledgeUse(item.key, { pageId: selectedPageId, caseBaseVersion: item.version, usefulness, outcome }); setUses((current) => [recorded, ...current]); setNotice('استفاده و نتیجه مقاله ثبت شد.'); }
      catch (caught) { setError(message(caught, 'ثبت استفاده ناموفق بود؛ نسخه پرونده را تازه کنید.')); }
      finally { setBusy(''); }
   }

   async function createGap(event: FormEvent<HTMLFormElement>) {
      event.preventDefault(); if (feedback.trim().length < 3 || busy || !canWork || (gapKind === 'WRONG' && !selectedPageId)) return;
      setBusy('gap'); setError('');
      try { await supportMaturityClient.createKnowledgeGap(item.key, gapKind === 'MISSING' ? { kind: 'MISSING', caseBaseVersion: item.version, feedback: feedback.trim() } : { kind: 'WRONG', pageId: selectedPageId, caseBaseVersion: item.version, feedback: feedback.trim() }); setFeedback(''); setNotice(gapKind === 'MISSING' ? 'کمبود مقاله ثبت شد.' : 'اشکال مقاله ثبت شد.'); }
      catch (caught) { setError(message(caught, 'ثبت شکاف دانش ناموفق بود.')); }
      finally { setBusy(''); }
   }

   return <Card className="border-white/8 bg-[#171719] text-zinc-100" data-testid="support-case-kcs"><CardHeader className="border-b border-white/7"><CardTitle className="flex items-center gap-2 text-sm"><BookOpenCheck className="size-4 text-lime-300" /> دانش در جریان کار (KCS)</CardTitle><CardDescription className="mt-1.5 leading-6 text-zinc-600">دسترسی مقاله مستقل بررسی می‌شود؛ فقط نسخه، مفیدبودن و نتیجه ثبت می‌شود و متن پرونده به دانش کپی نمی‌شود.</CardDescription></CardHeader><CardContent className="space-y-5 p-4">{error ? <InlineError text={error} /> : null}{notice ? <p role="status" className="rounded-lg border border-lime-300/15 bg-lime-300/[0.03] px-3 py-2 text-xs text-lime-100">{notice}</p> : null}<form className="flex gap-2" onSubmit={search}><Input aria-label="جست‌وجوی دانش برای پرونده" className={inputClass} maxLength={200} placeholder="جست‌وجوی راهنما یا راه‌حل…" value={query} onChange={(event) => setQuery(event.target.value)} /><Button aria-label="جست‌وجوی دانش" className="bg-white/7 text-zinc-200" disabled={!query.trim() || busy === 'search'} size="icon" type="submit">{busy === 'search' ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}</Button></form>{results.length ? <div className="grid gap-2 sm:grid-cols-2">{results.map((page) => <button key={page.id} className={cn('rounded-lg border p-3 text-start', selectedPageId === page.id ? 'border-lime-300/25 bg-lime-300/[0.035]' : 'border-white/7 bg-black/10')} type="button" onClick={() => { setSelectedPageId(page.id); setGapKind('WRONG'); }}><span className="block text-sm text-zinc-200">{page.title}</span><span className="mt-1 block text-[11px] text-zinc-600">نسخه {page.version.toLocaleString('fa-IR')}</span>{page.summary ? <span className="mt-2 line-clamp-2 block text-xs leading-6 text-zinc-500">{page.summary}</span> : null}</button>)}</div> : null}{selectedPageId && canWork ? <div className="grid gap-2 rounded-xl border border-white/7 bg-black/10 p-3 sm:grid-cols-[1fr_1fr_auto]"><Field label="مفیدبودن"><select className={selectClass} value={usefulness} onChange={(event) => setUsefulness(event.target.value as SupportKnowledgeUsefulness)}><option value="HELPFUL">مفید</option><option value="PARTIAL">تا حدی مفید</option><option value="NOT_HELPFUL">غیرمفید</option></select></Field><Field label="نتیجه"><select className={selectClass} value={outcome} onChange={(event) => setOutcome(event.target.value as SupportKnowledgeOutcome)}><option value="RESOLVED">پرونده حل شد</option><option value="ADVANCED">کار پیش رفت</option><option value="NO_EFFECT">بدون اثر</option></select></Field><Button className="self-end bg-lime-300/10 text-lime-100" disabled={busy === 'use'} type="button" onClick={() => void recordUse()}>{busy === 'use' ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} ثبت استفاده</Button></div> : null}{canWork ? <form className="grid gap-3 border-t border-white/6 pt-4" onSubmit={createGap}><div className="flex items-center gap-2"><Lightbulb className="size-4 text-amber-200" /><h3 className="text-sm font-medium text-zinc-300">ثبت شکاف دانش</h3></div><div className="grid grid-cols-2 gap-1 rounded-lg bg-black/10 p-1"><button className={cn('rounded-md px-2 py-2 text-xs', gapKind === 'MISSING' ? 'bg-white/8 text-zinc-200' : 'text-zinc-600')} type="button" onClick={() => setGapKind('MISSING')}>مقاله وجود ندارد</button><button className={cn('rounded-md px-2 py-2 text-xs', gapKind === 'WRONG' ? 'bg-white/8 text-zinc-200' : 'text-zinc-600')} disabled={!selectedPageId} type="button" onClick={() => setGapKind('WRONG')}>مقاله انتخابی نادرست است</button></div><Textarea aria-label="بازخورد شکاف دانش" className={cn(inputClass, 'min-h-20')} maxLength={2000} minLength={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} /><Button className="justify-self-end border border-amber-300/15 bg-amber-300/5 text-amber-100" disabled={feedback.trim().length < 3 || busy === 'gap' || (gapKind === 'WRONG' && !selectedPageId)} type="submit" variant="secondary">{busy === 'gap' ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} ثبت برای بازبینی</Button></form> : null}<section className="border-t border-white/6 pt-4"><h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300"><History className="size-4 text-zinc-600" /> سابقه استفاده</h3><SupportKnowledgeUseHistory items={uses} /></section><p className="rounded-lg border border-lime-300/10 bg-lime-300/[0.02] px-3 py-2 text-xs leading-6 text-lime-100/55"><ShieldCheck className="me-1 inline size-3.5" />متن پرونده یا اطلاعات تماس در هیچ رکورد KCS نگهداری نمی‌شود.</p></CardContent></Card>;
}

function definitionKindLabel(kind: SupportEnablementDefinition['kind']) { return ({ MACRO: 'ماکرو', TEMPLATE: 'الگو', AUTOMATION: 'خودکارسازی' } as const)[kind]; }
function Field({ children, label }: { children: React.ReactNode; label: string }) { return <label className="grid gap-1.5 text-xs text-zinc-500"><span>{label}</span>{children}</label>; }
function InlineError({ text }: { text: string }) { return <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2 text-xs leading-6 text-red-200">{text}</p>; }
function Loading({ text }: { text: string }) { return <div className="flex items-center justify-center gap-2 py-6 text-xs text-zinc-600"><Loader2 className="size-4 animate-spin" />{text}</div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-xs leading-6 text-zinc-600">{text}</p>; }
function message(error: unknown, fallback: string) { return error instanceof Error && error.message ? error.message : fallback; }
const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
