import { Bot } from 'lucide-react';
import { SupportVoicePlayer } from './support-voice-player';
import type { SupportTicketMedia, SupportVoiceTranscript } from '@/lib/support-ticket-media';

export function SupportVoiceMessage({
   media,
   transcription,
   tone = 'dark',
}: {
   media: SupportTicketMedia;
   transcription: SupportVoiceTranscript;
   tone?: 'dark' | 'light';
}) {
   const dark = tone === 'dark';
   return (
      <div dir="rtl" className="w-full max-w-[440px]">
         <SupportVoicePlayer media={media} tone={tone} />
         <section
            aria-label="متن پیام صوتی با هوش مصنوعی"
            className={`mt-2 min-w-0 border-s-2 ps-3 py-1 ${dark ? 'border-amber-200/30' : 'border-amber-600/40'}`}
         >
            <div className="flex flex-wrap items-center gap-2 text-xs">
               <Bot className={`size-4 shrink-0 ${dark ? 'text-amber-200' : 'text-amber-700'}`} aria-hidden="true" />
               <h3 className={`font-medium ${dark ? 'text-zinc-200' : 'text-foreground'}`}>متن پیام صوتی</h3>
               <span className={dark ? 'text-amber-200/80' : 'text-amber-700'}>هوش مصنوعی</span>
            </div>
            {transcription.status === 'COMPLETED' && transcription.transcript ? (
               <p dir="auto" className={`mt-2 whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere] ${dark ? 'text-zinc-300' : 'text-foreground'}`}>
                  {transcription.transcript}
               </p>
            ) : (
               <p className={`mt-2 text-xs leading-6 ${dark ? 'text-zinc-400' : 'text-muted-foreground'}`}>
                  {transcription.status === 'UNAVAILABLE'
                     ? 'تبدیل این پیام صوتی به متن ناموفق بود.'
                     : 'متن این پیام صوتی هنوز آماده نیست.'}
               </p>
            )}
         </section>
      </div>
   );
}
