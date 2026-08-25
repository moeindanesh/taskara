import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
   Archive,
   BookOpenCheck,
   Check,
   CheckCircle2,
   CircleOff,
   ClipboardCheck,
   GitMerge,
   Layers3,
   Loader2,
   Plus,
   RefreshCw,
   Save,
   ShieldCheck,
   Sparkles,
   Star,
   Users,
   X,
} from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportMaturityClient } from '@/lib/support-maturity-client';
import type {
   CreateSupportEnablementDefinitionInput,
   SupportAutomationCondition,
   SupportEnablementAction,
   SupportEnablementDefinition,
   SupportEnablementKind,
   SupportKnowledgeGap,
   SupportKnowledgeGapStatus,
   SupportLevel,
   SupportProblemCluster,
   SupportProblemClusterCase,
   SupportProblemClusterStatus,
   SupportQualityCriterion,
   SupportQualityFinding,
   SupportQualityReview,
   SupportQualityRubric,
} from '@/lib/support-maturity-types';
import { supportPriorityLabels, supportStatusLabels } from '@/lib/support-presenters';
import {
   supportCasePriorities,
   supportCaseSources,
   supportCaseStatuses,
   type SupportCasePriority,
   type SupportCaseSource,
   type SupportCaseStatus,
} from '@/lib/support-types';
import { taskaraRequest } from '@/lib/taskara-client';
import type { PaginatedResponse, TaskaraUser } from '@/lib/taskara-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { cn } from '@/lib/utils';

type MaturityTab = 'definitions' | 'clusters' | 'knowledge' | 'quality';
type UserSummary = { id: string; name: string };

const maturityTabs: Array<{ id: MaturityTab; label: string; icon: typeof Sparkles }> = [
   { id: 'definitions', label: 'ماکرو و خودکارسازی', icon: Sparkles },
   { id: 'clusters', label: 'مسئله‌های پرتکرار', icon: GitMerge },
   { id: 'knowledge', label: 'شکاف‌های دانش', icon: BookOpenCheck },
   { id: 'quality', label: 'کیفیت و بازبینی', icon: Star },
];

export function SupportMaturityView() {
   const [tab, setTab] = useState<MaturityTab>('definitions');
   return (
      <main dir="rtl" className="h-full min-h-0 overflow-y-auto bg-[#101011] p-4 text-zinc-100 sm:p-5" data-testid="support-maturity-screen">
         <div className="mx-auto max-w-7xl space-y-5">
            <section className="rounded-xl border border-white/7 bg-[#171719] p-1.5">
               <div className="grid gap-1 sm:grid-cols-4">{maturityTabs.map((entry) => { const Icon = entry.icon; return <button key={entry.id} className={cn('flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs transition', tab === entry.id ? 'bg-white/8 text-zinc-100' : 'text-zinc-600 hover:bg-white/[0.035] hover:text-zinc-300')} type="button" onClick={() => setTab(entry.id)}><Icon className="size-4" />{entry.label}</button>; })}</div>
            </section>
            {tab === 'definitions' ? <EnablementDefinitionsSection /> : null}
            {tab === 'clusters' ? <ProblemClustersSection /> : null}
            {tab === 'knowledge' ? <KnowledgeGapsSection /> : null}
            {tab === 'quality' ? <QualitySection /> : null}
         </div>
      </main>
   );
}

function EnablementDefinitionsSection() {
   const runtime = useWorkspaceRuntime();
   const canConfigure = runtime.permissions.has('support.setup') && (runtime.role === 'OWNER' || runtime.role === 'ADMIN');
   const [items, setItems] = useState<SupportEnablementDefinition[]>([]);
   const [loading, setLoading] = useState(true);
   const [busyId, setBusyId] = useState('');
   const [error, setError] = useState('');
   const [builderOpen, setBuilderOpen] = useState(false);
   const [source, setSource] = useState<SupportEnablementDefinition>();

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         const result = await supportMaturityClient.listDefinitions({ limit: 100 });
         setItems(result.items);
      } catch (caught) {
         setError(message(caught, 'بارگذاری نسخه‌های توانمندسازی ناموفق بود.'));
      } finally {
         setLoading(false);
      }
   }, []);

   useEffect(() => { void load(); }, [load]);

   async function lifecycle(item: SupportEnablementDefinition, action: 'approve' | 'retire') {
      if (busyId) return;
      setBusyId(item.id);
      setError('');
      try {
         const updated = action === 'approve'
            ? await supportMaturityClient.approveDefinition(item.id)
            : await supportMaturityClient.retireDefinition(item.id);
         setItems((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
         await load();
      } catch (caught) {
         setError(message(caught, action === 'approve' ? 'تأیید نسخه ناموفق بود.' : 'بازنشسته‌کردن نسخه ناموفق بود.'));
      } finally {
         setBusyId('');
      }
   }

   return (
      <>
         <Card className="border-white/8 bg-[#171719] text-zinc-100">
            <CardHeader className="border-b border-white/7">
               <div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-base"><Layers3 className="size-4 text-violet-300" /> تعریف‌های نسخه‌دار</CardTitle><CardDescription className="mt-1.5 max-w-3xl leading-6 text-zinc-500">ماکرو، الگو و خودکارسازی فقط فیلدهای بسته و برگشت‌پذیر پرونده را تغییر می‌دهند. تأیید نسخه تازه، نسخه تأییدشده قبلی همان کلید را بازنشسته می‌کند.</CardDescription></div><div className="flex gap-2"><Button aria-label="تازه‌سازی تعریف‌ها" className="border border-white/10 bg-white/5 text-zinc-300" size="icon" type="button" variant="secondary" onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button>{canConfigure ? <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" type="button" onClick={() => { setSource(undefined); setBuilderOpen(true); }}><Plus className="size-4" /> تعریف یا نسخه جدید</Button> : null}</div></div>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
               {error ? <InlineError text={error} /> : null}
               {loading && !items.length ? <Loading text="در حال بارگذاری تعریف‌ها…" /> : null}
               {!loading && !items.length ? <Empty text="تعریف تأییدشده‌ای برای محدوده شما وجود ندارد." /> : null}
               {items.map((item) => <EnablementDefinitionRow key={item.id} busy={busyId === item.id} canConfigure={canConfigure} item={item} onApprove={() => void lifecycle(item, 'approve')} onCopy={() => { setSource(item); setBuilderOpen(true); }} onRetire={() => void lifecycle(item, 'retire')} />)}
               {!canConfigure ? <PrivacyNote>مدیر یا سرپرست تعریف‌های تأییدشده را می‌بیند؛ ساخت، تأیید و بازنشستگی فقط برای مدیر فضای کاری فعال است.</PrivacyNote> : null}
            </CardContent>
         </Card>
         {canConfigure ? <EnablementBuilderDialog open={builderOpen} source={source} onOpenChange={setBuilderOpen} onCreated={(created) => setItems((current) => [created, ...current])} /> : null}
      </>
   );
}

