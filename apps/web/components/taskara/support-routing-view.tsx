import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
   Activity,
   CheckCircle2,
   CircleOff,
   Gauge,
   GitBranch,
   Loader2,
   Plus,
   RefreshCw,
   Save,
   Sparkles,
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
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportRoutingClient } from '@/lib/support-routing-client';
import type {
   CreateSupportRoutingPolicyInput,
   SupportRoutingAssignmentMode,
   SupportRoutingMember,
   SupportRoutingPolicy,
} from '@/lib/support-routing-types';
import {
   supportCasePriorities,
   supportCaseSources,
   type SupportCasePriority,
   type SupportCaseSource,
   type SupportDepartment,
} from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { cn } from '@/lib/utils';

type RoutingRuleDraft = {
   name: string;
   enabled: boolean;
   caseTypeKeys: string;
   priorities: SupportCasePriority[];
   sourceChannels: SupportCaseSource[];
   impacts: Array<'LOW' | 'MEDIUM' | 'HIGH'>;
   urgencies: Array<'LOW' | 'MEDIUM' | 'HIGH'>;
   targetDepartmentId: string;
   assignmentMode: SupportRoutingAssignmentMode;
   requiredSkills: string;
};

type MemberDraft = {
   availability: 'UNAVAILABLE' | 'AVAILABLE';
   capacity: string;
   skills: string;
};

const levels = ['LOW', 'MEDIUM', 'HIGH'] as const;

