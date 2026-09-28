import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ImagePlus, Loader2, MessageCircle, Mic, RefreshCw, Send, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SupportVoiceMessage } from '@/components/taskara/support-voice-message';
import { ticketMediaReferences, ticketMediaUrl, ticketVoiceTranscript } from '@/lib/support-ticket-media';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  publicSupportClient,
  type PublicSupportCase,
  type PublicSupportDetail,
  type PublicSupportMedia,
  type PublicSupportPayload
} from '@/lib/public-support-client';

export function PublicSupportPortal() {
  const [cases, setCases] = useState<PublicSupportCase[]>([]);
  const [selected, setSelected] = useState<PublicSupportDetail>();
  const [text, setText] = useState('');
  const [phone, setPhone] = useState('');
  const [newTicket, setNewTicket] = useState(false);
  const [attachments, setAttachments] = useState<PublicSupportMedia[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadCases = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (!phone.trim()) {
        setCases([]);
        return;
      }
      setCases((await publicSupportClient.list({ phone: phone.trim() })).items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'بارگذاری درخواست‌ها ناموفق بود.');
    } finally {
      setLoading(false);
    }
  }, [phone]);

  useEffect(() => { void loadCases(); }, [loadCases]);

  async function openCase(item: PublicSupportCase) {
    setBusy(true);
    setError('');
    try {
      setSelected(await publicSupportClient.detail(item.key, phone.trim()));
      setNewTicket(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'بارگذاری درخواست ناموفق بود.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() && !attachments.length) return;
    setBusy(true);
    setError('');
    const payload: PublicSupportPayload = {
      text: text.trim() || undefined,
      phone: phone.trim(),
      images: attachments.filter((file) => file.mimeType?.startsWith('image/')),
      audio: attachments.filter((file) => file.mimeType?.startsWith('audio/')),
      pageContext: {
        url: window.location.href,
        title: document.title,
        route: window.location.pathname,
        referrer: document.referrer || undefined,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      clientRequestId: crypto.randomUUID()
    };
    try {
      const next = newTicket || !selected
        ? await publicSupportClient.create(payload)
        : await publicSupportClient.message(selected.case.key, payload);
      setSelected(next);
      setText('');
      setAttachments([]);
      setNewTicket(false);
      await loadCases();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ثبت درخواست ناموفق بود.');
    } finally {
      setBusy(false);
    }
  }

  async function attach(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    setBusy(true);
    setError('');
    try {
      const uploaded = await Promise.all(files.slice(0, 4).map((file) => publicSupportClient.upload(file)));
      setAttachments((current) => [...current, ...uploaded]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'آپلود فایل ناموفق بود.');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  const activeCase = selected?.case;
  return (
    <main dir="rtl" className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="border-e border-border pe-4">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-lg font-semibold">پشتیبانی</h1>
            <Button aria-label="تازه‌سازی" size="icon" variant="ghost" onClick={() => void loadCases()}><RefreshCw className={loading ? 'animate-spin' : ''} /></Button>
          </div>
          <Input className="mt-4" dir="ltr" placeholder="+989399569034 یا 09399569034" value={phone} onChange={(event) => setPhone(event.target.value)} />
          <Button className="mt-3 w-full" disabled={!phone.trim()} onClick={() => { setSelected(undefined); setNewTicket(true); }}>درخواست جدید</Button>
          <div className="mt-5 space-y-2">
            {cases.map((item) => (
              <button key={item.id} className="w-full rounded-lg border border-border p-3 text-start hover:bg-accent" type="button" onClick={() => void openCase(item)}>
                <div className="flex items-center justify-between gap-2"><bdi dir="ltr" className="font-mono text-xs text-muted-foreground">{item.key}</bdi><Badge variant="outline">{item.status}</Badge></div>
                <p className="mt-2 line-clamp-2 text-sm">{item.title}</p>
              </button>
            ))}
            {!loading && !cases.length ? <p className="py-8 text-sm text-muted-foreground">هنوز درخواستی ثبت نشده است.</p> : null}
          </div>
        </aside>
        <section className="min-w-0">
          {error ? <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"><AlertTriangle className="size-4" />{error}</div> : null}
          {activeCase ? (
            <div className="mb-5 flex items-start justify-between gap-3 border-b border-border pb-4">
              <div><div className="flex items-center gap-2"><bdi dir="ltr" className="font-mono text-xs text-muted-foreground">{activeCase.key}</bdi><Badge variant="outline">{activeCase.status}</Badge></div><h2 className="mt-2 text-xl font-semibold">{activeCase.title}</h2></div>
              <Button size="icon" variant="ghost" aria-label="تازه‌سازی درخواست" onClick={() => void openCase(activeCase)}><RefreshCw className={busy ? 'animate-spin' : ''} /></Button>
            </div>
          ) : <h2 className="mb-5 text-xl font-semibold">{newTicket ? 'درخواست جدید' : 'یک درخواست را انتخاب کنید'}</h2>}
          {activeCase ? <div className="space-y-3">{selected?.timeline.map((entry) => <article key={entry.id} className="rounded-lg border border-border p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><MessageCircle className="size-3.5" />{new Date(entry.occurredAt).toLocaleString('fa-IR')}</div>{entry.content?.body ? <p className="mt-2 whitespace-pre-wrap leading-7">{entry.content.body}</p> : null}<MediaPreview metadata={entry.metadata} /></article>)}</div> : null}
          {(newTicket || activeCase) ? (
            <form className="mt-5 space-y-3" onSubmit={submit}>
              <Textarea aria-label="متن درخواست" className="min-h-32" placeholder="چه چیزی نیاز به بررسی دارد؟" value={text} onChange={(event) => setText(event.target.value)} />
              {attachments.length ? <div className="flex flex-wrap gap-2">{attachments.map((file) => <Badge key={file.object} variant="secondary">{file.name || file.object}</Badge>)}</div> : null}
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"><Upload className="size-4" />پیوست<input className="hidden" type="file" accept="image/*,audio/*" multiple onChange={(event) => void attach(event)} /></label>
                <span className="text-xs text-muted-foreground"><ImagePlus className="me-1 inline size-3.5" />تصویر <Mic className="ms-2 me-1 inline size-3.5" />صدا</span>
                <Button className="ms-auto" disabled={busy || (!text.trim() && !attachments.length)} type="submit">{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} ارسال</Button>
              </div>
            </form>
          ) : <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">برای شروع، درخواست جدید بسازید یا یکی از درخواست‌ها را باز کنید.</div>}
        </section>
      </div>
    </main>
  );
}

function MediaPreview({ metadata }: { metadata?: Record<string, unknown> | null }) {
  const audio = ticketMediaReferences(metadata, 'audio');
  const images = ticketMediaReferences(metadata, 'images');
  if (!audio.length && !images.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {audio.map((file, index) => <SupportVoiceMessage key={`${file.object || file.documentId || file.url}-${index}`} media={file} transcription={ticketVoiceTranscript(metadata, index)} tone="light" />)}
      <div className="flex flex-wrap gap-2">
        {images.map((file, index) => {
          const url = ticketMediaUrl(file);
          const name = file.name || 'تصویر';
          return url
            ? <a key={`${file.object || file.documentId || file.url}-${index}`} href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><img src={url} alt={name} className="h-28 w-36 object-cover" loading="lazy" /></a>
            : <span key={`${file.object || file.documentId}-${index}`} className="text-xs text-muted-foreground">{name}</span>;
        })}
      </div>
    </div>
  );
}