function EnablementDefinitionRow({ busy, canConfigure, item, onApprove, onCopy, onRetire }: {
   busy: boolean;
   canConfigure: boolean;
   item: SupportEnablementDefinition;
   onApprove: () => void;
   onCopy: () => void;
   onRetire: () => void;
}) {
   return <article className={cn('rounded-xl border p-4', item.status === 'APPROVED' ? 'border-lime-300/15 bg-lime-300/[0.025]' : 'border-white/7 bg-black/10')}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="border-white/10 text-zinc-500">{enablementKindLabel(item.kind)}</Badge><bdi dir="ltr" className="font-mono text-xs text-zinc-500">{item.definitionKey} / v{item.version}</bdi><Badge variant="outline" className={enablementStatusTone(item.status)}>{enablementStatusLabel(item.status)}</Badge></div><h3 className="mt-2 text-sm font-semibold text-zinc-200">{item.name}</h3>{item.description ? <p className="mt-1 max-w-3xl text-xs leading-6 text-zinc-500">{item.description}</p> : null}<div className="mt-3 flex flex-wrap gap-1.5">{item.actions.map((action, index) => <span key={`${action.type}:${index}`} className="rounded-md border border-white/7 bg-white/[0.025] px-2 py-1 text-[11px] text-zinc-500">{actionLabel(action)}</span>)}</div>{item.kind === 'AUTOMATION' ? <p className="mt-2 text-[11px] text-zinc-600">{item.conditions?.length || 0} شرط بسته · اعمال خودکار غیرفعال</p> : null}</div>{canConfigure ? <div className="flex flex-wrap gap-2"><Button className="border border-white/10 bg-white/5 text-zinc-300" size="sm" type="button" variant="secondary" onClick={onCopy}>نسخه جدید از این</Button>{item.status === 'DRAFT' ? <Button className="bg-lime-300/10 text-lime-100 hover:bg-lime-300/20" disabled={busy} size="sm" type="button" onClick={onApprove}>{busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} تأیید نسخه</Button> : null}{item.status === 'APPROVED' ? <Button className="border border-amber-300/15 bg-amber-300/5 text-amber-100" disabled={busy} size="sm" type="button" variant="secondary" onClick={onRetire}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />} بازنشسته‌کردن</Button> : null}</div> : null}</div></article>;
}

