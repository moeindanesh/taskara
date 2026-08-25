import type { ReactNode } from 'react';
import {
   ArrowLeft,
   BookOpenCheck,
   CheckCircle2,
   Loader2,
   RotateCcw,
   ShieldCheck,
   Sparkles,
   X,
   XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatJalaliDateTime } from '@/lib/jalali';
import type {
   SupportAssistanceDecision,
   SupportAssistanceSuggestion,
   SupportEnablementPreview,
   SupportKnowledgeOutcome,
   SupportKnowledgeUse,
   SupportKnowledgeUsefulness,
} from '@/lib/support-maturity-types';
import {
   supportPriorityLabels,
   supportSourceLabels,
   supportStatusLabels,
} from '@/lib/support-presenters';

type HumanSuggestionDecision = Extract<SupportAssistanceDecision, 'ACCEPTED' | 'REJECTED'>;

export function SupportAssistanceSuggestionItem({
   busy,
   canDecide = true,
   item,
   reason,
   onReason,
   onDecide,
}: {
   busy: boolean;
   canDecide?: boolean;
   item: SupportAssistanceSuggestion;
   reason: string;
   onReason: (reason: string) => void;
   onDecide: (decision: HumanSuggestionDecision) => void | Promise<void>;
}) {
   const pending = item.decision === 'PENDING';
   const reasonIsValid = reason.trim().length >= 3;

   return (
      <article
         aria-busy={busy}
         className="rounded-xl border border-white/8 bg-[#171719] p-4 text-zinc-100"
         dir="rtl"
      >
         <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
               <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                  <Sparkles aria-hidden="true" className="size-4 shrink-0 text-indigo-300" />
                  {assistanceKindLabels[item.kind]}
               </h3>
               <p className="mt-1.5 text-[11px] leading-5 text-zinc-600">
                  پیشنهاد کمکی است و بدون تصمیم روشن شما اجرا نمی‌شود.
               </p>
            </div>
            <Badge className={decisionTone(item.decision)} variant="outline">
               {assistanceDecisionLabels[item.decision]}
            </Badge>
         </div>

         <div className="mt-4 rounded-lg border border-white/7 bg-black/10 p-3">
            <AssistancePayload item={item} />
         </div>

         <div className="mt-3 grid gap-2 rounded-lg border border-white/7 bg-white/[0.02] p-3 text-[11px] leading-5 text-zinc-500 sm:grid-cols-2">
            <p className="min-w-0">
               <span className="block text-zinc-600">منبع و نسخه</span>
               <bdi className="mt-0.5 block truncate font-mono text-zinc-400" dir="ltr">
                  {provenanceLabel(item)}
               </bdi>
            </p>
            <p>
               <span className="block text-zinc-600">اطمینان پیشنهاد</span>
               <span className="mt-0.5 block tabular-nums text-zinc-400">
                  {confidenceLabel(item.provenance.confidence)}
               </span>
            </p>
            <p className="min-w-0 sm:col-span-2">
               <span className="text-zinc-600">اثر انگشت زمینه: </span>
               <bdi className="font-mono text-zinc-500" dir="ltr">
                  {shortDigest(item.provenance.contextDigest)}
               </bdi>
            </p>
         </div>

         {pending && canDecide ? (
            <div className="mt-4 space-y-3">
               <label className="grid gap-1.5 text-xs text-zinc-500">
                  دلیل تصمیم انسانی
                  <Textarea
                     aria-label="دلیل تصمیم درباره پیشنهاد"
                     className={inputClass}
                     disabled={busy}
                     maxLength={2000}
                     placeholder="دلیل پذیرش یا رد را ثبت کنید…"
                     value={reason}
                     onChange={(event) => onReason(event.target.value)}
                  />
               </label>
               <p className="text-[11px] leading-5 text-zinc-600">
                  برای هر تصمیم، دست‌کم سه نویسه دلیل لازم است و تصمیم با نام شما ثبت می‌شود.
               </p>
               <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                     className="bg-lime-300/15 text-lime-100 hover:bg-lime-300/25"
                     disabled={busy || !reasonIsValid}
                     type="button"
                     onClick={() => void onDecide('ACCEPTED')}
                  >
                     {busy ? (
                        <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                     ) : (
                        <CheckCircle2 aria-hidden="true" className="size-4" />
                     )}
                     پذیرش انسانی
                  </Button>
                  <Button
                     className="border border-red-400/15 bg-red-400/[0.035] text-red-100 hover:bg-red-400/10"
                     disabled={busy || !reasonIsValid}
                     type="button"
                     variant="secondary"
                     onClick={() => void onDecide('REJECTED')}
                  >
                     <XCircle aria-hidden="true" className="size-4" />
                     رد پیشنهاد
                  </Button>
               </div>
            </div>
         ) : pending ? (
            <p className="mt-4 rounded-lg border border-white/7 bg-black/10 px-3 py-2.5 text-xs leading-6 text-zinc-500">
               این پیشنهاد فقط برای مشاهده است؛ تصمیم‌گیری به مسئول فعلی یا مدیر مجاز نیاز دارد.
            </p>
         ) : item.decisionReason ? (
            <div className="mt-4 rounded-lg border border-white/7 bg-black/10 px-3 py-2.5">
               <p className="text-[11px] text-zinc-600">دلیل تصمیم ثبت‌شده</p>
               <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-6 text-zinc-400" dir="auto">
                  {item.decisionReason}
               </p>
            </div>
         ) : null}
      </article>
   );
}