export function SupportRoutingView() {
   const support = useSupportWorkspace();
   const runtime = useWorkspaceRuntime();
   const canConfigure = runtime.permissions.has('support.setup');
   const manageableDepartmentIds = useMemo(() => new Set(
      support.access?.workspaceWide
         ? support.departments.map((department) => department.id)
         : support.access?.managedDepartmentIds || []
   ), [support.access?.managedDepartmentIds, support.access?.workspaceWide, support.departments]);
   const manageableDepartments = useMemo(() => support.departments.filter((department) =>
      department.active && manageableDepartmentIds.has(department.id)
   ), [manageableDepartmentIds, support.departments]);
   const [policies, setPolicies] = useState<SupportRoutingPolicy[]>([]);
   const [policyLoading, setPolicyLoading] = useState(canConfigure);
   const [policyError, setPolicyError] = useState('');
   const [builderOpen, setBuilderOpen] = useState(false);
   const [copyPolicy, setCopyPolicy] = useState<SupportRoutingPolicy>();
   const [activatingId, setActivatingId] = useState('');
   const [departmentId, setDepartmentId] = useState('');
   const [members, setMembers] = useState<SupportRoutingMember[]>([]);
   const [memberDrafts, setMemberDrafts] = useState<Record<string, MemberDraft>>({});
   const [membersLoading, setMembersLoading] = useState(false);
   const [memberError, setMemberError] = useState('');
   const [savingMemberId, setSavingMemberId] = useState('');

   const loadPolicies = useCallback(async () => {
      if (!canConfigure) return;
      setPolicyLoading(true);
      setPolicyError('');
      try {
         setPolicies(await supportRoutingClient.listPolicies());
      } catch (caught) {
         setPolicyError(message(caught, 'بارگذاری نسخه‌های مسیریابی ناموفق بود.'));
      } finally {
         setPolicyLoading(false);
      }
   }, [canConfigure]);

   const loadMembers = useCallback(async (selectedDepartmentId: string) => {
      if (!selectedDepartmentId) return;
      setMembersLoading(true);
      setMemberError('');
      try {
         const loaded = await supportRoutingClient.listMembers(selectedDepartmentId);
         setMembers(loaded);
         setMemberDrafts(Object.fromEntries(loaded.map((member) => [member.membershipId, memberToDraft(member)])));
      } catch (caught) {
         setMembers([]);
         setMemberError(message(caught, 'بارگذاری ظرفیت اعضای دپارتمان ناموفق بود.'));
      } finally {
         setMembersLoading(false);
      }
   }, []);

   useEffect(() => {
      void loadPolicies();
   }, [loadPolicies]);

   useEffect(() => {
      if (departmentId && manageableDepartments.some((department) => department.id === departmentId)) return;
      setDepartmentId(manageableDepartments[0]?.id || '');
   }, [departmentId, manageableDepartments]);

   useEffect(() => {
      if (!departmentId) {
         setMembers([]);
         return;
      }
      void loadMembers(departmentId);
   }, [departmentId, loadMembers]);

   async function activate(policy: SupportRoutingPolicy) {
      if (policy.active || activatingId) return;
      setActivatingId(policy.id);
      setPolicyError('');
      try {
         const active = await supportRoutingClient.activatePolicy(policy.id);
         setPolicies((current) => current.map((item) => ({
            ...item,
            active: item.id === active.id,
            activatedAt: item.id === active.id ? active.activatedAt : item.activatedAt,
         })));
      } catch (caught) {
         setPolicyError(message(caught, 'فعال‌سازی سیاست مسیریابی ناموفق بود.'));
      } finally {
         setActivatingId('');
      }
   }

   async function saveMember(member: SupportRoutingMember) {
      const draft = memberDrafts[member.membershipId];
      if (!draft || savingMemberId) return;
      const capacity = Number(draft.capacity);
      if (!Number.isInteger(capacity) || capacity < 0 || capacity > 1000) {
         setMemberError('ظرفیت باید عددی صحیح بین صفر و ۱۰۰۰ باشد.');
         return;
      }
      setSavingMemberId(member.membershipId);
      setMemberError('');
      try {
         const updated = await supportRoutingClient.updateMember(member.departmentId, member.userId, {
            routingAvailability: draft.availability,
            routingCapacity: capacity,
            routingSkills: parseKeys(draft.skills),
         });
         setMembers((current) => current.map((item) => item.membershipId === updated.membershipId ? updated : item));
         setMemberDrafts((current) => ({ ...current, [updated.membershipId]: memberToDraft(updated) }));
      } catch (caught) {
         setMemberError(message(caught, 'ذخیره ظرفیت عضو ناموفق بود.'));
      } finally {
         setSavingMemberId('');
      }
   }

   return (
      <main dir="rtl" className="h-full min-h-0 overflow-y-auto bg-[#101011] p-4 text-zinc-100 sm:p-5" data-testid="support-routing-screen">
         <div className="mx-auto max-w-7xl space-y-5">
            <section className="grid gap-3 sm:grid-cols-3">
               <Metric icon={GitBranch} label="نسخه‌های مسیریابی" value={policies.length} />
               <Metric icon={CheckCircle2} label="نسخه فعال" value={policies.find((policy) => policy.active)?.version ?? '—'} />
               <Metric icon={Users} label="دپارتمان قابل مدیریت" value={manageableDepartments.length} />
            </section>

            {canConfigure ? (
               <Card className="border-white/8 bg-[#171719] text-zinc-100">
                  <CardHeader className="border-b border-white/7">
                     <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                           <CardTitle className="flex items-center gap-2 text-base"><GitBranch className="size-4 text-indigo-300" /> سیاست مسیریابی</CardTitle>
                           <CardDescription className="mt-1.5 max-w-3xl leading-6 text-zinc-500">هر تغییر یک نسخه تغییرناپذیر تازه می‌سازد. فقط یک نسخه فعال است و ترتیب قواعد نتیجه را تعیین می‌کند.</CardDescription>
                        </div>
                        <div className="flex gap-2">
                           <Button aria-label="تازه‌سازی سیاست‌های مسیریابی" className="border border-white/10 bg-white/5 text-zinc-300" size="icon" type="button" variant="secondary" onClick={() => void loadPolicies()}><RefreshCw className={cn('size-4', policyLoading && 'animate-spin')} /></Button>
                           <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" type="button" onClick={() => { setCopyPolicy(undefined); setBuilderOpen(true); }}><Plus className="size-4" /> نسخه جدید</Button>
                        </div>
                     </div>
                  </CardHeader>
                  <CardContent className="space-y-3 p-4">
                     {policyError ? <InlineError text={policyError} /> : null}
                     {policyLoading && !policies.length ? <Loading text="در حال بارگذاری سیاست‌ها…" /> : null}
                     {!policyLoading && !policies.length ? <Empty text="هنوز سیاست مسیریابی ساخته نشده است؛ پرونده‌های تازه در تریاژ می‌مانند." /> : null}
                     {policies.map((policy) => (
                        <PolicyRow key={policy.id} policy={policy} activating={activatingId === policy.id} onActivate={() => void activate(policy)} onCopy={() => { setCopyPolicy(policy); setBuilderOpen(true); }} />
                     ))}
                  </CardContent>
               </Card>
            ) : null}

            <Card className="border-white/8 bg-[#171719] text-zinc-100">
               <CardHeader className="border-b border-white/7">
                  <CardTitle className="flex items-center gap-2 text-base"><Gauge className="size-4 text-sky-300" /> آمادگی و ظرفیت اعضا</CardTitle>
                  <CardDescription className="mt-1.5 max-w-3xl leading-6 text-zinc-500">مسیریابی ظرفیتی فقط اعضای فعال و «آماده» را در نظر می‌گیرد. بار جاری یک شمارش تجمیعی است؛ جزئیات پرونده‌های همکاران نمایش داده نمی‌شود.</CardDescription>
               </CardHeader>
               <CardContent className="space-y-4 p-4">
                  {!manageableDepartments.length ? <Empty text="دپارتمانی در محدوده مدیریت شما وجود ندارد." /> : (
                     <>
                        <label className="grid max-w-md gap-1.5 text-sm text-zinc-300">دپارتمان
                           <select className={selectClass} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
                              {manageableDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                           </select>
                        </label>
                        {memberError ? <InlineError text={memberError} /> : null}
                        {membersLoading ? <Loading text="در حال بارگذاری ظرفیت اعضا…" /> : null}
                        {!membersLoading && !members.length ? <Empty text="عضو فعالی برای تنظیم مسیریابی در این دپارتمان نیست." /> : null}
                        <div className="grid gap-3">
                           {members.map((member) => (
                              <MemberCapacityRow
                                 key={member.membershipId}
                                 draft={memberDrafts[member.membershipId] || memberToDraft(member)}
                                 member={member}
                                 saving={savingMemberId === member.membershipId}
                                 onDraft={(draft) => setMemberDrafts((current) => ({ ...current, [member.membershipId]: draft }))}
                                 onSave={() => void saveMember(member)}
                              />
                           ))}
                        </div>
                     </>
                  )}
               </CardContent>
            </Card>
         </div>

         {canConfigure ? (
            <PolicyBuilderDialog
               departments={support.departments.filter((department) => department.active)}
               open={builderOpen}
               source={copyPolicy}
               onOpenChange={setBuilderOpen}
               onCreated={(policy) => setPolicies((current) => [policy, ...current.map((item) => policy.active ? { ...item, active: false } : item)])}
            />
         ) : null}
      </main>
   );
}

function PolicyRow({ activating, onActivate, onCopy, policy }: {
   activating: boolean;
   onActivate: () => void;
   onCopy: () => void;
   policy: SupportRoutingPolicy;
}) {
   return (
      <article className={cn('rounded-xl border p-4', policy.active ? 'border-lime-400/20 bg-lime-400/[0.035]' : 'border-white/7 bg-black/10')} data-testid={`support-routing-policy-${policy.version}`}>
         <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
               <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-zinc-500">v{policy.version.toLocaleString('fa-IR')}</span>
                  <h3 className="text-sm font-semibold text-zinc-200">{policy.label || `نسخه ${policy.version.toLocaleString('fa-IR')}`}</h3>
                  <Badge variant="outline" className={policy.active ? 'border-lime-400/20 bg-lime-400/8 text-lime-300' : 'border-white/10 text-zinc-500'}>{policy.active ? 'فعال' : 'غیرفعال'}</Badge>
               </div>
               <p className="mt-1.5 text-xs text-zinc-600">{policy.rules.length.toLocaleString('fa-IR')} قاعده · ساخته‌شده {formatJalaliDateTime(policy.createdAt)}</p>
               <div className="mt-3 flex flex-wrap gap-2">
                  {policy.rules.map((rule) => <span key={rule.id} className="rounded-md border border-white/7 bg-white/[0.025] px-2 py-1 text-[11px] text-zinc-500">{rule.order.toLocaleString('fa-IR')}. {rule.name} ← {rule.targetDepartment.name}</span>)}
               </div>
            </div>
            <div className="flex gap-2">
               <Button className="border border-white/10 bg-white/5 text-zinc-300" size="sm" type="button" variant="secondary" onClick={onCopy}>نسخه جدید از این</Button>
               {!policy.active ? <Button className="bg-lime-400/10 text-lime-200 hover:bg-lime-400/20" disabled={activating} size="sm" type="button" onClick={onActivate}>{activating ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} فعال‌سازی</Button> : null}
            </div>
         </div>
      </article>
   );
}

function MemberCapacityRow({ draft, member, onDraft, onSave, saving }: {
   draft: MemberDraft;
   member: SupportRoutingMember;
   onDraft: (draft: MemberDraft) => void;
   onSave: () => void;
   saving: boolean;
}) {
   return (
      <article className={cn('grid gap-3 rounded-xl border border-white/7 bg-black/10 p-3 lg:grid-cols-[minmax(180px,1.2fr)_170px_120px_minmax(180px,1fr)_auto] lg:items-end', !member.active && 'opacity-55')} data-testid={`support-routing-member-${member.userId}`}>
         <div className="flex min-w-0 items-center gap-3 self-center">
            <LinearAvatar className="size-8 shrink-0" name={member.user.name} src={member.user.avatarUrl} />
            <div className="min-w-0"><p className="truncate text-sm font-medium text-zinc-200">{member.user.name}</p><p className="mt-0.5 text-xs text-zinc-600">بار جاری {member.activeCaseLoad.toLocaleString('fa-IR')} پرونده · بدون نمایش جزئیات</p></div>
         </div>
         <Field label="وضعیت دریافت">
            <select aria-label={`وضعیت دریافت ${member.user.name}`} className={selectClass} disabled={!member.active} value={draft.availability} onChange={(event) => onDraft({ ...draft, availability: event.target.value as MemberDraft['availability'] })}>
               <option value="AVAILABLE">آماده دریافت</option>
               <option value="UNAVAILABLE">خارج از مسیریابی</option>
            </select>
         </Field>
         <Field label="ظرفیت هم‌زمان">
            <Input aria-label={`ظرفیت ${member.user.name}`} className={inputClass} disabled={!member.active} inputMode="numeric" min={0} max={1000} type="number" value={draft.capacity} onChange={(event) => onDraft({ ...draft, capacity: event.target.value })} />
         </Field>
         <Field label="مهارت‌ها">
            <Input aria-label={`مهارت‌های ${member.user.name}`} dir="ltr" className={cn(inputClass, 'text-left')} disabled={!member.active} placeholder="billing, api:enterprise" value={draft.skills} onChange={(event) => onDraft({ ...draft, skills: event.target.value })} />
         </Field>
         <Button aria-label={`ذخیره ظرفیت ${member.user.name}`} className="bg-indigo-400/15 text-indigo-100 hover:bg-indigo-400/25" disabled={!member.active || saving} type="button" onClick={onSave}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} ذخیره</Button>
      </article>
   );
}