function EnablementBuilderDialog({ onCreated, onOpenChange, open, source }: {
   onCreated: (item: SupportEnablementDefinition) => void;
   onOpenChange: (open: boolean) => void;
   open: boolean;
   source?: SupportEnablementDefinition;
}) {
   const [kind, setKind] = useState<SupportEnablementKind>('MACRO');
   const [definitionKey, setDefinitionKey] = useState('');
   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [actions, setActions] = useState<SupportEnablementAction[]>([{ type: 'SET_PRIORITY', value: 'NORMAL' }]);
   const [conditions, setConditions] = useState<SupportAutomationCondition[]>([{ field: 'STATUS', value: 'OPEN' }]);
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      if (!open) return;
      setKind(source?.kind || 'MACRO');
      setDefinitionKey(source?.definitionKey || '');
      setName(source ? `${source.name} — نسخه جدید` : '');
      setDescription(source?.description || '');
      setActions(source?.actions.length ? source.actions.map((action) => ({ ...action })) : [{ type: 'SET_PRIORITY', value: 'NORMAL' }]);
      setConditions(source?.conditions?.length ? source.conditions.map((condition) => ({ ...condition })) : [{ field: 'STATUS', value: 'OPEN' }]);
      setError('');
   }, [open, source]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (busy || !definitionKey.trim() || name.trim().length < 2 || !actions.length || (kind === 'AUTOMATION' && !conditions.length)) return;
      const input: CreateSupportEnablementDefinitionInput = {
         kind, definitionKey: definitionKey.trim().toLowerCase(), name: name.trim(),
         description: description.trim() || undefined, actions,
         ...(kind === 'AUTOMATION' ? { conditions } : {}),
      };
      setBusy(true);
      setError('');
      try {
         onCreated(await supportMaturityClient.createDefinition(input));
         onOpenChange(false);
      } catch (caught) {
         setError(message(caught, 'ساخت نسخه تعریف ناموفق بود.'));
      } finally {
         setBusy(false);
      }
   }

   return <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}><DialogContent dir="rtl" className="max-h-[92vh] max-w-4xl overflow-y-auto border-white/10 bg-[#171719] text-zinc-100"><DialogHeader><DialogTitle>{source ? 'نسخه جدید تعریف' : 'تعریف تازه'}</DialogTitle><DialogDescription className="leading-6 text-zinc-500">نسخه ساخته‌شده پیش‌نویس است. قبل از تأیید، اقدام‌ها و شرط‌های تایپ‌شده را بازبینی کنید.</DialogDescription></DialogHeader><form className="space-y-5" onSubmit={submit}>{error ? <InlineError text={error} /> : null}<div className="grid gap-3 md:grid-cols-3"><Field label="گونه"><select className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as SupportEnablementKind)}><option value="MACRO">ماکرو</option><option value="TEMPLATE">الگو</option><option value="AUTOMATION">خودکارسازی</option></select></Field><Field label="کلید ثابت"><Input dir="ltr" className={cn(inputClass, 'text-left')} pattern="[a-z0-9][a-z0-9_-]+" required value={definitionKey} onChange={(event) => setDefinitionKey(event.target.value)} /></Field><Field label="نام نسخه"><Input className={inputClass} minLength={2} maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} /></Field></div><Field label="توضیح"><Textarea className={cn(inputClass, 'min-h-16')} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} /></Field><DefinitionListEditor title="اقدام‌های برگشت‌پذیر" addLabel="افزودن اقدام" onAdd={() => setActions((current) => [...current, { type: 'SET_PRIORITY', value: 'NORMAL' }])}>{actions.map((action, index) => <ActionEditor key={index} action={action} removable={actions.length > 1} onChange={(next) => setActions((current) => current.map((entry, itemIndex) => itemIndex === index ? next : entry))} onRemove={() => setActions((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</DefinitionListEditor>{kind === 'AUTOMATION' ? <DefinitionListEditor title="شرط‌های خودکارسازی" addLabel="افزودن شرط" onAdd={() => setConditions((current) => [...current, { field: 'STATUS', value: 'OPEN' }])}>{conditions.map((condition, index) => <ConditionEditor key={index} condition={condition} removable={conditions.length > 1} onChange={(next) => setConditions((current) => current.map((entry, itemIndex) => itemIndex === index ? next : entry))} onRemove={() => setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index))} />)}</DefinitionListEditor> : null}<PrivacyNote>تعریف‌ها امکان اجرای اسکریپت، وب‌هوک، خواندن اطلاعات تماس یا ارسال پیام ندارند. اعمال نهایی همیشه پیش‌نمایش و تأیید انسانی می‌خواهد.</PrivacyNote><DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-zinc-100 text-zinc-950" disabled={busy || !actions.length} type="submit">{busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} ساخت پیش‌نویس</Button><Button disabled={busy} type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter></form></DialogContent></Dialog>;
}

function DefinitionListEditor({ addLabel, children, onAdd, title }: { addLabel: string; children: React.ReactNode; onAdd: () => void; title: string }) {
   return <section className="space-y-3 rounded-xl border border-white/7 bg-black/10 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium text-zinc-300">{title}</h3><Button className="h-8 border border-white/10 bg-white/5 text-zinc-400" size="sm" type="button" variant="secondary" onClick={onAdd}><Plus className="size-3.5" />{addLabel}</Button></div>{children}</section>;
}

function ActionEditor({ action, onChange, onRemove, removable }: { action: SupportEnablementAction; onChange: (value: SupportEnablementAction) => void; onRemove: () => void; removable: boolean }) {
   return <div className="grid gap-2 rounded-lg border border-white/7 bg-[#111113] p-3 sm:grid-cols-[220px_1fr_auto]"><select aria-label="نوع اقدام" className={selectClass} value={action.type} onChange={(event) => onChange(defaultAction(event.target.value as SupportEnablementAction['type']))}>{actionTypes.map((type) => <option key={type} value={type}>{actionTypeLabel(type)}</option>)}</select><ActionValueEditor action={action} onChange={onChange} />{removable ? <Button aria-label="حذف اقدام" className="text-zinc-600" size="icon" type="button" variant="ghost" onClick={onRemove}><X className="size-4" /></Button> : null}</div>;
}

function ActionValueEditor({ action, onChange }: { action: SupportEnablementAction; onChange: (value: SupportEnablementAction) => void }) {
   if (action.type === 'CLEAR_NEXT_ACTION') return <p className="self-center text-xs text-zinc-600">موعد اقدام بعدی پاک می‌شود.</p>;
   if (action.type === 'SET_PRIORITY') return <select aria-label="مقدار اولویت" className={selectClass} value={action.value} onChange={(event) => onChange({ ...action, value: event.target.value as SupportCasePriority })}>{supportCasePriorities.map((value) => <option key={value} value={value}>{supportPriorityLabels[value]}</option>)}</select>;
   if (action.type === 'SET_IMPACT' || action.type === 'SET_URGENCY') return <select aria-label="مقدار سطح" className={selectClass} value={action.value || ''} onChange={(event) => onChange({ ...action, value: (event.target.value || null) as SupportLevel | null })}><option value="">پاک‌کردن مقدار</option>{levels.map((value) => <option key={value} value={value}>{levelLabel(value)}</option>)}</select>;
   if (action.type === 'SET_TYPE_KEY') return <Input aria-label="نوع پرونده" dir="ltr" className={cn(inputClass, 'text-left')} pattern="[a-z][a-z0-9_-]*" required value={action.value} onChange={(event) => onChange({ ...action, value: event.target.value.toLowerCase() })} />;
   return <LazyJalaliDatePicker ariaLabel="موعد اقدام بعدی" showTime value={action.value} onChange={(value) => value && onChange({ ...action, value })} />;
}

function ConditionEditor({ condition, onChange, onRemove, removable }: { condition: SupportAutomationCondition; onChange: (value: SupportAutomationCondition) => void; onRemove: () => void; removable: boolean }) {
   return <div className="grid gap-2 rounded-lg border border-white/7 bg-[#111113] p-3 sm:grid-cols-[220px_1fr_auto]"><select aria-label="فیلد شرط" className={selectClass} value={condition.field} onChange={(event) => onChange(defaultCondition(event.target.value as SupportAutomationCondition['field']))}>{conditionFields.map((field) => <option key={field} value={field}>{conditionFieldLabel(field)}</option>)}</select><ConditionValueEditor condition={condition} onChange={onChange} />{removable ? <Button aria-label="حذف شرط" className="text-zinc-600" size="icon" type="button" variant="ghost" onClick={onRemove}><X className="size-4" /></Button> : null}</div>;
}

function ConditionValueEditor({ condition, onChange }: { condition: SupportAutomationCondition; onChange: (value: SupportAutomationCondition) => void }) {
   if (condition.field === 'PRIORITY') return <select aria-label="مقدار شرط اولویت" className={selectClass} value={condition.value} onChange={(event) => onChange({ ...condition, value: event.target.value as SupportCasePriority })}>{supportCasePriorities.map((value) => <option key={value} value={value}>{supportPriorityLabels[value]}</option>)}</select>;
   if (condition.field === 'IMPACT' || condition.field === 'URGENCY') return <select aria-label="مقدار شرط سطح" className={selectClass} value={condition.value} onChange={(event) => onChange({ ...condition, value: event.target.value as SupportLevel })}>{levels.map((value) => <option key={value} value={value}>{levelLabel(value)}</option>)}</select>;
   if (condition.field === 'STATUS') return <select aria-label="مقدار شرط وضعیت" className={selectClass} value={condition.value} onChange={(event) => onChange({ ...condition, value: event.target.value as SupportCaseStatus })}>{supportCaseStatuses.map((value) => <option key={value} value={value}>{supportStatusLabels[value]}</option>)}</select>;
   if (condition.field === 'SOURCE_CHANNEL') return <select aria-label="مقدار شرط کانال" className={selectClass} value={condition.value} onChange={(event) => onChange({ ...condition, value: event.target.value as SupportCaseSource })}>{supportCaseSources.map((value) => <option key={value} value={value}>{sourceLabel(value)}</option>)}</select>;
   if (condition.field === 'DEPARTMENT_ASSIGNED') return <select aria-label="مقدار شرط دپارتمان" className={selectClass} value={String(condition.value)} onChange={(event) => onChange({ ...condition, value: event.target.value === 'true' })}><option value="true">دپارتمان دارد</option><option value="false">بدون دپارتمان</option></select>;
   return <Input aria-label="مقدار شرط نوع پرونده" dir="ltr" className={cn(inputClass, 'text-left')} pattern="[a-z][a-z0-9_-]*" required value={condition.value} onChange={(event) => onChange({ ...condition, value: event.target.value.toLowerCase() })} />;
}

function ProblemClustersSection() {
   const support = useSupportWorkspace();
   const runtime = useWorkspaceRuntime();
   const [items, setItems] = useState<SupportProblemCluster[]>([]);
   const [selected, setSelected] = useState<SupportProblemCluster>();
   const [query, setQuery] = useState('');
   const [status, setStatus] = useState<SupportProblemClusterStatus | ''>('OPEN');
   const [title, setTitle] = useState('');
   const [summary, setSummary] = useState('');
   const [caseKey, setCaseKey] = useState('');
   const [loading, setLoading] = useState(true);
   const [busy, setBusy] = useState('');
   const [error, setError] = useState('');

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         const result = await supportMaturityClient.listClusters({ q: query.trim() || undefined, status: status || undefined, limit: 100 });
         setItems(result.items);
         if (selected && !result.items.some((entry) => entry.id === selected.id)) setSelected(undefined);
      } catch (caught) {
         setError(message(caught, 'بارگذاری مسئله‌های پرتکرار ناموفق بود.'));
      } finally {
         setLoading(false);
      }
   }, [query, selected, status]);

   useEffect(() => { void load(); }, [load]);

   async function selectCluster(id: string) {
      setBusy(`select:${id}`);
      setError('');
      try { setSelected(await supportMaturityClient.getCluster(id)); }
      catch (caught) { setError(message(caught, 'بارگذاری جزئیات مسئله ناموفق بود.')); }
      finally { setBusy(''); }
   }

   async function create(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (title.trim().length < 3 || busy) return;
      setBusy('create'); setError('');
      try {
         const created = await supportMaturityClient.createCluster({ title: title.trim(), summary: summary.trim() || undefined });
         setItems((current) => [created, ...current]); setTitle(''); setSummary(''); setSelected(await supportMaturityClient.getCluster(created.id));
      } catch (caught) { setError(message(caught, 'ساخت مسئله پرتکرار ناموفق بود.')); }
      finally { setBusy(''); }
   }

   async function changeStatus(nextStatus: SupportProblemClusterStatus) {
      if (!selected || busy) return;
      setBusy('status'); setError('');
      try {
         const updated = await supportMaturityClient.updateCluster(selected.id, { baseVersion: selected.version, status: nextStatus });
         setSelected({ ...selected, ...updated }); setItems((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      } catch (caught) { setError(message(caught, 'تغییر وضعیت مسئله ناموفق بود.')); }
      finally { setBusy(''); }
   }

   async function linkCase(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!selected || !caseKey.trim() || busy) return;
      setBusy('link'); setError('');
      try {
         const supportCase = await support.loadCase(caseKey.trim());
         const updated = await supportMaturityClient.linkClusterCase(selected.id, supportCase.key, { clusterBaseVersion: selected.version, caseBaseVersion: supportCase.version });
         setSelected(updated); setItems((current) => current.map((entry) => entry.id === updated.id ? { ...entry, ...updated, cases: undefined } : entry)); setCaseKey('');
      } catch (caught) { setError(message(caught, 'پیوند پرونده ناموفق بود؛ نسخه‌ها را تازه کنید.')); }
      finally { setBusy(''); }
   }

   async function unlinkCase(link: SupportProblemClusterCase) {
      if (!selected || busy) return;
      setBusy(`unlink:${link.key}`); setError('');
      try {
         await supportMaturityClient.unlinkClusterCase(selected.id, link.key, { clusterBaseVersion: selected.version, caseBaseVersion: link.version });
         const updated = await supportMaturityClient.getCluster(selected.id); setSelected(updated); setItems((current) => current.map((entry) => entry.id === updated.id ? { ...entry, ...updated, cases: undefined } : entry));
      } catch (caught) { setError(message(caught, 'حذف پیوند ناموفق بود؛ نسخه‌ها را تازه کنید.')); }
      finally { setBusy(''); }
   }

   return <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]"><div className="space-y-4"><Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="size-4 text-violet-300" /> مسئله canonical تازه</CardTitle><CardDescription className="leading-6 text-zinc-500">عنوان و خلاصه باید پاک‌سازی‌شده و بدون اطلاعات تماس یا متن خصوصی پرونده باشند.</CardDescription></CardHeader><CardContent><form className="grid gap-3" onSubmit={create}>{error ? <InlineError text={error} /> : null}<Field label="عنوان مسئله"><Input className={inputClass} minLength={3} maxLength={160} required value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Field label="خلاصه پاک‌سازی‌شده"><Textarea className={cn(inputClass, 'min-h-20')} maxLength={2000} value={summary} onChange={(event) => setSummary(event.target.value)} /></Field><Button className="bg-zinc-100 text-zinc-950" disabled={title.trim().length < 3 || busy === 'create'} type="submit">{busy === 'create' ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} ساخت مسئله</Button></form></CardContent></Card><Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><GitMerge className="size-4 text-sky-300" /> فهرست مسئله‌ها</CardTitle></CardHeader><CardContent className="space-y-3"><div className="grid gap-2 sm:grid-cols-[1fr_130px]"><Input aria-label="جست‌وجوی مسئله" className={inputClass} placeholder="جست‌وجو…" value={query} onChange={(event) => setQuery(event.target.value)} /><select aria-label="وضعیت مسئله" className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as SupportProblemClusterStatus | '')}><option value="">همه</option><option value="OPEN">باز</option><option value="RESOLVED">حل‌شده</option><option value="ARCHIVED">بایگانی</option></select></div>{loading ? <Loading text="در حال بارگذاری مسئله‌ها…" /> : null}{!loading && !items.length ? <Empty text="مسئله‌ای در محدوده دسترسی شما نیست." /> : null}<div className="space-y-2">{items.map((item) => <button key={item.id} className={cn('w-full rounded-lg border p-3 text-start', selected?.id === item.id ? 'border-sky-300/20 bg-sky-300/[0.035]' : 'border-white/7 bg-black/10')} type="button" onClick={() => void selectCluster(item.id)}><div className="flex items-start justify-between gap-2"><span className="text-sm text-zinc-200">{item.title}</span>{busy === `select:${item.id}` ? <Loader2 className="size-4 animate-spin text-zinc-600" /> : <Badge variant="outline" className="border-white/10 text-zinc-500">{item.visibleMemberCount.toLocaleString('fa-IR')} قابل مشاهده</Badge>}</div><p className="mt-1 text-[11px] text-zinc-600">{clusterStatusLabel(item.status)} · {formatJalaliDateTime(item.updatedAt)}</p></button>)}</div></CardContent></Card></div><Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4 text-lime-300" /> عضویت privacy-filtered</CardTitle><CardDescription className="leading-6 text-zinc-500">فقط پرونده‌هایی که همین حالا مستقل از خوشه اجازه خواندنشان را دارید نمایش داده می‌شوند.</CardDescription></CardHeader><CardContent className="space-y-4">{!selected ? <Empty text="برای دیدن پرونده‌های مجاز، یک مسئله را انتخاب کنید." /> : <><SupportProblemClusterDetail cluster={selected} busyCaseKey={busy} caseHref={(entry) => `/${runtime.workspaceSlug}/support/cases/${encodeURIComponent(entry.key)}`} onStatus={(next) => void changeStatus(next)} onUnlink={(entry) => void unlinkCase(entry)} /><form className="flex gap-2 border-t border-white/6 pt-4" onSubmit={linkCase}><Input aria-label="کلید پرونده برای پیوند" dir="ltr" className={cn(inputClass, 'text-left')} placeholder="SUP-42" required value={caseKey} onChange={(event) => setCaseKey(event.target.value)} /><Button className="bg-sky-300/10 text-sky-100" disabled={!caseKey.trim() || busy === 'link'} type="submit">{busy === 'link' ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />} پیوند پرونده مجاز</Button></form></>}</CardContent></Card></div>;
}