export function SupportEnablementPreviewPanel({
   busy,
   canApply = true,
   preview,
   onApply,
   onClear,
}: {
   busy: boolean;
   canApply?: boolean;
   preview: SupportEnablementPreview;
   onApply: () => void | Promise<void>;
   onClear: () => void;
}) {
   return (
      <section
         aria-busy={busy}
         aria-label="پیش‌نمایش دقیق تغییرات"
         className="rounded-xl border border-indigo-400/15 bg-[#171719] p-4 text-zinc-100"
         dir="rtl"
      >
         <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
               <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                  <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-indigo-300" />
                  پیش‌نمایش دقیق تغییرات
               </h3>
               <p className="mt-1.5 text-xs leading-6 text-zinc-500">
                  <span dir="auto">{preview.definition.name}</span>
                  {' · پرونده '}
                  <bdi className="font-mono text-zinc-400" dir="ltr">{preview.case.key}</bdi>
                  {' · نسخه '}
                  {preview.case.version.toLocaleString('fa-IR')}
               </p>
            </div>
            <Button
               aria-label="بستن پیش‌نمایش"
               className="size-8 shrink-0 text-zinc-600 hover:bg-white/5 hover:text-zinc-300"
               disabled={busy}
               size="icon"
               type="button"
               variant="ghost"
               onClick={onClear}
            >
               <X aria-hidden="true" className="size-4" />
            </Button>
         </div>

         {preview.changes.length ? (
            <ol className="mt-4 space-y-2" aria-label="فهرست تغییرات پیش‌نمایش‌شده">
               {preview.changes.map((change) => (
                  <li
                     key={change.field}
                     className="grid gap-2 rounded-lg border border-white/7 bg-black/10 p-3 sm:grid-cols-[minmax(7rem,0.7fr)_1fr_auto_1fr] sm:items-center"
                  >
                     <span className="text-xs font-medium text-zinc-400">
                        {enablementFieldLabel(change.field)}
                     </span>
                     <PreviewValue field={change.field} value={change.before} />
                     <ArrowLeft aria-hidden="true" className="hidden size-4 text-zinc-700 sm:block" />
                     <PreviewValue field={change.field} value={change.after} emphasized />
                  </li>
               ))}
            </ol>
         ) : (
            <p className="mt-4 rounded-lg border border-white/7 bg-black/10 px-3 py-3 text-xs leading-6 text-zinc-500">
               این تعریف در نسخه فعلی پرونده تغییری ایجاد نمی‌کند.
            </p>
         )}

         {!preview.conditionMatched ? (
            <p className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/[0.035] px-3 py-2.5 text-xs leading-6 text-amber-100/75">
               شرط‌های تعریف با نسخه فعلی پرونده منطبق نیستند؛ اعمال غیرفعال است.
            </p>
         ) : null}

         <div className="mt-4 rounded-lg border border-lime-400/15 bg-lime-400/[0.035] px-3 py-2.5 text-xs leading-6 text-lime-100/75">
            <p className="flex items-start gap-2">
               <CheckCircle2 aria-hidden="true" className="mt-1 size-4 shrink-0" />
               <span>فقط با تأیید انسان اعمال می‌شود؛ هیچ اقدام خودکاری از این پیش‌نمایش اجرا نشده است.</span>
            </p>
            <p className="mt-1 flex items-start gap-2 text-zinc-500">
               <RotateCcw aria-hidden="true" className="mt-1 size-4 shrink-0" />
               <span>سامانه مقادیر پیشین را برای بازگردانی امن همین تغییر ثبت می‌کند.</span>
            </p>
         </div>

         <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
            <Button
               className="bg-indigo-400/15 text-indigo-100 hover:bg-indigo-400/25"
               disabled={busy || !canApply || !preview.canApply || !preview.conditionMatched || !preview.changes.length}
               type="button"
               onClick={() => void onApply()}
            >
               {busy ? (
                  <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
               ) : (
                  <ShieldCheck aria-hidden="true" className="size-4" />
               )}
               اعمال تغییرات پیش‌نمایش‌شده
            </Button>
            <Button
               className="border border-white/10 bg-white/5 text-zinc-400"
               disabled={busy}
               type="button"
               variant="secondary"
               onClick={onClear}
            >
               بستن پیش‌نمایش
            </Button>
         </div>
      </section>
   );
}