function PolicyBuilderDialog({ departments, onCreated, onOpenChange, open, source }: {
   departments: SupportDepartment[];
   onCreated: (policy: SupportRoutingPolicy) => void;
   onOpenChange: (open: boolean) => void;
   open: boolean;
   source?: SupportRoutingPolicy;
}) {
   const [label, setLabel] = useState('');
   const [activate, setActivate] = useState(false);
   const [rules, setRules] = useState<RoutingRuleDraft[]>([emptyRule('')]);
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      if (!open) return;
      setLabel(source?.label ? `${source.label} — نسخه جدید` : '');
      setActivate(false);
      setRules(source?.rules.length ? source.rules.map(ruleToDraft) : [emptyRule(departments[0]?.id || '')]);
      setError('');
   }, [departments, open, source]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (submitting) return;
      const payload: CreateSupportRoutingPolicyInput = {
         label: label.trim() || undefined,
         activate,
         rules: rules.map((rule, index) => ({
            order: index + 1,
            name: rule.name.trim(),
            enabled: rule.enabled,
            conditions: {
               caseTypeKeys: parseKeys(rule.caseTypeKeys),
               priorities: rule.priorities,
               sourceChannels: rule.sourceChannels,
               impacts: rule.impacts,
               urgencies: rule.urgencies,
            },
            action: {
               targetDepartmentId: rule.targetDepartmentId,
               assignmentMode: rule.assignmentMode,
               requiredSkills: rule.assignmentMode === 'CAPACITY_AWARE' ? parseKeys(rule.requiredSkills) : [],
            },
         })),
      };
      if (payload.rules.some((rule) => !rule.name || !rule.action.targetDepartmentId)) {
         setError('نام و دپارتمان مقصد برای همه قواعد لازم است.');
         return;
      }
      if (!payload.rules.some((rule) => rule.enabled)) {
         setError('دست‌کم یک قاعده باید فعال باشد.');
         return;
      }
      setSubmitting(true);
      setError('');
      try {
         onCreated(await supportRoutingClient.createPolicy(payload));
         onOpenChange(false);
      } catch (caught) {
         setError(message(caught, 'ساخت نسخه مسیریابی ناموفق بود.'));
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
         <DialogContent dir="rtl" className="max-h-[90vh] max-w-5xl overflow-y-auto border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader><DialogTitle>نسخه جدید سیاست مسیریابی</DialogTitle><DialogDescription className="leading-6 text-zinc-500">قواعد از بالا به پایین ارزیابی می‌شوند و اولین تطابق برنده است. نسخه قبلی برای حسابرسی باقی می‌ماند.</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={submit}>
               {error ? <InlineError text={error} /> : null}
               <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                  <Field label="نام نسخه"><Input className={inputClass} maxLength={160} placeholder="مثلاً مسیر سازمانی پاییز" value={label} onChange={(event) => setLabel(event.target.value)} /></Field>
                  <label className="flex items-center gap-3 rounded-lg border border-white/8 bg-black/10 px-3 py-2 text-sm text-zinc-300"><input checked={activate} type="checkbox" onChange={(event) => setActivate(event.target.checked)} /><span><b className="block font-medium">فعال‌سازی پس از ساخت</b><span className="text-xs text-zinc-600">نسخه فعال فعلی جایگزین می‌شود.</span></span></label>
               </div>
               <div className="space-y-3">
                  {rules.map((rule, index) => (
                     <RuleEditor
                        key={index}
                        departments={departments}
                        index={index}
                        rule={rule}
                        removable={rules.length > 1}
                        onChange={(next) => setRules((current) => current.map((item, itemIndex) => itemIndex === index ? next : item))}
                        onRemove={() => setRules((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                     />
                  ))}
               </div>
               <Button className="border border-dashed border-white/15 bg-white/[0.025] text-zinc-300" type="button" variant="secondary" onClick={() => setRules((current) => [...current, emptyRule(departments[0]?.id || '')])}><Plus className="size-4" /> افزودن قاعده</Button>
               <DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={submitting || !departments.length} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} ساخت نسخه</Button><Button disabled={submitting} type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function RuleEditor({ departments, index, onChange, onRemove, removable, rule }: {
   departments: SupportDepartment[];
   index: number;
   onChange: (rule: RoutingRuleDraft) => void;
   onRemove: () => void;
   removable: boolean;
   rule: RoutingRuleDraft;
}) {
   return (
      <section className="space-y-4 rounded-xl border border-white/8 bg-black/10 p-4" data-testid="support-routing-rule-editor">
         <div className="flex items-center gap-3"><span className="flex size-7 items-center justify-center rounded-full bg-indigo-400/10 font-mono text-xs text-indigo-200">{(index + 1).toLocaleString('fa-IR')}</span><Input aria-label={`نام قاعده ${index + 1}`} className={cn(inputClass, 'flex-1')} maxLength={160} placeholder="نام قاعده" value={rule.name} onChange={(event) => onChange({ ...rule, name: event.target.value })} /><label className="flex items-center gap-2 text-xs text-zinc-500"><input checked={rule.enabled} type="checkbox" onChange={(event) => onChange({ ...rule, enabled: event.target.checked })} /> فعال</label>{removable ? <Button aria-label={`حذف قاعده ${index + 1}`} className="text-zinc-600 hover:bg-red-400/10 hover:text-red-300" size="icon" type="button" variant="ghost" onClick={onRemove}><X className="size-4" /></Button> : null}</div>
         <div className="grid gap-3 md:grid-cols-2">
            <Field label="نوع پرونده‌ها (خالی یعنی همه)"><Input aria-label={`نوع پرونده‌های قاعده ${index + 1}`} dir="ltr" className={cn(inputClass, 'text-left')} placeholder="general, billing" value={rule.caseTypeKeys} onChange={(event) => onChange({ ...rule, caseTypeKeys: event.target.value })} /></Field>
            <Field label="کانال ورودی"><ChipChecks options={supportCaseSources.map((value) => ({ value, label: sourceLabel(value) }))} values={rule.sourceChannels} onChange={(values) => onChange({ ...rule, sourceChannels: values as SupportCaseSource[] })} /></Field>
            <Field label="اولویت"><ChipChecks options={supportCasePriorities.map((value) => ({ value, label: priorityLabel(value) }))} values={rule.priorities} onChange={(values) => onChange({ ...rule, priorities: values as SupportCasePriority[] })} /></Field>
            <Field label="اثر"><ChipChecks options={levels.map((value) => ({ value, label: levelLabel(value) }))} values={rule.impacts} onChange={(values) => onChange({ ...rule, impacts: values as RoutingRuleDraft['impacts'] })} /></Field>
            <Field label="فوریت"><ChipChecks options={levels.map((value) => ({ value, label: levelLabel(value) }))} values={rule.urgencies} onChange={(values) => onChange({ ...rule, urgencies: values as RoutingRuleDraft['urgencies'] })} /></Field>
         </div>
         <div className="grid gap-3 border-t border-white/6 pt-4 md:grid-cols-3">
            <Field label="دپارتمان مقصد"><select aria-label={`دپارتمان مقصد قاعده ${index + 1}`} className={selectClass} value={rule.targetDepartmentId} onChange={(event) => onChange({ ...rule, targetDepartmentId: event.target.value })}><option value="">انتخاب دپارتمان</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></Field>
            <Field label="روش واگذاری"><select aria-label={`روش واگذاری قاعده ${index + 1}`} className={selectClass} value={rule.assignmentMode} onChange={(event) => onChange({ ...rule, assignmentMode: event.target.value as SupportRoutingAssignmentMode, requiredSkills: event.target.value === 'CAPACITY_AWARE' ? rule.requiredSkills : '' })}><option value="DEPARTMENT_INBOX">صف دپارتمان</option><option value="CAPACITY_AWARE">ظرفیت و مهارت</option></select></Field>
            <Field label="مهارت‌های لازم"><Input aria-label={`مهارت‌های لازم قاعده ${index + 1}`} dir="ltr" className={cn(inputClass, 'text-left')} disabled={rule.assignmentMode !== 'CAPACITY_AWARE'} placeholder="billing, api:enterprise" value={rule.requiredSkills} onChange={(event) => onChange({ ...rule, requiredSkills: event.target.value })} /></Field>
         </div>
      </section>
   );
}

function ChipChecks({ onChange, options, values }: { onChange: (values: string[]) => void; options: Array<{ label: string; value: string }>; values: readonly string[] }) {
   return <div className="flex min-h-9 flex-wrap gap-1.5 rounded-md border border-white/10 bg-[#0c0c0e] p-1.5">{options.map((option) => { const checked = values.includes(option.value); return <label key={option.value} className={cn('cursor-pointer rounded px-2 py-1 text-[11px]', checked ? 'bg-indigo-400/15 text-indigo-100' : 'text-zinc-600 hover:bg-white/5')}><input className="sr-only" checked={checked} type="checkbox" onChange={() => onChange(checked ? values.filter((value) => value !== option.value) : [...values, option.value])} />{option.label}</label>; })}</div>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: number | string }) {
   return <div className="rounded-xl border border-white/7 bg-[#171719] p-4"><Icon className="size-4 text-zinc-500" /><p className="mt-3 text-2xl font-semibold text-zinc-100">{typeof value === 'number' ? value.toLocaleString('fa-IR') : value}</p><p className="mt-1 text-xs text-zinc-600">{label}</p></div>;
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
   return <label className="grid gap-1.5 text-xs text-zinc-500"><span>{label}</span>{children}</label>;
}

function InlineError({ text }: { text: string }) {
   return <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{text}</p>;
}

function Loading({ text }: { text: string }) {
   return <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-600"><Loader2 className="size-4 animate-spin" /> {text}</div>;
}

function Empty({ text }: { text: string }) {
   return <div className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm leading-7 text-zinc-600"><CircleOff className="mx-auto mb-3 size-5" />{text}</div>;
}

function emptyRule(departmentId: string): RoutingRuleDraft {
   return { name: '', enabled: true, caseTypeKeys: '', priorities: [], sourceChannels: [], impacts: [], urgencies: [], targetDepartmentId: departmentId, assignmentMode: 'DEPARTMENT_INBOX', requiredSkills: '' };
}

function ruleToDraft(rule: SupportRoutingPolicy['rules'][number]): RoutingRuleDraft {
   return { name: rule.name, enabled: rule.enabled, caseTypeKeys: rule.conditions.caseTypeKeys.join(', '), priorities: [...rule.conditions.priorities], sourceChannels: [...rule.conditions.sourceChannels], impacts: [...rule.conditions.impacts], urgencies: [...rule.conditions.urgencies], targetDepartmentId: rule.action.targetDepartmentId, assignmentMode: rule.action.assignmentMode, requiredSkills: rule.action.requiredSkills.join(', ') };
}

function memberToDraft(member: SupportRoutingMember): MemberDraft {
   return { availability: member.routingAvailability, capacity: String(member.routingCapacity), skills: member.routingSkills.join(', ') };
}

export function parseSupportRoutingKeys(value: string): string[] {
   return parseKeys(value);
}

function parseKeys(value: string): string[] {
   return [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))].sort();
}

function message(error: unknown, fallback: string) {
   return error instanceof Error && error.message ? error.message : fallback;
}

function priorityLabel(value: SupportCasePriority) {
   return ({ LOW: 'کم', NORMAL: 'عادی', HIGH: 'زیاد', URGENT: 'فوری' } as const)[value];
}

function sourceLabel(value: SupportCaseSource) {
   return ({ API: 'API', CALL: 'تماس', MANUAL: 'دستی', EMAIL: 'ایمیل', MESSAGING: 'پیام' } as const)[value];
}

function levelLabel(value: typeof levels[number]) {
   return ({ LOW: 'کم', MEDIUM: 'متوسط', HIGH: 'زیاد' } as const)[value];
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