export function SupportProblemClusterDetail({ busyCaseKey, caseHref, cluster, onStatus, onUnlink }: {
   busyCaseKey: string;
   caseHref?: (item: SupportProblemClusterCase) => string;
   cluster: SupportProblemCluster;
   onStatus: (status: SupportProblemClusterStatus) => void;
   onUnlink: (item: SupportProblemClusterCase) => void;
}) {
   return <section className="space-y-4" data-testid={`support-cluster-${cluster.id}`}><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold text-zinc-100">{cluster.title}</h3><Badge variant="outline" className="border-white/10 text-zinc-500">{cluster.visibleMemberCount.toLocaleString('fa-IR')} پرونده قابل مشاهده</Badge></div>{cluster.summary ? <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-400">{cluster.summary}</p> : null}</div><div className="flex flex-wrap gap-2"><span className="self-center text-xs text-zinc-600">وضعیت:</span>{(['OPEN', 'RESOLVED', 'ARCHIVED'] as const).map((status) => <Button key={status} className={cluster.status === status ? 'bg-white/10 text-zinc-100' : 'border border-white/8 bg-white/[0.025] text-zinc-600'} disabled={busyCaseKey === 'status' || cluster.status === status} size="sm" type="button" variant="secondary" onClick={() => onStatus(status)}>{clusterStatusLabel(status)}</Button>)}</div><PrivacyNote>تعداد و پیوندها فقط از پرونده‌های مجاز شما محاسبه شده‌اند؛ تعداد کل یا پرونده همکاران افشا نمی‌شود.</PrivacyNote><div className="space-y-2">{!cluster.cases?.length ? <Empty text="پرونده قابل مشاهده‌ای به این مسئله پیوند نشده است." /> : cluster.cases.map((item) => <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/7 bg-black/10 p-3"><div className="min-w-0">{caseHref ? <a className="font-mono text-xs text-sky-300 hover:underline" href={caseHref(item)}>{item.key}</a> : <bdi dir="ltr" className="font-mono text-xs text-sky-300">{item.key}</bdi>}<p className="mt-1 truncate text-sm text-zinc-300">{item.title}</p><p className="mt-1 text-[11px] text-zinc-600">{supportStatusLabels[item.status]} · {supportPriorityLabels[item.priority]} · پیوند {formatJalaliDateTime(item.linkedAt)}</p></div><Button aria-label={`حذف پیوند ${item.key}`} className="border border-red-300/10 bg-red-300/[0.025] text-red-200" disabled={busyCaseKey === `unlink:${item.key}`} size="sm" type="button" variant="secondary" onClick={() => onUnlink(item)}>{busyCaseKey === `unlink:${item.key}` ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />} حذف پیوند</Button></article>)}</div></section>;
}

function KnowledgeGapsSection() {
   const [items, setItems] = useState<SupportKnowledgeGap[]>([]);
   const [users, setUsers] = useState<UserSummary[]>([]);
   const [status, setStatus] = useState<SupportKnowledgeGapStatus | ''>('OPEN');
   const [loading, setLoading] = useState(true);
   const [busyId, setBusyId] = useState('');
   const [error, setError] = useState('');

   const load = useCallback(async () => {
      setLoading(true); setError('');
      try {
         const [gaps, userResult] = await Promise.all([
            supportMaturityClient.listKnowledgeGaps({ status: status || undefined, limit: 100 }),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=100').catch(() => ({ items: [], total: 0, limit: 0, offset: 0 })),
         ]);
         setItems(gaps.items); setUsers(userResult.items.filter((user) => user.kind !== 'AGENT').map((user) => ({ id: user.id, name: user.name })));
      } catch (caught) { setError(message(caught, 'بارگذاری شکاف‌های دانش ناموفق بود.')); }
      finally { setLoading(false); }
   }, [status]);

   useEffect(() => { void load(); }, [load]);

   async function update(item: SupportKnowledgeGap, input: { status?: SupportKnowledgeGapStatus; reviewOwnerId?: string | null }) {
      if (busyId) return;
      setBusyId(item.id); setError('');
      try {
         const updated = await supportMaturityClient.updateKnowledgeGap(item.id, { baseVersion: item.version, ...input });
         setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, ...updated, case: entry.case, page: entry.page } : entry));
      } catch (caught) { setError(message(caught, 'به‌روزرسانی شکاف دانش ناموفق بود؛ فهرست را تازه کنید.')); }
      finally { setBusyId(''); }
   }

   return <Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader className="border-b border-white/7"><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-base"><BookOpenCheck className="size-4 text-lime-300" /> صف بازبینی دانش</CardTitle><CardDescription className="mt-1.5 max-w-3xl leading-6 text-zinc-500">کمبود مقاله و گزارش مقاله نادرست تا تعیین مالک و حل انسانی در پشتیبانی باقی می‌ماند. دسترسی مقاله در هر بار نمایش دوباره بررسی می‌شود.</CardDescription></div><div className="flex gap-2"><select aria-label="فیلتر وضعیت شکاف دانش" className={cn(selectClass, 'w-40')} value={status} onChange={(event) => setStatus(event.target.value as SupportKnowledgeGapStatus | '')}><option value="">همه</option><option value="OPEN">باز</option><option value="IN_REVIEW">در حال بررسی</option><option value="RESOLVED">حل‌شده</option></select><Button aria-label="تازه‌سازی شکاف‌ها" className="border border-white/10 bg-white/5 text-zinc-300" size="icon" type="button" variant="secondary" onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button></div></div></CardHeader><CardContent className="space-y-3 p-4">{error ? <InlineError text={error} /> : null}{loading ? <Loading text="در حال بارگذاری شکاف‌های مجاز…" /> : null}{!loading && !items.length ? <Empty text="شکاف دانشی در این وضعیت و محدوده دسترسی نیست." /> : null}{items.map((item) => <SupportKnowledgeGapItem key={item.id} busy={busyId === item.id} item={item} users={users} onUpdate={(input) => void update(item, input)} />)}<PrivacyNote>ردیف‌های مقاله نادرست پس از لغو دسترسی مقاله حذف می‌شوند؛ شناسه یا عنوان مقاله مجوز ماندگار ایجاد نمی‌کند.</PrivacyNote></CardContent></Card>;
}

