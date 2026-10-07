import * as React from 'react';
import { AlertCircle, Bot, CheckCircle2, Loader2, Mic, MicOff, Send, Sparkles, User, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { taskaraRequest } from '@/lib/taskara-client';
import { cn } from '@/lib/utils';
import { useAuthSession } from '@/store/auth-store';

type AssistantMessageRole = 'assistant' | 'user';
type AssistantMessageStatus = 'completed' | 'blocked' | 'needs_clarification' | 'unsupported';

interface AssistantMessage {
   id: string;
   role: AssistantMessageRole;
   content: string;
   status?: AssistantMessageStatus;
   audioUrl?: string;
   audioMimeType?: string;
   transcript?: string;
}

interface AssistantHistoryItem {
   role: AssistantMessageRole;
   content: string;
}

interface AssistantAudioPayload {
   data: string;
   mimeType: string;
   language?: string;
}

interface AssistantApiResponse {
   ok: boolean;
   status: AssistantMessageStatus;
   message: string;
   transcribedText?: string | null;
   task?: {
      key?: string;
      title?: string;
   };
}

interface AiSettingsSummary {
   model: string;
}

const initialMessages: AssistantMessage[] = [
   {
      id: 'assistant-welcome',
      role: 'assistant',
      content: 'آماده دریافت و انجام کار هستم. درخواستت را بنویس یا با میکروفون بگو تا شروع کنم.',
   },
];

const fallbackAiModel = 'x-ai/grok-4.1-fast';

export function AiAssistantDock() {
   const { session } = useAuthSession();
   const [open, setOpen] = React.useState(false);
   const [messages, setMessages] = React.useState<AssistantMessage[]>(initialMessages);
   const [draft, setDraft] = React.useState('');
   const [submitting, setSubmitting] = React.useState(false);
   const [recording, setRecording] = React.useState(false);
   const [workspaceAiModel, setWorkspaceAiModel] = React.useState<string | null>(null);
   const recorderRef = React.useRef<MediaRecorder | null>(null);
   const chunksRef = React.useRef<BlobPart[]>([]);
   const messagesEndRef = React.useRef<HTMLDivElement | null>(null);
   const audioObjectUrlsRef = React.useRef<string[]>([]);
   const discardRecordingRef = React.useRef(false);
   const assistantModel = session?.user.aiModel?.trim() || workspaceAiModel || fallbackAiModel;
   const voiceSupported =
      typeof window !== 'undefined' &&
      typeof MediaRecorder !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia;

   React.useEffect(() => {
      if (!open) return;
      messagesEndRef.current?.scrollIntoView({ block: 'end' });
   }, [messages, open]);

   React.useEffect(() => {
      return () => {
         discardRecordingRef.current = true;
         recorderRef.current?.stop();
      };
   }, []);

   React.useEffect(() => {
      return () => {
         audioObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
         audioObjectUrlsRef.current = [];
      };
   }, []);

   React.useEffect(() => {
      if (!open || session?.user.aiModel?.trim()) return;

      let cancelled = false;

      void taskaraRequest<AiSettingsSummary>('/ai/settings')
         .then((settings) => {
            if (!cancelled) setWorkspaceAiModel(settings.model || fallbackAiModel);
         })
         .catch(() => {
            if (!cancelled) setWorkspaceAiModel(fallbackAiModel);
         });

      return () => {
         cancelled = true;
      };
   }, [open, session?.user.aiModel]);

   async function submitTextMessage(event?: React.FormEvent<HTMLFormElement>) {
      event?.preventDefault();
      const text = draft.trim();
      if (!text || submitting) return;

      const userMessage: AssistantMessage = {
         id: crypto.randomUUID(),
         role: 'user',
         content: text,
      };
      const history = buildHistory(messages);

      setMessages((current) => [...current, userMessage]);
      setDraft('');
      await sendAssistantRequest({ message: text, history });
   }

   async function submitAudioMessage(
      input: {
         audio: AssistantAudioPayload;
         audioUrl: string;
         audioMimeType: string;
      }
   ) {
      if (submitting) return;
      const userMessage: AssistantMessage = {
         id: crypto.randomUUID(),
         role: 'user',
         content: 'پیام صوتی',
         audioUrl: input.audioUrl,
         audioMimeType: input.audioMimeType,
      };
      const history = buildHistory(messages);

      setMessages((current) => [...current, userMessage]);
      await sendAssistantRequest({
         message: '',
         history,
         audio: input.audio,
         pendingAudioMessageId: userMessage.id,
      });
   }

   async function sendAssistantRequest(input: {
      message: string;
      history: AssistantHistoryItem[];
      audio?: AssistantAudioPayload;
      pendingAudioMessageId?: string;
   }) {
      setSubmitting(true);
      try {
         const response = await taskaraRequest<AssistantApiResponse>('/ai/assistant/message', {
            method: 'POST',
            body: JSON.stringify({
               message: input.message,
               history: input.history,
               audio: input.audio,
               clientNow: new Date().toISOString(),
               timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
         });

         const assistantMessage = response.transcribedText?.trim()
            ? `${response.message}\n\nمتن تشخیص‌داده‌شده:\n${response.transcribedText.trim()}`
            : response.message;

         setMessages((current) => {
            const nextMessages = input.pendingAudioMessageId
               ? current.map((message) => {
                    if (message.id !== input.pendingAudioMessageId) return message;
                    const transcript = response.transcribedText?.trim();
                    if (!transcript) return message;
                    return { ...message, transcript, content: transcript };
                 })
               : current;
            return [
               ...nextMessages,
               {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: assistantMessage,
                  status: response.status,
               },
            ];
         });
         if (response.ok) {
            toast.success(response.task?.key ? `${response.task.key} انجام شد.` : 'درخواست انجام شد.');
         }
      } catch (error) {
         const message = error instanceof Error ? error.message : 'ارتباط با AI ناموفق بود.';
         setMessages((current) => [
            ...current,
            {
               id: crypto.randomUUID(),
               role: 'assistant',
               content: message,
               status: 'blocked',
            },
         ]);
         toast.error(message);
      } finally {
         setSubmitting(false);
      }
   }

   async function toggleRecording() {
      if (recording) {
         discardRecordingRef.current = false;
         recorderRef.current?.stop();
         return;
      }

      if (!voiceSupported) {
         toast.error('مرورگر شما ضبط مستقیم صدا را پشتیبانی نمی‌کند.');
         return;
      }

      try {
         const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
         const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : '';
         const recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
         chunksRef.current = [];

         recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data.size > 0) chunksRef.current.push(event.data);
         };
         recorder.onerror = () => {
            setRecording(false);
            toast.error('ضبط صدا ناموفق بود.');
         };
         recorder.onstop = () => {
            setRecording(false);
            stream.getTracks().forEach((track) => track.stop());
            const shouldDiscard = discardRecordingRef.current;
            discardRecordingRef.current = false;
            if (shouldDiscard) {
               chunksRef.current = [];
               return;
            }

            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
            chunksRef.current = [];
            if (!blob.size) {
               toast.error('فایل صوتی خالی است. دوباره تلاش کن.');
               return;
            }
            void audioBlobToBase64(blob)
               .then((data) => {
                  const audioUrl = URL.createObjectURL(blob);
                  audioObjectUrlsRef.current.push(audioUrl);
                  return submitAudioMessage({
                     audio: {
                        data,
                        mimeType: blob.type || recorder.mimeType || 'audio/webm',
                        language: 'fa',
                     },
                     audioUrl,
                     audioMimeType: blob.type || recorder.mimeType || 'audio/webm',
                  });
               })
               .catch(() => toast.error('پردازش پیام صوتی ناموفق بود.'));
         };

         recorderRef.current = recorder;
         discardRecordingRef.current = false;
         recorder.start();
         setRecording(true);
      } catch {
         setRecording(false);
         toast.error('دسترسی میکروفون مجاز نیست یا ضبط شروع نشد.');
      }
   }

   function cancelRecording() {
      if (!recording) return;
      discardRecordingRef.current = true;
      recorderRef.current?.stop();
      toast.message('ضبط صوت لغو شد.');
   }

   return (
      <div className="fixed bottom-4 end-4 z-40 flex flex-col items-end gap-3 text-right" dir="rtl">
         {open ? (
            <section className="flex h-[min(620px,calc(100dvh-6rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#18181b] shadow-2xl">
               <header className="flex items-center justify-between border-b border-white/8 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                     <span className="inline-flex size-8 items-center justify-center rounded-md bg-indigo-400/10 text-indigo-700 dark:text-indigo-200">
                        <Sparkles className="size-4" />
                     </span>
                     <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-zinc-100">دستیار AI</div>
                        <div className="truncate text-xs text-zinc-500">
                           مدل: <span dir="ltr">{assistantModel}</span>
                        </div>
                     </div>
                  </div>
                  <Button
                     aria-label="بستن دستیار AI"
                     className="size-8 rounded-full text-zinc-500 hover:bg-white/8 hover:text-zinc-100"
                     size="icon"
                     type="button"
                     variant="ghost"
                     onClick={() => setOpen(false)}
                  >
                     <X className="size-4" />
                  </Button>
               </header>

               <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
                  {messages.map((message) => (
                     <AssistantBubble key={message.id} message={message} />
                  ))}
                  {submitting ? (
                     <div className="flex items-center gap-2 text-xs text-zinc-500">
                        <Loader2 className="size-3.5 animate-spin" />
                        در حال بررسی و اجرا
                     </div>
                  ) : null}
                  <div ref={messagesEndRef} />
               </div>

               <form className="border-t border-white/8 p-2" onSubmit={(event) => void submitTextMessage(event)}>
                  <Textarea
                     className="max-h-32 min-h-20 resize-none border-white/10 bg-white/[0.03] text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-indigo-300/30"
                     disabled={submitting}
                     placeholder="مثلا: در پروژه ۲ یک تسک با اولویت متوسط به کاربر ۳ با سررسید دو روز دیگر بساز"
                     value={draft}
                     onChange={(event) => setDraft(event.target.value)}
                     onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                           void submitTextMessage();
                        }
                     }}
                  />
                  <div className="mt-2 flex items-center justify-between gap-2">
                     <div className="flex items-center gap-2">
                        <Button
                           aria-label={recording ? 'توقف ضبط صدا و ارسال' : 'شروع ضبط پیام صوتی'}
                           className={cn(
                              'size-8 rounded-full border border-white/10 bg-transparent text-zinc-400 hover:bg-white/8 hover:text-zinc-100',
                              recording && 'border-rose-400/30 bg-rose-500/10 text-rose-700 dark:text-rose-200'
                           )}
                           disabled={submitting || !voiceSupported}
                           size="icon"
                           title={voiceSupported ? (recording ? 'توقف و ارسال صوت' : 'ضبط و ارسال مستقیم صوت') : 'ضبط صوت پشتیبانی نمی‌شود'}
                           type="button"
                           variant="ghost"
                           onClick={() => void toggleRecording()}
                        >
                           {recording ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                        </Button>
                        {recording ? (
                           <Button
                              className="h-8 rounded-full border border-white/10 bg-transparent px-3 text-xs text-zinc-300 hover:bg-white/8 hover:text-zinc-100"
                              disabled={submitting}
                              type="button"
                              variant="ghost"
                              onClick={cancelRecording}
                           >
                              لغو
                           </Button>
                        ) : null}
                     </div>
                     <Button
                        className="h-8 gap-2 rounded-full bg-zinc-100 px-3 text-zinc-950 hover:bg-white"
                        disabled={submitting || !draft.trim()}
                        type="submit"
                     >
                        {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                        ارسال
                     </Button>
                  </div>
               </form>
            </section>
         ) : null}

         <Button
            aria-label="باز کردن دستیار AI"
            className="size-12 rounded-full border border-indigo-300/20 bg-[#1c1c20] text-indigo-700 dark:text-indigo-200 shadow-2xl shadow-black/40 hover:bg-accent hover:text-foreground"
            size="icon"
            type="button"
            onClick={() => setOpen((current) => !current)}
         >
            <Sparkles className="size-5" />
         </Button>
      </div>
   );
}

