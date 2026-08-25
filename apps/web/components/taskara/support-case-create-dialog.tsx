import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Headphones, Loader2, MessageSquarePlus, PhoneCall } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { supportPriorityLabels } from '@/lib/support-presenters';
import type { SupportCase, SupportCasePriority } from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { cn } from '@/lib/utils';

type CreateMode = 'CASE' | 'CALL';

const initialForm = {
   title: '',
   description: '',
   typeKey: 'general',
   priority: 'NORMAL' as SupportCasePriority,
   departmentId: '',
   contactName: '',
   contactPhone: '',
   contactEmail: '',
   callSummary: '',
   internalNotes: '',
   disposition: 'ANSWERED' as 'ANSWERED' | 'MISSED' | 'ABANDONED' | 'VOICEMAIL',
   durationMinutes: '',
   recordingConsent: 'UNKNOWN' as 'UNKNOWN' | 'GIVEN' | 'DENIED' | 'NOT_REQUIRED',
   externalCallId: '',
   callbackAt: null as string | null,
};

export function SupportCaseCreateDialog({
   open,
   onOpenChange,
   onCreated,
}: {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   onCreated: (item: SupportCase) => void;
}) {
   const support = useSupportWorkspace();
   const runtime = useWorkspaceRuntime();
   const [mode, setMode] = useState<CreateMode>('CASE');
   const [form, setForm] = useState(initialForm);
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      if (!open) return;
      setError('');
      void support.loadDepartments().catch(() => undefined);
   }, [open, support.loadDepartments]);

   const valid = useMemo(() => {
      if (!form.title.trim()) return false;
      if (mode === 'CALL' && !support.manualCallAvailable) return false;
      if (mode === 'CALL' && !form.callSummary.trim()) return false;
      return true;
   }, [form.callSummary, form.title, mode, support.manualCallAvailable]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!valid) return;
      setSubmitting(true);
      setError('');
      const contact = compactContact(form);
      const common = {
         title: form.title.trim(),
         description: form.description.trim() || undefined,
         typeKey: form.typeKey.trim() || 'general',
         priority: form.priority,
         departmentId: form.departmentId || undefined,
         contact,
         idempotencyKey: createIdempotencyKey(),
      };

      try {
         const endedAt = new Date();
         const durationSeconds = Math.max(0, Math.round(Number(form.durationMinutes || 0) * 60));
         const startedAt = new Date(endedAt.getTime() - durationSeconds * 1000);
         const item = mode === 'CALL'
            ? await support.createCall({
                 newCase: { ...common, sourceChannel: 'CALL' },
                 summary: form.callSummary.trim(),
                 internalNotes: form.internalNotes.trim() || undefined,
                 call: {
                    direction: 'INBOUND',
                    disposition: form.disposition,
                    startedAt: startedAt.toISOString(),
                    answeredAt: form.disposition === 'ANSWERED' ? startedAt.toISOString() : undefined,
                    endedAt: endedAt.toISOString(),
                    durationSeconds,
                    recordingConsent: form.recordingConsent,
                    recordingExists: false,
                    externalCallId: form.externalCallId.trim() || undefined,
                    callbackOwnerId: form.callbackAt ? runtime.me.user.id : undefined,
                    callbackDueAt: form.callbackAt || undefined,
                 },
              })
            : await support.createCase({ ...common, sourceChannel: 'MANUAL' });
         setForm(initialForm);
         setMode('CASE');
         onOpenChange(false);
         onCreated(item);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ثبت پرونده ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
         <DialogContent dir="rtl" className="max-w-2xl gap-0 overflow-hidden border-white/10 bg-[#171719] p-0 text-zinc-100" data-testid="support-create-dialog">
            <DialogHeader className="border-b border-white/8 px-5 py-4 text-right">
               <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-indigo-400/10 text-indigo-300"><Headphones className="size-4" /></span>
                  <div>
                     <DialogTitle>ثبت ورودی پشتیبانی</DialogTitle>
                     <DialogDescription className="mt-1.5 text-zinc-500">درخواست دستی یا تماس مرکز تماس را به پرونده قابل پیگیری تبدیل کنید.</DialogDescription>
                  </div>
               </div>
            </DialogHeader>

            <div className="grid grid-cols-2 border-b border-white/7 bg-black/10 p-1.5">
               <ModeButton active={mode === 'CASE'} icon={MessageSquarePlus} label="درخواست دستی" onClick={() => setMode('CASE')} />
               <ModeButton active={mode === 'CALL'} icon={PhoneCall} label="تماس تلفنی" onClick={() => setMode('CALL')} />
            </div>

            <form className="min-h-0" onSubmit={submit}>
               <div className="max-h-[calc(100svh-13rem)] space-y-5 overflow-y-auto px-5 py-4">
                  {error ? <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{error}</p> : null}

                  <section className="grid gap-4">
                     <Field label="عنوان پرونده" required>
                        <Input autoFocus className={inputClass} maxLength={240} placeholder="خلاصه روشن از مسئله مشتری" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
                     </Field>
                     <Field label="شرح درخواست">
                        <Textarea className={cn(inputClass, 'min-h-24 resize-y')} maxLength={50_000} placeholder="زمینه، انتظار مشتری و اطلاعات لازم برای پیگیری…" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
                     </Field>
                  </section>

                  <section className="grid gap-4 rounded-xl border border-white/7 bg-white/[0.02] p-4 sm:grid-cols-2">
                     <Field label="نام مشتری">
                        <Input className={inputClass} value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} />
                     </Field>
                     <Field label="شماره تماس">
                        <Input dir="ltr" className={cn(inputClass, 'text-left')} inputMode="tel" placeholder="+982112345678" value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} />
                     </Field>
                     <Field label="ایمیل">
                        <Input dir="ltr" className={cn(inputClass, 'text-left')} type="email" placeholder="customer@example.com" value={form.contactEmail} onChange={(event) => setForm({ ...form, contactEmail: event.target.value })} />
                     </Field>
                     <Field label="دپارتمان اولیه">
                        <select className={selectClass} value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>
                           <option value="">بدون دپارتمان — ارسال به تریاژ</option>
                           {support.departments.filter((item) => item.active).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                        </select>
                     </Field>
                  </section>

                  <section className="grid gap-4 sm:grid-cols-2">
                     <Field label="اولویت">
                        <select className={selectClass} value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as SupportCasePriority })}>
                           {Object.entries(supportPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                     </Field>
                     <Field label="نوع درخواست">
                        <Input dir="ltr" className={cn(inputClass, 'text-left')} pattern="[a-z][a-z0-9_-]*" value={form.typeKey} onChange={(event) => setForm({ ...form, typeKey: event.target.value.toLowerCase() })} />
                     </Field>
                  </section>

                  {mode === 'CALL' ? (
                     <section className="grid gap-4 rounded-xl border border-sky-400/15 bg-sky-400/[0.04] p-4">
                        {!support.manualCallAvailable ? (
                           <p className="rounded-lg border border-amber-400/15 bg-amber-400/[0.045] px-3 py-2.5 text-xs leading-6 text-amber-100/80">ثبت تماس پس از فعال‌شدن سرویس رمزنگاری محتوای مشتری در API در دسترس می‌شود. هیچ متن یا خلاصه تماس به‌صورت رمزنگاری‌نشده نگهداری نخواهد شد.</p>
                        ) : null}
                        <div className="grid gap-4 sm:grid-cols-2">
                           <Field label="نتیجه تماس">
                              <select className={selectClass} value={form.disposition} onChange={(event) => setForm({ ...form, disposition: event.target.value as typeof form.disposition })}>
                                 <option value="ANSWERED">پاسخ داده شد</option>
                                 <option value="MISSED">بی‌پاسخ</option>
                                 <option value="ABANDONED">قطع‌شده</option>
                                 <option value="VOICEMAIL">پیام صوتی</option>
                              </select>
                           </Field>
                           <Field label="خلاصه تماس" required>
                              <Input className={inputClass} maxLength={10_000} placeholder="نتیجه اصلی گفتگو" value={form.callSummary} onChange={(event) => setForm({ ...form, callSummary: event.target.value })} />
                           </Field>
                        </div>
                        <Field label="یادداشت داخلی اپراتور">
                           <Textarea className={cn(inputClass, 'min-h-20')} value={form.internalNotes} onChange={(event) => setForm({ ...form, internalNotes: event.target.value })} />
                        </Field>
                        <div className="grid gap-4 sm:grid-cols-2">
                           <Field label="مدت تماس (دقیقه)">
                              <Input dir="ltr" className={cn(inputClass, 'text-left')} min="0" max="1440" step="0.5" type="number" value={form.durationMinutes} onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })} />
                           </Field>
                           <Field label="رضایت ضبط">
                              <select className={selectClass} value={form.recordingConsent} onChange={(event) => setForm({ ...form, recordingConsent: event.target.value as typeof form.recordingConsent })}>
                                 <option value="UNKNOWN">نامشخص</option>
                                 <option value="GIVEN">رضایت داده شد</option>
                                 <option value="DENIED">رضایت داده نشد</option>
                                 <option value="NOT_REQUIRED">نیاز ندارد</option>
                              </select>
                           </Field>
                           <Field label="شناسه تماس در سامانه تلفنی">
                              <Input dir="ltr" className={cn(inputClass, 'text-left')} maxLength={240} value={form.externalCallId} onChange={(event) => setForm({ ...form, externalCallId: event.target.value })} />
                           </Field>
                           <Field label="موعد تماس برگشتی">
                              <LazyJalaliDatePicker ariaLabel="موعد تماس برگشتی" showTime value={form.callbackAt} onChange={(callbackAt) => setForm({ ...form, callbackAt })} />
                           </Field>
                        </div>
                        <p className="text-xs leading-6 text-zinc-600">فایل ضبط تماس در نسخه عملیاتی اول ذخیره نمی‌شود؛ فقط وضعیت رضایت ثبت می‌شود.</p>
                     </section>
                  ) : null}
               </div>
               <DialogFooter className="border-t border-white/8 px-5 py-3 sm:flex-row-reverse sm:justify-start">
                  <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={!valid || submitting} type="submit">
                     {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                     {mode === 'CALL' ? 'ثبت تماس و پرونده' : 'ثبت پرونده'}
                  </Button>
                  <Button className="text-zinc-400 hover:bg-white/6 hover:text-zinc-200" disabled={submitting} type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function ModeButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
   return (
      <button className={cn('flex h-9 items-center justify-center gap-2 rounded-md text-sm transition', active ? 'bg-white/8 text-zinc-100' : 'text-zinc-500 hover:bg-white/4 hover:text-zinc-300')} type="button" onClick={onClick}>
         <Icon className="size-4" /> {label}
      </button>
   );
}

function Field({ children, label, required }: { children: React.ReactNode; label: string; required?: boolean }) {
   return <label className="grid gap-1.5 text-sm text-zinc-300"><span>{label}{required ? <span className="ms-1 text-red-300">*</span> : null}</span>{children}</label>;
}

function compactContact(form: typeof initialForm) {
   const contact = {
      name: form.contactName.trim() || undefined,
      phone: form.contactPhone.trim().replace(/[\s()-]/g, '') || undefined,
      email: form.contactEmail.trim().toLowerCase() || undefined,
   };
   return contact.name || contact.phone || contact.email ? contact : undefined;
}

function createIdempotencyKey() {
   return globalThis.crypto?.randomUUID?.() || `support-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