export function SupportKnowledgeGapItem({ busy, item, onUpdate, users }: {
   busy: boolean;
   item: SupportKnowledgeGap;
   onUpdate: (input: { status?: SupportKnowledgeGapStatus; reviewOwnerId?: string | null }) => void;
   users: UserSummary[];
}) {
   const owner = users.find((user) => user.id === item.reviewOwnerId);
   return <article className="rounded-xl border border-white/7 bg-black/10 p-4" data-testid={`support-knowledge-gap-${item.id}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className={item.kind === 'MISSING' ? 'border-amber-300/15 text-amber-200' : 'border-red-300/15 text-red-200'}>{item.kind === 'MISSING' ? 'مقاله مفقود' : 'مقاله نادرست'}</Badge>{item.case ? <bdi dir="ltr" className="font-mono text-xs text-sky-300">{item.case.key}</bdi> : null}<span className="text-xs text-zinc-600">{knowledgeGapStatusLabel(item.status)}</span></div>{item.page ? <p className="mt-2 text-sm text-zinc-300">{item.page.title} · نسخه {item.page.version.toLocaleString('fa-IR')}</p> : null}<p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-400">{item.feedback}</p><p className="mt-2 text-[11px] text-zinc-600">مالک بازبینی: {owner?.name || (item.reviewOwnerId ? 'عضو مجاز' : 'تعیین نشده')} · به‌روزرسانی {formatJalaliDateTime(item.updatedAt)}</p></div>{busy ? <Loader2 className="size-4 animate-spin text-zinc-600" /> : null}</div><div className="mt-3 grid gap-2 border-t border-white/6 pt-3 sm:grid-cols-2"><Field label="وضعیت بازبینی"><select aria-label={`وضعیت شکاف ${item.id}`} className={selectClass} disabled={busy} value={item.status} onChange={(event) => onUpdate({ status: event.target.value as SupportKnowledgeGapStatus })}><option value="OPEN">باز</option><option value="IN_REVIEW">در حال بررسی</option><option value="RESOLVED">حل‌شده</option></select></Field><Field label="مالک بازبینی"><select aria-label={`مالک شکاف ${item.id}`} className={selectClass} disabled={busy} value={item.reviewOwnerId || ''} onChange={(event) => onUpdate({ reviewOwnerId: event.target.value || null })}><option value="">بدون مالک</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field></div></article>;
}

function QualitySection() {
   const support = useSupportWorkspace();
   const runtime = useWorkspaceRuntime();
   const canConfigure = runtime.permissions.has('support.setup');
   const canReview = Boolean(support.access?.workspaceWide || support.access?.managedDepartmentIds.length);
   const [rubrics, setRubrics] = useState<SupportQualityRubric[]>([]);
   const [reviews, setReviews] = useState<SupportQualityReview[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [rubricOpen, setRubricOpen] = useState(false);
   const [rubricSource, setRubricSource] = useState<SupportQualityRubric>();

   const load = useCallback(async () => {
      setLoading(true); setError('');
      try {
         const [loadedRubrics, loadedReviews] = await Promise.all([supportMaturityClient.listRubrics(), supportMaturityClient.listReviews()]);
         setRubrics(loadedRubrics); setReviews(loadedReviews);
      } catch (caught) { setError(message(caught, 'بارگذاری کیفیت و بازبینی‌ها ناموفق بود.')); }
      finally { setLoading(false); }
   }, []);

   useEffect(() => { void load(); }, [load]);

   return <div className="space-y-4"><Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader className="border-b border-white/7"><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-base"><ClipboardCheck className="size-4 text-violet-300" /> معیارهای نسخه‌دار کیفیت</CardTitle><CardDescription className="mt-1.5 leading-6 text-zinc-500">هر تغییر یک rubric تازه می‌سازد؛ بازبینی‌های قبلی به همان نسخه و مالک پرونده در لحظه ارزیابی متصل می‌مانند.</CardDescription></div>{canConfigure ? <Button className="bg-zinc-100 text-zinc-950" type="button" onClick={() => { setRubricSource(undefined); setRubricOpen(true); }}><Plus className="size-4" /> معیار جدید</Button> : null}</div></CardHeader><CardContent className="space-y-3 p-4">{error ? <InlineError text={error} /> : null}{loading ? <Loading text="در حال بارگذاری معیارها…" /> : null}{rubrics.map((rubric) => <article key={rubric.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-white/7 bg-black/10 p-4"><div><div className="flex items-center gap-2"><bdi dir="ltr" className="font-mono text-xs text-zinc-500">{rubric.rubricKey} / v{rubric.version}</bdi><span className="text-sm font-semibold text-zinc-200">{rubric.name}</span></div><div className="mt-2 flex flex-wrap gap-1.5">{rubric.criteria.map((criterion) => <span key={criterion.key} className="rounded-md border border-white/7 px-2 py-1 text-[11px] text-zinc-500">{criterion.label}: {criterion.maxScore.toLocaleString('fa-IR')} · وزن {criterion.weight.toLocaleString('fa-IR')}</span>)}</div></div>{canConfigure ? <Button className="border border-white/10 bg-white/5 text-zinc-300" size="sm" type="button" variant="secondary" onClick={() => { setRubricSource(rubric); setRubricOpen(true); }}>نسخه جدید از این</Button> : null}</article>)}</CardContent></Card>{canReview ? <QualityReviewComposer rubrics={rubrics} onCreated={(review) => setReviews((current) => [review, ...current])} /> : null}<Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Star className="size-4 text-amber-200" /> نتایج مجاز کیفیت</CardTitle><CardDescription className="leading-6 text-zinc-500">مدیر فقط دپارتمان‌های تحت مدیریت و هر کارشناس فقط بازبینی تکمیل‌شده خودش را می‌بیند؛ این نما رتبه‌بندی یا مقایسه همکاران ندارد.</CardDescription></CardHeader><CardContent className="space-y-3">{!loading && !reviews.length ? <Empty text="بازبینی کیفیت مجازی برای نمایش وجود ندارد." /> : reviews.map((review) => <SupportQualityReviewItem key={review.id} item={review} />)}<PrivacyNote>هیچ aggregate یا breakdown فردی از API درخواست یا در مرورگر نگهداری نمی‌شود.</PrivacyNote></CardContent></Card>{canConfigure ? <QualityRubricDialog open={rubricOpen} source={rubricSource} onOpenChange={setRubricOpen} onCreated={(rubric) => setRubrics((current) => [rubric, ...current])} /> : null}</div>;
}

function QualityReviewComposer({ onCreated, rubrics }: { onCreated: (item: SupportQualityReview) => void; rubrics: SupportQualityRubric[] }) {
   const support = useSupportWorkspace();
   const [caseKey, setCaseKey] = useState('');
   const [rubricId, setRubricId] = useState('');
   const [sampleReason, setSampleReason] = useState('');
   const [findings, setFindings] = useState<Record<string, { score: string; finding: string }>>({});
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState('');
   const rubric = rubrics.find((entry) => entry.id === rubricId) || rubrics[0];

   useEffect(() => {
      if (!rubricId && rubrics[0]) setRubricId(rubrics[0].id);
   }, [rubricId, rubrics]);

   useEffect(() => {
      if (!rubric) return;
      setFindings(Object.fromEntries(rubric.criteria.map((criterion) => [criterion.key, { score: '', finding: '' }])));
   }, [rubric]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!rubric || !caseKey.trim() || sampleReason.trim().length < 3 || busy) return;
      const normalized: SupportQualityFinding[] = rubric.criteria.map((criterion) => ({ criterionKey: criterion.key, score: Number(findings[criterion.key]?.score), finding: findings[criterion.key]?.finding.trim() || undefined }));
      if (normalized.some((finding, index) => !Number.isInteger(finding.score) || finding.score < 0 || finding.score > rubric.criteria[index].maxScore)) { setError('امتیاز هر معیار باید عدد صحیح در بازه همان معیار باشد.'); return; }
      setBusy(true); setError('');
      try {
         const supportCase = await support.loadCase(caseKey.trim());
         const created = await supportMaturityClient.createReview({ caseId: supportCase.id, rubricId: rubric.id, sampleReason: sampleReason.trim(), findings: normalized });
         onCreated(created); setCaseKey(''); setSampleReason(''); setFindings(Object.fromEntries(rubric.criteria.map((criterion) => [criterion.key, { score: '', finding: '' }])));
      } catch (caught) { setError(message(caught, 'ثبت بازبینی کیفیت ناموفق بود؛ فقط پرونده حل‌شده و واگذارشده قابل ارزیابی است.')); }
      finally { setBusy(false); }
   }

   return <Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Star className="size-4 text-amber-200" /> بازبینی یک پرونده حل‌شده</CardTitle><CardDescription className="leading-6 text-zinc-500">نمونه‌گیری انسانی با نسخه دقیق معیار؛ امتیاز نهایی وزن‌دار در سرور محاسبه می‌شود.</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}>{error ? <InlineError text={error} /> : null}<div className="grid gap-3 sm:grid-cols-2"><Field label="کلید پرونده"><Input dir="ltr" className={cn(inputClass, 'text-left')} placeholder="SUP-42" required value={caseKey} onChange={(event) => setCaseKey(event.target.value)} /></Field><Field label="نسخه معیار"><select className={selectClass} value={rubric?.id || ''} onChange={(event) => setRubricId(event.target.value)}>{rubrics.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} — v{entry.version}</option>)}</select></Field></div><Field label="دلیل نمونه‌گیری"><Textarea className={cn(inputClass, 'min-h-16')} minLength={3} maxLength={2000} required value={sampleReason} onChange={(event) => setSampleReason(event.target.value)} /></Field>{rubric ? <div className="space-y-2">{rubric.criteria.map((criterion) => <div key={criterion.key} className="grid gap-2 rounded-lg border border-white/7 bg-black/10 p-3 sm:grid-cols-[minmax(180px,1fr)_100px_minmax(240px,1.5fr)] sm:items-end"><div><p className="text-sm text-zinc-300">{criterion.label}</p><p className="mt-1 text-[11px] text-zinc-600">حداکثر {criterion.maxScore.toLocaleString('fa-IR')} · وزن {criterion.weight.toLocaleString('fa-IR')}</p></div><Field label="امتیاز"><Input aria-label={`امتیاز ${criterion.label}`} className={inputClass} min={0} max={criterion.maxScore} type="number" value={findings[criterion.key]?.score || ''} onChange={(event) => setFindings((current) => ({ ...current, [criterion.key]: { ...current[criterion.key], score: event.target.value } }))} /></Field><Field label="یافته (اختیاری)"><Input aria-label={`یافته ${criterion.label}`} className={inputClass} maxLength={4000} value={findings[criterion.key]?.finding || ''} onChange={(event) => setFindings((current) => ({ ...current, [criterion.key]: { ...current[criterion.key], finding: event.target.value } }))} /></Field></div>)}</div> : null}<Button className="bg-amber-300/10 text-amber-100 hover:bg-amber-300/20" disabled={!rubric || busy} type="submit">{busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} تکمیل بازبینی</Button></form></CardContent></Card>;
}

export function SupportQualityReviewItem({ item }: { item: SupportQualityReview }) {
   return <article className="rounded-xl border border-white/7 bg-black/10 p-4" data-testid={`support-quality-review-${item.id}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><bdi dir="ltr" className="font-mono text-xs text-sky-300">{item.case.key}</bdi><span className="text-sm font-semibold text-zinc-200">{item.case.title}</span></div><p className="mt-1.5 text-xs text-zinc-500">{item.rubric.name} · نسخه {item.rubricVersion.toLocaleString('fa-IR')} · {formatJalaliDateTime(item.completedAt)}</p><p className="mt-2 text-xs leading-6 text-zinc-400">دلیل نمونه: {item.sampleReason}</p><p className="mt-1 text-[11px] text-zinc-600">کارشناس: {item.assignee?.name || 'کارشناس حذف‌شده'} · بازبین: {item.reviewer?.name || 'بازبین حذف‌شده'}</p></div><div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.035] px-4 py-3 text-center"><strong className="block text-xl text-amber-100">{item.score.toLocaleString('fa-IR')} از ۱۰۰</strong><span className="mt-1 block text-[10px] text-amber-100/55">نتیجه ارزیابی فردی مجاز</span></div></div>{item.findings.length ? <div className="mt-3 grid gap-2 border-t border-white/6 pt-3 sm:grid-cols-2">{item.findings.map((finding) => <div key={finding.criterionKey} className="rounded-lg bg-white/[0.025] px-3 py-2 text-xs"><bdi dir="ltr" className="text-zinc-500">{finding.criterionKey}</bdi><span className="ms-2 text-zinc-300">{finding.score.toLocaleString('fa-IR')}</span>{finding.finding ? <p className="mt-1 leading-6 text-zinc-500">{finding.finding}</p> : null}</div>)}</div> : null}</article>;
}