function AssistantBubble({ message }: { message: AssistantMessage }) {
   const isUser = message.role === 'user';
   const Icon = isUser
      ? User
      : message.status === 'completed'
        ? CheckCircle2
        : message.status === 'blocked' || message.status === 'unsupported'
          ? AlertCircle
          : Bot;

   return (
      <div className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
         <div
            className={cn(
               'flex max-w-[86%] gap-2 rounded-lg px-3 py-2 text-sm leading-6',
               isUser
                  ? 'bg-indigo-400/15 text-indigo-700 dark:text-indigo-50'
                  : 'border border-white/8 bg-white/[0.03] text-zinc-200'
            )}
         >
            <Icon
               className={cn(
                  'mt-1 size-3.5 shrink-0',
                  message.status === 'completed'
                     ? 'text-emerald-700 dark:text-emerald-300'
                     : message.status === 'blocked' || message.status === 'unsupported'
                       ? 'text-amber-800 dark:text-amber-300'
                       : 'text-zinc-500'
               )}
            />
            <div className="min-w-0 space-y-1.5">
               <p className="whitespace-pre-wrap break-words">{message.content}</p>
               {message.audioUrl ? (
                  <audio className="h-8 w-full max-w-[260px]" controls preload="metadata">
                     <source src={message.audioUrl} type={message.audioMimeType || 'audio/webm'} />
                     مرورگر شما از پخش صوت پشتیبانی نمی‌کند.
                  </audio>
               ) : null}
            </div>
         </div>
      </div>
   );
}

function buildHistory(messages: AssistantMessage[]): AssistantHistoryItem[] {
   return messages
      .map((message) => ({
         role: message.role,
         content: (message.transcript || message.content).trim(),
      }))
      .filter((message) => message.content.length > 0)
      .slice(-20);
}

function audioBlobToBase64(blob: Blob): Promise<string> {
   return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read audio blob'));
      reader.onload = () => {
         if (typeof reader.result !== 'string') {
            reject(new Error('Invalid FileReader result'));
            return;
         }
         const data = reader.result.split(',')[1];
         if (!data) {
            reject(new Error('Audio base64 payload is empty'));
            return;
         }
         resolve(data);
      };
      reader.readAsDataURL(blob);
   });
}