export function SupportKnowledgeUseHistory({ items }: { items: SupportKnowledgeUse[] }) {
   return (
      <section className="rounded-xl border border-white/8 bg-[#171719] p-4 text-zinc-100" dir="rtl">
         <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <BookOpenCheck aria-hidden="true" className="size-4 text-indigo-300" />
            سابقه استفاده از دانش
         </h3>
         <p className="mt-1.5 text-[11px] leading-5 text-zinc-600">
            فقط فراداده صفحه‌های مستقلاً مجاز و نتیجه ثبت‌شده استفاده نمایش داده می‌شود.
         </p>

         {items.length ? (
            <ol className="mt-4 space-y-2">
               {items.map((item) => (
                  <li key={item.id} className="rounded-lg border border-white/7 bg-black/10 p-3">
                     <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                           <p className="break-words text-sm font-medium leading-6 text-zinc-300" dir="auto">
                              {item.page.title}
                           </p>
                           <p className="mt-1 text-[11px] text-zinc-600">
                              نسخه {item.knowledgePageVersion.toLocaleString('fa-IR')}
                           </p>
                        </div>
                        <Badge className="border-white/10 bg-white/[0.025] text-zinc-400" variant="outline">
                           {knowledgePageStatusLabel(item.page.status)}
                        </Badge>
                     </div>
                     <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                        <span className="rounded-md bg-indigo-400/8 px-2 py-1 text-indigo-200">
                           {knowledgeUsefulnessLabels[item.usefulness]}
                        </span>
                        <span className="rounded-md bg-lime-400/[0.055] px-2 py-1 text-lime-100/80">
                           {knowledgeOutcomeLabels[item.outcome]}
                        </span>
                        <time className="px-1 py-1 text-zinc-600" dateTime={item.createdAt}>
                           {formatJalaliDateTime(item.createdAt)}
                        </time>
                     </div>
                  </li>
               ))}
            </ol>
         ) : (
            <p className="mt-4 rounded-lg border border-dashed border-white/8 px-3 py-5 text-center text-xs text-zinc-600">
               هنوز استفاده‌ای از دانش برای این پرونده ثبت نشده است.
            </p>
         )}
      </section>
   );
}

function AssistancePayload({ item }: { item: SupportAssistanceSuggestion }) {
   switch (item.kind) {
      case 'TYPE':
         return <PayloadValue label="نوع پیشنهادی"><bdi className="font-mono" dir="ltr">{item.payload.typeKey}</bdi></PayloadValue>;
      case 'PRIORITY':
         return <PayloadValue label="اولویت پیشنهادی">{supportPriorityLabels[item.payload.priority]}</PayloadValue>;
      case 'DEPARTMENT':
         return <PayloadValue label="دپارتمان پیشنهادی">یک دپارتمان مجاز؛ مقصد هنگام تصمیم دوباره اعتبارسنجی می‌شود</PayloadValue>;
      case 'DUPLICATE':
         return <PayloadValue label="پرونده تکراری پیشنهادی">یک پرونده قابل مشاهده؛ دسترسی هنگام تصمیم دوباره اعتبارسنجی می‌شود</PayloadValue>;
      case 'SUMMARY':
         return <PayloadValue label="خلاصه پیشنهادی"><span className="whitespace-pre-wrap" dir="auto">{item.payload.text}</span></PayloadValue>;
      case 'REPLY':
         return <PayloadValue label="پاسخ پیشنهادی"><span className="whitespace-pre-wrap" dir="auto">{item.payload.text}</span></PayloadValue>;
      case 'KNOWLEDGE':
         return (
            <div>
               <p className="text-[11px] text-zinc-600">منابع دانشی پیشنهادی</p>
               <ul className="mt-2 space-y-2">
                  {item.payload.references.map((reference) => (
                     <li key={reference.pageId} className="rounded-md bg-white/[0.025] px-2.5 py-2">
                        <p className="text-xs font-medium text-zinc-300" dir="auto">{reference.title}</p>
                        {reference.reason ? <p className="mt-1 text-[11px] leading-5 text-zinc-500" dir="auto">{reference.reason}</p> : null}
                     </li>
                  ))}
               </ul>
            </div>
         );
   }
}

function PayloadValue({ children, label }: { children: ReactNode; label: string }) {
   return (
      <div>
         <p className="text-[11px] text-zinc-600">{label}</p>
         <div className="mt-1 break-words text-sm leading-7 text-zinc-300">{children}</div>
      </div>
   );
}