function QualityRubricDialog({ onCreated, onOpenChange, open, source }: { onCreated: (item: SupportQualityRubric) => void; onOpenChange: (open: boolean) => void; open: boolean; source?: SupportQualityRubric }) {
   const [key, setKey] = useState('');
   const [name, setName] = useState('');
   const [criteria, setCriteria] = useState<SupportQualityCriterion[]>([{ key: 'accuracy', label: 'دقت پاسخ', maxScore: 5, weight: 100 }]);
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState('');
   useEffect(() => { if (!open) return; setKey(source?.rubricKey || ''); setName(source ? `${source.name} — نسخه جدید` : ''); setCriteria(source?.criteria.length ? source.criteria.map((criterion) => ({ ...criterion })) : [{ key: 'accuracy', label: 'دقت پاسخ', maxScore: 5, weight: 100 }]); setError(''); }, [open, source]);
   async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (busy || !key.trim() || !name.trim() || !criteria.length) return; setBusy(true); setError(''); try { onCreated(await supportMaturityClient.createRubric({ rubricKey: key.trim().toLowerCase(), name: name.trim(), criteria })); onOpenChange(false); } catch (caught) { setError(message(caught, 'ساخت نسخه معیار ناموفق بود.')); } finally { setBusy(false); } }
   return <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}><DialogContent dir="rtl" className="max-h-[90vh] max-w-3xl overflow-y-auto border-white/10 bg-[#171719] text-zinc-100"><DialogHeader><DialogTitle>نسخه جدید معیار کیفیت</DialogTitle><DialogDescription className="leading-6 text-zinc-500">کلید یکسان نسخه بعدی را می‌سازد؛ نسخه‌های قبلی و بازبینی‌هایشان تغییر نمی‌کنند.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={submit}>{error ? <InlineError text={error} /> : null}<div className="grid gap-3 sm:grid-cols-2"><Field label="کلید معیار"><Input dir="ltr" className={cn(inputClass, 'text-left')} pattern="[a-z0-9][a-z0-9_-]+" required value={key} onChange={(event) => setKey(event.target.value)} /></Field><Field label="نام نسخه"><Input className={inputClass} required value={name} onChange={(event) => setName(event.target.value)} /></Field></div><div className="space-y-2">{criteria.map((criterion, index) => <div key={index} className="grid gap-2 rounded-lg border border-white/7 bg-black/10 p-3 sm:grid-cols-[1fr_1.5fr_90px_90px_auto]"><Field label="کلید"><Input dir="ltr" className={cn(inputClass, 'text-left')} required value={criterion.key} onChange={(event) => setCriteria((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, key: event.target.value.toLowerCase() } : entry))} /></Field><Field label="عنوان"><Input className={inputClass} required value={criterion.label} onChange={(event) => setCriteria((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, label: event.target.value } : entry))} /></Field><Field label="حداکثر"><Input className={inputClass} min={1} max={100} type="number" value={criterion.maxScore} onChange={(event) => setCriteria((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, maxScore: Number(event.target.value) } : entry))} /></Field><Field label="وزن"><Input className={inputClass} min={1} max={100} type="number" value={criterion.weight} onChange={(event) => setCriteria((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, weight: Number(event.target.value) } : entry))} /></Field><Button aria-label={`حذف معیار ${index + 1}`} className="self-end text-zinc-600" disabled={criteria.length === 1} size="icon" type="button" variant="ghost" onClick={() => setCriteria((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X className="size-4" /></Button></div>)}</div><Button className="border border-dashed border-white/15 bg-white/[0.025] text-zinc-400" type="button" variant="secondary" onClick={() => setCriteria((current) => [...current, { key: '', label: '', maxScore: 5, weight: 10 }])}><Plus className="size-4" /> افزودن معیار</Button><DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-zinc-100 text-zinc-950" disabled={busy} type="submit">{busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} ساخت نسخه</Button><Button disabled={busy} type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter></form></DialogContent></Dialog>;
}

