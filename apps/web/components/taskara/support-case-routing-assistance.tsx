import { useEffect, useState } from 'react';
import {
   AlertTriangle,
   CheckCircle2,
   GitBranch,
   Loader2,
   Route,
   ShieldQuestion,
   Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { supportCaseActionAccess } from '@/lib/support-access';
import { supportRoutingClient } from '@/lib/support-routing-client';
import type { SupportRoutingDecision } from '@/lib/support-routing-types';
import { supportPriorityLabels } from '@/lib/support-presenters';
import {
   supportCasePriorities,
   type SupportCase,
   type SupportCasePriority,
} from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { cn } from '@/lib/utils';

export function SupportCaseRoutingAssistance({ item, onChanged }: {
   item: SupportCase;
   onChanged: (item: SupportCase) => void;
}) {
   const support = useSupportWorkspace();
   const access = supportCaseActionAccess(item, support.access);
   const canSimulate = item.departmentId === null && Boolean(support.access?.triager || support.access?.workspaceWide);
   const terminal = item.status === 'RESOLVED' || item.status === 'CLOSED';
   const suggestion = suggestPriority(item.impact, item.urgency);
   const [decision, setDecision] = useState<SupportRoutingDecision>();
   const [overridePriority, setOverridePriority] = useState<SupportCasePriority>(item.priority);
   const [overrideReason, setOverrideReason] = useState('');
   const [busy, setBusy] = useState<'SIMULATE' | 'APPLY' | 'ACCEPT' | 'OVERRIDE' | ''>('');
   const [error, setError] = useState('');
   const [notice, setNotice] = useState('');

   useEffect(() => {
      setDecision(undefined);
      setOverridePriority(item.priority);
      setOverrideReason('');
      setError('');
      setNotice('');
   }, [item.id, item.version]);

   if (terminal || (!canSimulate && !access.canWork)) return null;

   async function simulate() {
      setBusy('SIMULATE');
      setError('');
      setNotice('');
      try {
         setDecision(await supportRoutingClient.simulate(item.key, item.version));
      } catch (caught) {
         setError(message(caught, 'شبیه‌سازی مسیریابی ناموفق بود.'));
      } finally {
         setBusy('');
      }
   }

   async function apply() {
      if (!decision || decision.case.version !== item.version) return;
      setBusy('APPLY');
      setError('');
      setNotice('');
      try {
         const result = await supportRoutingClient.apply(item.key, item.version);
         const updated = await support.loadCase(item.key);
         onChanged(updated);
         setDecision(undefined);
         setNotice(result.outcome === 'ROUTED' ? 'مسیریابی پیشنهادی اعمال شد.' : 'پرونده با ثبت دلیل در تریاژ باقی ماند.');
      } catch (caught) {
         setError(message(caught, 'اعمال مسیریابی ناموفق بود؛ پرونده را تازه‌سازی کنید.'));
      } finally {
         setBusy('');
      }
   }

   async function decidePriority(mode: 'ACCEPT' | 'OVERRIDE') {
      if (mode === 'ACCEPT' && !suggestion) return;
      if (mode === 'OVERRIDE' && overrideReason.trim().length < 3) {
         setError('برای تغییر اولویت، دلیل دست‌کم سه‌حرفی ثبت کنید.');
         return;
      }
      setBusy(mode);
      setError('');
      setNotice('');
      try {
         const result = await supportRoutingClient.decidePriority(item.key, mode === 'ACCEPT'
            ? { decision: 'ACCEPT_SUGGESTION', baseVersion: item.version }
            : { decision: 'OVERRIDE', priority: overridePriority, reason: overrideReason.trim(), baseVersion: item.version });
         onChanged(result.case);
         setDecision(undefined);
         setOverrideReason('');
         setNotice(mode === 'ACCEPT' ? 'اولویت پیشنهادی با تأیید انسانی ثبت شد.' : 'اولویت جایگزین و دلیل آن ثبت شد.');
      } catch (caught) {
         setError(message(caught, 'ثبت تصمیم اولویت ناموفق بود؛ پرونده را تازه‌سازی کنید.'));
      } finally {
         setBusy('');
      }
   }

   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100" data-testid="support-case-routing-assistance">
         <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Sparkles className="size-4 text-indigo-300" /> راهنمای مسیریابی و اولویت</CardTitle><CardDescription className="leading-6 text-zinc-600">پیشنهادها خودکار اجرا نمی‌شوند؛ اعمال مسیر یا اولویت همیشه اقدام روشن انسانی است.</CardDescription></CardHeader>
         <CardContent className="space-y-4">
            {error ? <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-xs leading-6 text-red-200">{error}</p> : null}
            {notice ? <p role="status" className="rounded-lg border border-lime-400/15 bg-lime-400/[0.045] px-3 py-2.5 text-xs leading-6 text-lime-100/80">{notice}</p> : null}

            {canSimulate ? (
               <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3"><div><h3 className="text-xs font-medium text-zinc-300">مسیر پیشنهادی</h3><p className="mt-1 text-[11px] leading-5 text-zinc-600">براساس نسخه فعلی پرونده و سیاست فعال</p></div><Button className="border border-white/10 bg-white/5 text-zinc-300" disabled={Boolean(busy)} size="sm" type="button" variant="secondary" onClick={() => void simulate()}>{busy === 'SIMULATE' ? <Loader2 className="size-4 animate-spin" /> : <GitBranch className="size-4" />} شبیه‌سازی</Button></div>
                  {decision ? <SupportRoutingDecisionExplanation decision={decision} /> : null}
                  {decision ? <Button className="w-full bg-indigo-400/15 text-indigo-100 hover:bg-indigo-400/25" disabled={Boolean(busy) || decision.case.version !== item.version} type="button" onClick={() => void apply()}>{busy === 'APPLY' ? <Loader2 className="size-4 animate-spin" /> : <Route className="size-4" />} {decision.outcome === 'ROUTE' ? 'اعمال مسیر پیشنهادی' : 'ثبت باقی‌ماندن در تریاژ'}</Button> : null}
               </section>
            ) : null}

            {access.canWork ? (
               <section className={cn('space-y-3', canSimulate && 'border-t border-white/6 pt-4')}>
                  <div className="flex items-start justify-between gap-3"><div><h3 className="text-xs font-medium text-zinc-300">پیشنهاد اولویت</h3><p className="mt-1 text-[11px] leading-5 text-zinc-600">ماتریس اثر × فوریت؛ تصمیم نهایی با شماست.</p></div>{suggestion ? <Badge variant="outline" className="border-indigo-400/20 bg-indigo-400/8 text-indigo-200">{supportPriorityLabels[suggestion]}</Badge> : <Badge variant="outline" className="border-amber-400/20 bg-amber-400/8 text-amber-200">اثر یا فوریت ناقص</Badge>}</div>
                  {suggestion ? <Button className="w-full border border-lime-400/15 bg-lime-400/[0.04] text-lime-100 hover:bg-lime-400/10" disabled={Boolean(busy)} type="button" variant="secondary" onClick={() => void decidePriority('ACCEPT')}>{busy === 'ACCEPT' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} پذیرش پیشنهاد {supportPriorityLabels[suggestion]}</Button> : null}
                  <div className="grid gap-2 rounded-lg border border-white/7 bg-black/10 p-3">
                     <label className="grid gap-1.5 text-xs text-zinc-500">اولویت جایگزین<select aria-label="اولویت جایگزین" className={selectClass} value={overridePriority} onChange={(event) => setOverridePriority(event.target.value as SupportCasePriority)}>{supportCasePriorities.map((priority) => <option key={priority} value={priority}>{supportPriorityLabels[priority]}</option>)}</select></label>
                     <label className="grid gap-1.5 text-xs text-zinc-500">دلیل تصمیم<Textarea aria-label="دلیل تغییر اولویت" className={cn(inputClass, 'min-h-16')} maxLength={1000} placeholder="زمینه‌ای که ماتریس پوشش نمی‌دهد…" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label>
                     <Button className="border border-white/10 bg-white/5 text-zinc-300" disabled={Boolean(busy) || overrideReason.trim().length < 3} type="button" variant="secondary" onClick={() => void decidePriority('OVERRIDE')}>{busy === 'OVERRIDE' ? <Loader2 className="size-4 animate-spin" /> : <ShieldQuestion className="size-4" />} ثبت اولویت جایگزین</Button>
                  </div>
               </section>
            ) : null}
         </CardContent>
      </Card>
   );
}

export function SupportRoutingDecisionExplanation({ decision }: { decision: SupportRoutingDecision }) {
   const fallback = decision.fallbackReason ? fallbackLabel(decision.fallbackReason) : null;
   return (
      <div className="space-y-2 rounded-lg border border-white/7 bg-black/10 p-3" data-testid="support-routing-explanation">
         <div className="flex items-start gap-2">{decision.outcome === 'ROUTE' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-lime-300" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />}<div><p className="text-xs font-medium text-zinc-300">{decision.outcome === 'ROUTE' ? `ارسال به ${decision.route?.departmentName || 'دپارتمان مقصد'}` : 'باقی‌ماندن در تریاژ'}</p><p className="mt-1 text-[11px] leading-5 text-zinc-600">{decision.policy ? `سیاست نسخه ${decision.policy.version.toLocaleString('fa-IR')}${decision.matchedRule ? ` · قاعده ${decision.matchedRule.name}` : ''}` : fallback}{fallback && decision.policy ? ` · ${fallback}` : ''}</p></div></div>
         {decision.route?.assignment ? <p className="rounded-md bg-white/[0.025] px-2.5 py-2 text-[11px] leading-5 text-zinc-500">{assignmentLabel(decision.route.assignment)}{decision.route.assignment.capacityDetailsRedacted ? ' جزئیات ظرفیت برای این دسترسی پنهان است.' : ''}</p> : null}
         {decision.evaluatedRules.length ? <details><summary className="cursor-pointer text-[11px] text-zinc-500">توضیح ارزیابی {decision.evaluatedRules.length.toLocaleString('fa-IR')} قاعده</summary><ol className="mt-2 space-y-1 border-r border-white/8 pr-3">{decision.evaluatedRules.map((rule) => <li key={rule.ruleId} className="text-[11px] leading-5 text-zinc-600"><span className={rule.result === 'MATCH' ? 'text-lime-300/80' : ''}>{rule.order.toLocaleString('fa-IR')}. {rule.name} — {ruleResultLabel(rule.result)}</span>{rule.mismatches.length ? ` (${rule.mismatches.map(mismatchLabel).join('، ')})` : ''}</li>)}</ol></details> : null}
      </div>
   );
}

export function suggestPriority(
   impact: SupportCase['impact'],
   urgency: SupportCase['urgency']
): SupportCasePriority | null {
   if (!impact || !urgency) return null;
   const matrix: Record<NonNullable<SupportCase['impact']>, Record<NonNullable<SupportCase['urgency']>, SupportCasePriority>> = {
      LOW: { LOW: 'LOW', MEDIUM: 'NORMAL', HIGH: 'HIGH' },
      MEDIUM: { LOW: 'NORMAL', MEDIUM: 'HIGH', HIGH: 'URGENT' },
      HIGH: { LOW: 'HIGH', MEDIUM: 'URGENT', HIGH: 'URGENT' },
   };
   return matrix[impact][urgency];
}

function assignmentLabel(assignment: NonNullable<SupportRoutingDecision['route']>['assignment']) {
   if (!assignment) return '';
   if (assignment.result === 'DEPARTMENT_INBOX') return 'پرونده در صف دپارتمان قرار می‌گیرد.';
   if (assignment.result === 'NO_ELIGIBLE_MEMBER_DEPARTMENT_INBOX') return 'عضو واجد شرایط پیدا نشد؛ پرونده در صف دپارتمان می‌ماند.';
   if (assignment.capacityDetailsRedacted) return 'یک عضو واجد شرایط با کمترین نسبت بار انتخاب می‌شود.';
   return `عضو با کمترین نسبت بار انتخاب شد؛ ${assignment.eligibleMemberCount?.toLocaleString('fa-IR') || '۰'} عضو واجد شرایط از ${assignment.consideredMemberCount?.toLocaleString('fa-IR') || '۰'} عضو بررسی‌شده.`;
}

function fallbackLabel(reason: NonNullable<SupportRoutingDecision['fallbackReason']>) {
   return ({ NO_ACTIVE_POLICY: 'سیاست فعالی وجود ندارد', NO_MATCHING_RULE: 'هیچ قاعده‌ای منطبق نشد', TARGET_DEPARTMENT_UNAVAILABLE: 'دپارتمان مقصد در دسترس نیست' } as const)[reason];
}

function ruleResultLabel(result: SupportRoutingDecision['evaluatedRules'][number]['result']) {
   return ({ DISABLED: 'غیرفعال', NO_MATCH: 'نامنطبق', MATCH: 'منطبق' } as const)[result];
}

function mismatchLabel(value: SupportRoutingDecision['evaluatedRules'][number]['mismatches'][number]) {
   return ({ CASE_TYPE: 'نوع', PRIORITY: 'اولویت', SOURCE_CHANNEL: 'کانال', IMPACT_MISSING: 'اثر ثبت نشده', IMPACT: 'اثر', URGENCY_MISSING: 'فوریت ثبت نشده', URGENCY: 'فوریت' } as const)[value];
}

function message(error: unknown, fallback: string) {
   return error instanceof Error && error.message ? error.message : fallback;
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