function PreviewValue({
   emphasized = false,
   field,
   value,
}: {
   emphasized?: boolean;
   field: string;
   value: string | number | null;
}) {
   return (
      <div className={emphasized
         ? 'rounded-md border border-lime-400/10 bg-lime-400/[0.035] px-2.5 py-2 text-xs text-lime-100/80'
         : 'rounded-md border border-white/6 bg-white/[0.02] px-2.5 py-2 text-xs text-zinc-500'}>
         <span className="mb-1 block text-[10px] text-zinc-600 sm:hidden">
            {emphasized ? 'پس از اعمال' : 'پیش از اعمال'}
         </span>
         {enablementValue(field, value)}
      </div>
   );
}

function enablementValue(field: string, value: string | number | null): ReactNode {
   if (value === null) return 'ثبت نشده';
   if (typeof value === 'number') return value.toLocaleString('fa-IR');
   if (field === 'priority' && value in supportPriorityLabels) {
      return supportPriorityLabels[value as keyof typeof supportPriorityLabels];
   }
   if ((field === 'impact' || field === 'urgency') && value in supportLevelLabels) {
      return supportLevelLabels[value as keyof typeof supportLevelLabels];
   }
   if (field === 'status' && value in supportStatusLabels) {
      return supportStatusLabels[value as keyof typeof supportStatusLabels];
   }
   if (field === 'sourceChannel' && value in supportSourceLabels) {
      return supportSourceLabels[value as keyof typeof supportSourceLabels];
   }
   if (field === 'nextActionAt') return formatJalaliDateTime(value);
   return <bdi dir="auto">{value}</bdi>;
}

function enablementFieldLabel(field: string): string {
   return ({
      priority: 'اولویت',
      impact: 'اثر',
      urgency: 'فوریت',
      typeKey: 'نوع پرونده',
      nextActionAt: 'زمان اقدام بعدی',
      status: 'وضعیت',
      sourceChannel: 'کانال ورودی',
   } as Record<string, string>)[field] || field;
}

function provenanceLabel(item: SupportAssistanceSuggestion): string {
   const version = item.provenance.version.toLowerCase().startsWith('v')
      ? item.provenance.version
      : `v${item.provenance.version}`;
   return `${item.provenance.provider} / ${item.provenance.modelOrRule} / ${version}`;
}

function confidenceLabel(confidence: number): string {
   const percentage = Math.round(Math.min(1, Math.max(0, confidence)) * 100);
   return `${percentage.toLocaleString('fa-IR')}٪`;
}

function shortDigest(digest: string): string {
   if (digest.length <= 16) return digest;
   return `${digest.slice(0, 12)}…${digest.slice(-4)}`;
}

function decisionTone(decision: SupportAssistanceDecision): string {
   if (decision === 'ACCEPTED') return 'border-lime-400/20 bg-lime-400/[0.055] text-lime-200';
   if (decision === 'REJECTED') return 'border-red-400/20 bg-red-400/[0.055] text-red-200';
   if (decision === 'EXPIRED') return 'border-white/10 bg-white/[0.025] text-zinc-500';
   return 'border-indigo-400/20 bg-indigo-400/[0.055] text-indigo-200';
}

function knowledgePageStatusLabel(status: string): string {
   return ({ DRAFT: 'پیش‌نویس', PUBLISHED: 'منتشرشده', ARCHIVED: 'بایگانی‌شده' } as Record<string, string>)[status]
      || 'صفحه دانش';
}

const assistanceKindLabels: Record<SupportAssistanceSuggestion['kind'], string> = {
   TYPE: 'پیشنهاد نوع پرونده',
   PRIORITY: 'پیشنهاد اولویت',
   DEPARTMENT: 'پیشنهاد دپارتمان',
   DUPLICATE: 'پیشنهاد پرونده تکراری',
   SUMMARY: 'پیشنهاد خلاصه',
   REPLY: 'پیشنهاد پاسخ',
   KNOWLEDGE: 'پیشنهاد دانش',
};

const assistanceDecisionLabels: Record<SupportAssistanceDecision, string> = {
   PENDING: 'در انتظار تصمیم انسانی',
   ACCEPTED: 'پذیرفته‌شده',
   REJECTED: 'ردشده',
   EXPIRED: 'منقضی‌شده',
};

const supportLevelLabels = { LOW: 'کم', MEDIUM: 'متوسط', HIGH: 'زیاد' } as const;

const knowledgeUsefulnessLabels: Record<SupportKnowledgeUsefulness, string> = {
   HELPFUL: 'مفید',
   PARTIAL: 'تا حدی مفید',
   NOT_HELPFUL: 'نامفید',
};

const knowledgeOutcomeLabels: Record<SupportKnowledgeOutcome, string> = {
   RESOLVED: 'پرونده حل شد',
   ADVANCED: 'پرونده پیش رفت',
   NO_EFFECT: 'بدون اثر',
};

const inputClass = 'min-h-20 border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