const actionTypes = ['SET_PRIORITY', 'SET_IMPACT', 'SET_URGENCY', 'SET_TYPE_KEY', 'SET_NEXT_ACTION_AT', 'CLEAR_NEXT_ACTION'] as const;
const conditionFields = ['PRIORITY', 'IMPACT', 'URGENCY', 'STATUS', 'SOURCE_CHANNEL', 'TYPE_KEY', 'DEPARTMENT_ASSIGNED'] as const;
const levels = ['LOW', 'MEDIUM', 'HIGH'] as const;

function defaultAction(type: SupportEnablementAction['type']): SupportEnablementAction {
   if (type === 'SET_PRIORITY') return { type, value: 'NORMAL' };
   if (type === 'SET_IMPACT' || type === 'SET_URGENCY') return { type, value: 'MEDIUM' };
   if (type === 'SET_TYPE_KEY') return { type, value: 'general' };
   if (type === 'SET_NEXT_ACTION_AT') return { type, value: new Date(Date.now() + 86_400_000).toISOString() };
   return { type: 'CLEAR_NEXT_ACTION' };
}

function defaultCondition(field: SupportAutomationCondition['field']): SupportAutomationCondition {
   if (field === 'PRIORITY') return { field, value: 'NORMAL' };
   if (field === 'IMPACT' || field === 'URGENCY') return { field, value: 'MEDIUM' };
   if (field === 'STATUS') return { field, value: 'OPEN' };
   if (field === 'SOURCE_CHANNEL') return { field, value: 'MANUAL' };
   if (field === 'DEPARTMENT_ASSIGNED') return { field, value: true };
   return { field: 'TYPE_KEY', value: 'general' };
}

