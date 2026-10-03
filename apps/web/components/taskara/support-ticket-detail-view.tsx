import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Bot, BriefcaseBusiness, ImagePlus, Loader2, LockKeyhole, MessageSquareText, RotateCcw, Save, Send, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatJalaliDateTime } from '@/lib/jalali';
import { TaskaraClientError } from '@/lib/taskara-client';
import { ticketMediaReferences, ticketMediaUrl, ticketVoiceTranscript, type SupportTicketMedia } from '@/lib/support-ticket-media';
import { SupportVoiceMessage } from '@/components/taskara/support-voice-message';
import {
   supportTicketClient,
   type SupportTicketDetail,
   type SupportTicketStatus,
} from '@/lib/support-ticket-client';
import type { SupportCasePriority } from '@/lib/support-types';

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
const levelLabels = { LOW: 'کم', MEDIUM: 'متوسط', HIGH: 'زیاد' } as const;

export function SupportTicketDetailView() {
   const { ticketKey = '' } = useParams();
   const navigate = useNavigate();
   const [detail, setDetail] = useState<SupportTicketDetail>();
   const [reply, setReply] = useState('');
   const [replyImages, setReplyImages] = useState<SupportTicketMedia[]>([]);
   const [draftReady, setDraftReady] = useState(false);
   const [title, setTitle] = useState('');
   const [description, setDescription] = useState('');
   const [priority, setPriority] = useState<SupportCasePriority>('NORMAL');
   const [impact, setImpact] = useState<'LOW' | 'MEDIUM' | 'HIGH' | ''>('');
   const [urgency, setUrgency] = useState<'LOW' | 'MEDIUM' | 'HIGH' | ''>('');
   const [typeKey, setTypeKey] = useState('public-web');
   const [busy, setBusy] = useState('');
   const [error, setError] = useState('');
   const [notice, setNotice] = useState('');

   const load = useCallback(async () => {
      setBusy('load');
      setError('');
      try {
         const next = await supportTicketClient.get(ticketKey);
         setDetail(next);
         setTitle(next.case?.title || next.ticket.title);
         setDescription(next.case?.description || '');
         setPriority(next.case?.priority || next.ticket.priority);
         setImpact(next.case?.impact || '');
         setUrgency(next.case?.urgency || '');
         setTypeKey(next.case?.typeKey || 'public-web');
         setDraftReady(false);
      } catch (caught) {
         setError('بارگذاری تیکت ناموفق بود.');
      } finally {
         setBusy('');
      }
   }, [ticketKey]);

   useEffect(() => { void load(); }, [load]);

   async function sendReply(event: FormEvent) {
      event.preventDefault();
      if (!reply.trim() && !replyImages.length) return;
      setBusy('reply');
      setError('');
      setNotice('');
      try {
         await supportTicketClient.reply(ticketKey, {
            text: reply.trim() || undefined,
            images: replyImages.length ? replyImages : undefined,
         });
         setReply('');
         setReplyImages([]);
         await load();
         setNotice('پاسخ برای مشتری ثبت شد.');
      } catch {
         setError('ارسال پاسخ ناموفق بود. دوباره تلاش کنید.');
      } finally {
         setBusy('');
      }
   }

   async function attachImages(files: FileList | null) {
      if (!files?.length) return;
      if (replyImages.length + files.length > 8) {
         setError('در هر پاسخ حداکثر ۸ تصویر می‌توانید ارسال کنید.');
         return;
      }
      setBusy('upload');
      setError('');
      try {
         for (const file of Array.from(files)) {
            if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
               throw new Error('unsupported');
            }
            const uploaded = await supportTicketClient.uploadImage(ticketKey, file);
            setReplyImages((current) => [...current, uploaded]);
         }
      } catch {
         setError('بارگذاری تصویر ناموفق بود. قالب‌های مجاز: PNG، JPEG، WebP و GIF.');
      } finally {
         setBusy('');
      }
   }

   async function changeStatus() {
      if (!detail) return;
      const next = detail.ticket.status === 'CLOSED' ? 'OPEN' : 'CLOSED';
      setBusy('status');
      setError('');
      setNotice('');
      try {
         const ticket = await supportTicketClient.updateStatus(ticketKey, next, detail.ticket.version);
         setDetail((current) => current ? { ...current, ticket } : current);
         setNotice(next === 'CLOSED' ? 'تیکت بسته شد.' : 'تیکت بازگشایی شد.');
      } catch (caught) {
         setError(caught instanceof TaskaraClientError && caught.status === 409
            ? 'وضعیت تیکت تغییر کرده است. صفحه را تازه‌سازی کنید.'
            : 'تغییر وضعیت تیکت ناموفق بود.');
      } finally {
         setBusy('');
      }
   }

   async function changePriority(next: SupportCasePriority) {
      if (!detail || next === detail.ticket.priority || busy) return;
      setBusy('priority');
      setError('');
      setNotice('');
      try {
         const ticket = await supportTicketClient.updatePriority(ticketKey, next, detail.ticket.version);
         setDetail((current) => current ? { ...current, ticket } : current);
         if (!detail.case && !draftReady && priority === detail.ticket.priority) setPriority(ticket.priority);
         setNotice('اولویت تیکت تغییر کرد.');
      } catch (caught) {
         if (caught instanceof TaskaraClientError && caught.status === 409) {
            try {
               const fresh = await supportTicketClient.get(ticketKey);
               setDetail((current) => current ? { ...current, ticket: fresh.ticket } : current);
               if (!detail.case && !draftReady && priority === detail.ticket.priority) setPriority(fresh.ticket.priority);
               setError('تیکت هم‌زمان تغییر کرده بود؛ اولویت تازه بارگذاری شد. دوباره تلاش کنید.');
            } catch {
               setError('تیکت هم‌زمان تغییر کرده است. صفحه را تازه‌سازی کنید.');
            }
         } else {
            setError('تغییر اولویت تیکت ناموفق بود. دوباره تلاش کنید.');
         }
      } finally {
         setBusy('');
      }
   }

   async function generateDraft() {
      setBusy('draft');
      setError('');
      try {
         const { draft, ticket } = await supportTicketClient.draftCase(ticketKey);
         setDetail((current) => current ? { ...current, ticket } : current);
         setTitle(draft.title);
         setDescription(draft.description);
         setPriority(draft.priority);
         setImpact(draft.impact || '');
         setUrgency(draft.urgency || '');
         setTypeKey(draft.typeKey);
         setDraftReady(true);
      } catch (caught) {
         setError(caught instanceof TaskaraClientError && caught.status === 409
            ? 'تیکت هنگام تولید عنوان تغییر کرده است. صفحه را تازه‌سازی کنید و دوباره تلاش کنید.'
            : caught instanceof TaskaraClientError && caught.status === 503
            ? 'پیش‌نویس هوش مصنوعی در دسترس نیست. تنظیمات مدل را بررسی کنید یا پرونده را دستی تکمیل کنید.'
            : 'پیش‌نویس هوشمند در دسترس نیست.');
      } finally {
         setBusy('');
      }
   }

   async function createCase(event: FormEvent) {
      event.preventDefault();
      setBusy('case');
      setError('');
      try {
         const result = await supportTicketClient.createCase(ticketKey, {
            useAi: false,
            title,
            description,
            priority,
            impact: impact || undefined,
            urgency: urgency || undefined,
            typeKey,
         });
         setDetail((current) => current ? { ...current, ticket: result.ticket, case: result.case } : current);
         setTitle(result.case.title);
         setDescription(result.case.description || '');
         setPriority(result.case.priority);
         setImpact(result.case.impact || '');
         setUrgency(result.case.urgency || '');
         setTypeKey(result.case.typeKey);
         setDraftReady(false);
      } catch {
         setError('ساخت پرونده ناموفق بود.');
      } finally {
         setBusy('');
      }
   }

   async function saveCase(event: FormEvent) {
      event.preventDefault();
      if (!detail?.case) return;
      setBusy('save');
      setError('');
      try {
         const result = await supportTicketClient.updateCase(ticketKey, {
            title,
            description,
            priority,
            impact: impact || null,
            urgency: urgency || null,
            typeKey,
            baseVersion: detail.case.version,
         });
         setDetail((current) => current ? { ...current, ticket: result.ticket, case: result.case } : current);
      } catch {
         setError('ذخیره پرونده ناموفق بود.');
      } finally {
         setBusy('');
      }
   }

   if (!detail && busy === 'load') return <main className="flex h-full items-center justify-center gap-2 bg-[#101011] text-zinc-500"><Loader2 className="size-4 animate-spin" />در حال بارگذاری…</main>;
   if (!detail) return <main className="flex h-full items-center justify-center bg-[#101011] p-6 text-zinc-300">{error || 'تیکت پیدا نشد.'}</main>;

   return (
      <main dir="rtl" className="h-full min-h-0 overflow-auto bg-[#101011] text-zinc-200">
         <header className="sticky top-0 z-10 border-b border-white/7 bg-[#101011]/95 px-4 py-3 backdrop-blur">
            <div className="mx-auto flex max-w-7xl items-start gap-3">
               <Button aria-label="بازگشت" size="icon" variant="ghost" onClick={() => navigate(-1)}><ArrowRight className="size-4" /></Button>
               <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                     <bdi dir="ltr" className="font-mono text-xs text-zinc-500">{detail.ticket.key}</bdi>
                     <Badge variant="outline">{statusLabels[detail.ticket.status]}</Badge>
                     <label className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
                        اولویت تیکت
                        <select
                           value={detail.ticket.priority}
                           disabled={Boolean(busy)}
                           onChange={(event) => void changePriority(event.target.value as SupportCasePriority)}
                           aria-busy={busy === 'priority'}
                           className="h-8 min-w-20 rounded-md border border-white/10 bg-[#171719] px-2 text-xs text-zinc-200 outline-none focus-visible:border-sky-300 focus-visible:ring-2 focus-visible:ring-sky-300/30 disabled:cursor-wait disabled:opacity-60"
                        >
                           {Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        {busy === 'priority' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                     </label>
                     <bdi dir="ltr" className="text-xs text-zinc-500">{detail.ticket.contact?.phone}</bdi>
                  </div>
                  <h1 className="mt-1.5 text-lg text-zinc-100">{detail.ticket.title}</h1>
               </div>
               <Button type="button" variant="outline" className="shrink-0 border-white/10 text-zinc-200" disabled={Boolean(busy)} onClick={() => void changeStatus()}>
                  {busy === 'status' ? <Loader2 className="size-4 animate-spin" /> : detail.ticket.status === 'CLOSED' ? <RotateCcw className="size-4" /> : <LockKeyhole className="size-4" />}
                  {detail.ticket.status === 'CLOSED' ? 'بازگشایی تیکت' : 'بستن تیکت'}
               </Button>
            </div>
         </header>
         <div className="mx-auto grid max-w-7xl gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <section className="min-w-0 space-y-3">
               {error ? <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/8 p-3 text-red-200"><AlertTriangle className="size-4" />{error}</div> : null}
               {notice ? <p role="status" className="rounded-md border border-lime-300/20 bg-lime-300/5 px-3 py-2 text-sm text-lime-200">{notice}</p> : null}
               {detail.messages.map((message) => (
                  <article key={message.id} className={`rounded-lg border p-4 ${message.authorType === 'SUPPORTER' ? 'border-sky-300/15 bg-sky-300/[0.035]' : 'border-white/8 bg-[#171719]'}`}>
                     <div className="flex items-center gap-2 text-xs text-zinc-500"><MessageSquareText className="size-3.5" />{message.authorType === 'CUSTOMER' ? 'مشتری' : message.author?.name || 'پشتیبان'}<span>{formatJalaliDateTime(message.createdAt)}</span></div>
                     {message.body ? <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-300">{message.body}</p> : null}
                     <TicketMedia metadata={message.metadata} />
                  </article>
               ))}
               {detail.ticket.status !== 'CLOSED' ? (
                  <form className="space-y-3 rounded-lg border border-white/8 bg-[#171719] p-4" onSubmit={sendReply}>
                     <Textarea aria-label="پاسخ به مشتری" className="min-h-24 border-white/10 bg-black/15" placeholder="پاسخ به مشتری…" value={reply} onChange={(event) => setReply(event.target.value)} />
                     {replyImages.length ? (
                        <div className="flex flex-wrap gap-2">
                           {replyImages.map((image, index) => (
                              <div key={`${image.object}-${index}`} className="flex max-w-full items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs">
                                 <span dir="auto" className="max-w-40 truncate">{image.name || 'تصویر'}</span>
                                 <button type="button" aria-label={`حذف ${image.name || 'تصویر'}`} className="flex size-8 items-center justify-center rounded hover:bg-white/10" onClick={() => setReplyImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X className="size-4" /></button>
                              </div>
                           ))}
                        </div>
                     ) : null}
                     <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-white/10 px-3 text-sm text-zinc-300 hover:bg-white/5 focus-within:ring-2 focus-within:ring-sky-300">
                           {busy === 'upload' ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
                           افزودن تصویر
                           <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" disabled={Boolean(busy)} onChange={(event) => { void attachImages(event.target.files); event.target.value = ''; }} />
                        </label>
                        <Button disabled={Boolean(busy) || (!reply.trim() && !replyImages.length)}>{busy === 'reply' ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}ارسال پاسخ</Button>
                     </div>
                  </form>
               ) : <p className="rounded-md border border-white/8 p-3 text-sm text-zinc-500">این تیکت بسته است. برای ارسال پاسخ، آن را بازگشایی کنید.</p>}
            </section>
            <aside>
               <form className="space-y-4 rounded-lg border border-white/8 bg-[#171719] p-4" onSubmit={detail.case ? saveCase : createCase}>
                  <div className="flex items-center gap-2">
                     <BriefcaseBusiness className="size-4 text-lime-300" />
                     <h2 className="text-sm text-zinc-100">{detail.case ? `پرونده ${detail.case.key}` : 'ساخت پرونده'}</h2>
                     {draftReady && !detail.case ? <Badge variant="outline" aria-live="polite">پیش‌نویس هوش مصنوعی</Badge> : null}
                  </div>
                  {!detail.case ? (
                     <Button type="button" variant="secondary" className="w-full" disabled={Boolean(busy)} onClick={() => void generateDraft()}>
                        {busy === 'draft' ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
                        {draftReady ? 'بازنویسی با هوش مصنوعی' : 'پیشنهاد با هوش مصنوعی'}
                     </Button>
                  ) : null}
                  <Field label="عنوان"><Input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
                  <Field label="شرح"><Textarea className={`${inputClass} min-h-32`} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
                  <Field label="اولویت پرونده"><select className={inputClass} value={priority} onChange={(event) => setPriority(event.target.value as SupportCasePriority)}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                  <Field label="اثر"><select className={inputClass} value={impact} onChange={(event) => setImpact(event.target.value as typeof impact)}><option value="">تعیین نشده</option>{Object.entries(levelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                  <Field label="فوریت"><select className={inputClass} value={urgency} onChange={(event) => setUrgency(event.target.value as typeof urgency)}><option value="">تعیین نشده</option>{Object.entries(levelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                  <Button className="w-full" disabled={Boolean(busy) || !title.trim() || !typeKey.trim()} type="submit">
                     {busy === 'case' || busy === 'save' ? <Loader2 className="size-4 animate-spin" /> : detail.case ? <Save className="size-4" /> : <BriefcaseBusiness className="size-4" />}
                     {detail.case ? 'ذخیره تغییرات پرونده' : 'ساخت پرونده'}
                  </Button>
               </form>
            </aside>
         </div>
      </main>
   );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
   return <label className="grid gap-1.5 text-xs text-zinc-500"><span>{label}</span>{children}</label>;
}

function TicketMedia({ metadata }: { metadata?: Record<string, unknown> | null }) {
   const audio = ticketMediaReferences(metadata, 'audio');
   const images = ticketMediaReferences(metadata, 'images');
   if (!audio.length && !images.length) return null;
   return (
      <div className="mt-3 space-y-2">
         {audio.map((file, index) => <SupportVoiceMessage key={`${file.object || file.documentId || file.url}-${index}`} media={file} transcription={ticketVoiceTranscript(metadata, index)} />)}
         {images.length ? (
            <div className="flex flex-wrap gap-2">
               {images.map((file, index) => {
                  const url = ticketMediaUrl(file);
                  const name = file.name || 'تصویر';
                  return url
                     ? <a key={`${file.object || file.documentId || file.url}-${index}`} href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md border border-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"><img src={url} alt={name} className="h-28 w-36 object-cover" loading="lazy" /></a>
                     : <Badge key={`${file.object || file.documentId}-${index}`} variant="secondary">{name}</Badge>;
               })}
            </div>
         ) : null}
      </div>
   );
}

const inputClass = 'border-white/10 bg-black/15 text-zinc-200';
