import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Headphones, Loader2, MessageSquarePlus, PhoneCall } from 'lucide-react';
import { Input, Modal, TextArea } from '@heroui/react';
import { SupportButton, SupportDisclosure, SupportSelect } from './support-ui';
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
   const submittingRef = useRef(false);

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
      if (!valid || submittingRef.current) return;
      submittingRef.current = true;
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
         submittingRef.current = false;
         setSubmitting(false);
      }
   }

   return (
      <Modal.Backdrop isOpen={open} onOpenChange={(next) => !submitting && onOpenChange(next)} isDismissable={!submitting} isKeyboardDismissDisabled={submitting}>
         <Modal.Container size="lg" placement="center" scroll="inside">
            <Modal.Dialog dir="rtl" className="support-ui max-w-xl rounded-2xl" data-testid="support-create-dialog">
               <Modal.Header className="border-b border-border pb-5">
                  <div className="flex items-center gap-3">
                     <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Headphones className="size-5" /></span>
                     <div><Modal.Heading className="text-lg font-semibold">ثبت ورودی پشتیبانی</Modal.Heading><p className="mt-1 text-sm text-muted-foreground">از یک عنوان روشن شروع کنید؛ جزئیات را بعداً کامل کنید.</p></div>
                  </div>
               </Modal.Header>
               <form id="support-create-form" className="contents" onSubmit={submit}>
                  <Modal.Body className="space-y-5 py-5">
                     <div className="flex gap-1 rounded-lg bg-secondary p-1" role="group" aria-label="نوع ورودی">
                        <SupportButton aria-pressed={mode === 'CASE'} variant={mode === 'CASE' ? 'tertiary' : 'ghost'} className={cn('flex-1', mode === 'CASE' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')} isDisabled={submitting} onPress={() => setMode('CASE')}><MessageSquarePlus className="size-4" />درخواست دستی</SupportButton>
                        <SupportButton aria-pressed={mode === 'CALL'} variant={mode === 'CALL' ? 'tertiary' : 'ghost'} className={cn('flex-1', mode === 'CALL' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')} isDisabled={submitting} onPress={() => setMode('CALL')}><PhoneCall className="size-4" />تماس تلفنی</SupportButton>
                     </div>
                     {error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">{error}</p> : null}
                     <Field label="عنوان پرونده" required><Input autoFocus required className={inputClass} maxLength={240} placeholder="چه مسئله‌ای نیاز به رسیدگی دارد؟" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field>
                     <Field label="شرح درخواست"><TextArea className={cn(inputClass, 'min-h-24 resize-y')} maxLength={50_000} placeholder="اطلاعاتی که به رسیدگی کمک می‌کند…" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
                     <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="نام مشتری"><Input className={inputClass} placeholder="اختیاری" value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} /></Field>
                        <Field label="شماره تماس"><Input dir="ltr" className={cn(inputClass, 'text-left')} type="tel" placeholder="09…" value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} /></Field>
                     </div>
                     {mode === 'CALL' ? <section className="space-y-4 border-t border-border pt-4">
                        {!support.manualCallAvailable ? <p role="status" className="rounded-lg bg-secondary p-3 text-sm text-muted-foreground">ثبت تماس در حال حاضر در دسترس نیست. با مدیر فضای کاری تماس بگیرید.</p> : null}
                        <Field label="خلاصه تماس" required><TextArea required className={cn(inputClass, 'min-h-20')} maxLength={10_000} placeholder="نتیجه گفتگو و پیگیری مورد نیاز" value={form.callSummary} onChange={(event) => setForm({ ...form, callSummary: event.target.value })} /></Field>
                        <div className="grid gap-4 sm:grid-cols-2">
                           <SupportSelect showLabel label="نتیجه تماس" value={form.disposition} onChange={(value) => setForm({ ...form, disposition: value as typeof form.disposition })} options={[{ value: 'ANSWERED', label: 'پاسخ داده شد' }, { value: 'MISSED', label: 'بی‌پاسخ' }, { value: 'ABANDONED', label: 'قطع‌شده' }, { value: 'VOICEMAIL', label: 'پیام صوتی' }]} />
                           <Field label="مدت تماس (دقیقه)"><Input dir="ltr" className={inputClass} min="0" max="1440" step="0.5" type="number" value={form.durationMinutes} onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })} /></Field>
                        </div>
                     </section> : null}
                     <SupportDisclosure title="جزئیات بیشتر (اختیاری)">
                        <div className="space-y-4">
                           <div className="grid gap-4 sm:grid-cols-2">
                              <SupportSelect showLabel label="اولویت" value={form.priority} onChange={(value) => setForm({ ...form, priority: value as SupportCasePriority })} options={Object.entries(supportPriorityLabels).map(([value, label]) => ({ value, label }))} />
                              <SupportSelect showLabel label="دپارتمان اولیه" placeholder="ارسال به تریاژ" value={form.departmentId} onChange={(value) => setForm({ ...form, departmentId: value })} options={[{ value: '', label: 'ارسال به تریاژ' }, ...support.departments.filter((item) => item.active).map((item) => ({ value: item.id, label: item.name }))]} />
                           </div>
                           <Field label="ایمیل"><Input dir="ltr" className={inputClass} type="email" placeholder="customer@example.com" value={form.contactEmail} onChange={(event) => setForm({ ...form, contactEmail: event.target.value })} /></Field>
                           {mode === 'CALL' ? <>
                              <Field label="یادداشت داخلی اپراتور"><TextArea className={inputClass} value={form.internalNotes} onChange={(event) => setForm({ ...form, internalNotes: event.target.value })} /></Field>
                              <SupportSelect showLabel label="رضایت ضبط" value={form.recordingConsent} onChange={(value) => setForm({ ...form, recordingConsent: value as typeof form.recordingConsent })} options={[{ value: 'UNKNOWN', label: 'نامشخص' }, { value: 'GIVEN', label: 'رضایت داده شد' }, { value: 'DENIED', label: 'رضایت داده نشد' }, { value: 'NOT_REQUIRED', label: 'نیاز ندارد' }]} />
                              <Field label="شناسه تماس در سامانه تلفنی"><Input dir="ltr" className={inputClass} maxLength={240} value={form.externalCallId} onChange={(event) => setForm({ ...form, externalCallId: event.target.value })} /></Field>
                              <Field label="موعد تماس برگشتی"><LazyJalaliDatePicker ariaLabel="موعد تماس برگشتی" showTime value={form.callbackAt} onChange={(callbackAt) => setForm({ ...form, callbackAt })} /></Field>
                           </> : null}
                        </div>
                     </SupportDisclosure>
                  </Modal.Body>
                  <Modal.Footer className="justify-start border-t border-border pt-4">
                     <SupportButton isDisabled={!valid || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : null}{mode === 'CALL' ? 'ثبت تماس و پرونده' : 'ثبت پرونده'}</SupportButton>
                     <SupportButton isDisabled={submitting} variant="ghost" onPress={() => onOpenChange(false)}>انصراف</SupportButton>
                  </Modal.Footer>
               </form>
               <Modal.CloseTrigger aria-label="بستن" isDisabled={submitting} />
            </Modal.Dialog>
         </Modal.Container>
      </Modal.Backdrop>
   );
}

function Field({ children, label, required }: { children: React.ReactNode; label: string; required?: boolean }) {
   return <label className="grid gap-2 text-sm text-foreground"><span>{label}{required ? <span aria-hidden="true" className="ms-1 text-destructive">*</span> : null}</span>{children}</label>;
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

const inputClass = 'w-full rounded-lg border border-border bg-background text-foreground shadow-none placeholder:text-muted-foreground';