function actionTypeLabel(type: SupportEnablementAction['type']) { return ({ SET_PRIORITY: 'تنظیم اولویت', SET_IMPACT: 'تنظیم اثر', SET_URGENCY: 'تنظیم فوریت', SET_TYPE_KEY: 'تنظیم نوع پرونده', SET_NEXT_ACTION_AT: 'تنظیم اقدام بعدی', CLEAR_NEXT_ACTION: 'پاک‌کردن اقدام بعدی' } as const)[type]; }
function actionLabel(action: SupportEnablementAction) { if (action.type === 'CLEAR_NEXT_ACTION') return actionTypeLabel(action.type); const value = action.type === 'SET_PRIORITY' ? supportPriorityLabels[action.value] : action.type === 'SET_IMPACT' || action.type === 'SET_URGENCY' ? action.value ? levelLabel(action.value) : 'پاک‌کردن' : action.type === 'SET_NEXT_ACTION_AT' ? formatJalaliDateTime(action.value) : action.value; return `${actionTypeLabel(action.type)}: ${value}`; }
function conditionFieldLabel(field: SupportAutomationCondition['field']) { return ({ PRIORITY: 'اولویت', IMPACT: 'اثر', URGENCY: 'فوریت', STATUS: 'وضعیت', SOURCE_CHANNEL: 'کانال ورودی', TYPE_KEY: 'نوع پرونده', DEPARTMENT_ASSIGNED: 'داشتن دپارتمان' } as const)[field]; }
function enablementKindLabel(kind: SupportEnablementKind) { return ({ MACRO: 'ماکرو', TEMPLATE: 'الگو', AUTOMATION: 'خودکارسازی' } as const)[kind]; }
function enablementStatusLabel(status: SupportEnablementDefinition['status']) { return ({ DRAFT: 'پیش‌نویس', APPROVED: 'تأییدشده', RETIRED: 'بازنشسته' } as const)[status]; }
function enablementStatusTone(status: SupportEnablementDefinition['status']) { return status === 'APPROVED' ? 'border-lime-300/15 text-lime-200' : status === 'DRAFT' ? 'border-amber-300/15 text-amber-200' : 'border-white/10 text-zinc-600'; }
function clusterStatusLabel(status: SupportProblemClusterStatus) { return ({ OPEN: 'باز', RESOLVED: 'حل‌شده', ARCHIVED: 'بایگانی' } as const)[status]; }
function knowledgeGapStatusLabel(status: SupportKnowledgeGapStatus) { return ({ OPEN: 'باز', IN_REVIEW: 'در حال بررسی', RESOLVED: 'حل‌شده' } as const)[status]; }
function levelLabel(level: SupportLevel) { return ({ LOW: 'کم', MEDIUM: 'متوسط', HIGH: 'زیاد' } as const)[level]; }
function sourceLabel(source: SupportCaseSource) { return ({ API: 'API', CALL: 'تماس', MANUAL: 'دستی', EMAIL: 'ایمیل', MESSAGING: 'پیام' } as const)[source]; }
function Field({ children, label }: { children: React.ReactNode; label: string }) { return <label className="grid gap-1.5 text-xs text-zinc-500"><span>{label}</span>{children}</label>; }
function PrivacyNote({ children }: { children: React.ReactNode }) { return <p className="rounded-lg border border-lime-300/10 bg-lime-300/[0.02] px-3 py-2.5 text-xs leading-6 text-lime-100/55"><ShieldCheck className="me-1 inline size-3.5" />{children}</p>; }
function InlineError({ text }: { text: string }) { return <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{text}</p>; }
function Loading({ text }: { text: string }) { return <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-600"><Loader2 className="size-4 animate-spin" />{text}</div>; }
function Empty({ text }: { text: string }) { return <div className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm leading-7 text-zinc-600"><CircleOff className="mx-auto mb-3 size-5" />{text}</div>; }
function message(error: unknown, fallback: string) { return error instanceof Error && error.message ? error.message : fallback; }

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
