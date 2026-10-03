import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Pause, Play, Volume2 } from 'lucide-react';
import type { SupportTicketMedia } from '@/lib/support-ticket-media';
import { formatAudioTime, ticketMediaUrl } from '@/lib/support-ticket-media';

let activeAudio: HTMLAudioElement | null = null;
const waveform = [8, 13, 19, 11, 22, 29, 17, 12, 24, 32, 20, 14, 27, 34, 23, 11, 19, 30, 25, 15, 33, 21, 12, 26, 18, 10, 16, 8];

export function SupportVoicePlayer({ media, tone = 'dark' }: { media: SupportTicketMedia; tone?: 'dark' | 'light' }) {
   const audioRef = useRef<HTMLAudioElement>(null);
   const [playing, setPlaying] = useState(false);
   const [loading, setLoading] = useState(false);
   const [currentTime, setCurrentTime] = useState(0);
   const [duration, setDuration] = useState(
      typeof media.durationSeconds === 'number' && Number.isFinite(media.durationSeconds) ? media.durationSeconds : 0
   );
   const [error, setError] = useState(false);
   const source = ticketMediaUrl(media);
   const name = typeof media.name === 'string' && media.name.trim() ? media.name.trim() : 'پیام صوتی';
   const dark = tone === 'dark';
   const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

   useEffect(() => {
      const audio = audioRef.current;
      return () => {
         if (activeAudio === audio) activeAudio = null;
         audio?.pause();
      };
   }, []);

   async function togglePlayback() {
      const audio = audioRef.current;
      if (!audio || !source) return;
      if (!audio.paused) {
         audio.pause();
         return;
      }
      if (audio.ended) audio.currentTime = 0;
      setError(false);
      setLoading(true);
      try {
         await audio.play();
      } catch {
         setError(true);
         setLoading(false);
      }
   }

   function seekTo(value: number) {
      const audio = audioRef.current;
      if (!audio || !Number.isFinite(duration) || duration <= 0) return;
      audio.currentTime = value;
      setCurrentTime(value);
   }

   return (
      <div dir="rtl" className={`mt-3 w-full max-w-[440px] rounded-md border px-3 py-3 ${
         dark ? 'border-white/10 bg-[#10171b] text-zinc-100' : 'border-border bg-muted/50 text-foreground'
      }`}>
         {source ? (
            <audio
               ref={audioRef}
               src={source}
               preload="metadata"
               onDurationChange={(event) => {
                  const seconds = event.currentTarget.duration;
                  if (Number.isFinite(seconds) && seconds > 0) setDuration(seconds);
               }}
               onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
               onPlaying={(event) => {
                  if (activeAudio && activeAudio !== event.currentTarget) activeAudio.pause();
                  activeAudio = event.currentTarget;
                  setPlaying(true);
                  setLoading(false);
               }}
               onWaiting={() => setLoading(true)}
               onPause={() => { setPlaying(false); setLoading(false); }}
               onEnded={() => { setPlaying(false); setLoading(false); }}
               onError={() => {
                  setPlaying(false);
                  setLoading(false);
                  setError(true);
               }}
            />
         ) : null}
         <div className="flex min-w-0 items-center gap-3">
            <button
               type="button"
               aria-label={playing ? 'مکث پیام صوتی' : 'پخش پیام صوتی'}
               aria-pressed={playing}
               title={playing ? 'مکث' : 'پخش'}
               disabled={!source}
               onClick={() => void togglePlayback()}
               className={`flex size-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 ${
                  dark ? 'bg-sky-300 text-[#10171b] hover:bg-sky-200 focus-visible:outline-sky-300' : 'bg-primary text-primary-foreground hover:bg-primary/85 focus-visible:outline-primary'
               }`}
            >
               {loading && !playing ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : playing
                  ? <Pause className="size-5 fill-current" aria-hidden="true" />
                  : <Play className="size-5 fill-current" aria-hidden="true" />}
            </button>
            <div className="min-w-0 flex-1">
               <div className="flex min-w-0 items-center gap-2 text-xs">
                  <Volume2 className={`size-4 shrink-0 ${dark ? 'text-sky-300' : 'text-primary'}`} aria-hidden="true" />
                  <span className="shrink-0 font-semibold">پیام صوتی</span>
                  <span className={`min-w-0 truncate ${dark ? 'text-zinc-400' : 'text-muted-foreground'}`} title={name} dir="auto">{name}</span>
               </div>
               <div className="mt-1 flex min-w-0 items-center gap-2" dir="ltr">
                  <div className={`relative flex h-9 min-w-0 flex-1 items-center gap-[2px] rounded-sm focus-within:ring-2 focus-within:ring-offset-2 ${
                     dark ? 'focus-within:ring-sky-300 focus-within:ring-offset-[#10171b]' : 'focus-within:ring-primary focus-within:ring-offset-background'
                  }`}>
                     {waveform.map((height, index) => (
                        <span
                           key={index}
                           aria-hidden="true"
                           className={`min-w-0 flex-1 rounded-full transition-colors ${index / waveform.length * 100 < progress
                              ? dark ? 'bg-sky-300' : 'bg-primary'
                              : dark ? 'bg-zinc-600' : 'bg-muted-foreground/45'}`}
                           style={{ height: `${height}px`, maxHeight: '100%' }}
                        />
                     ))}
                  <input
                     type="range"
                     min={0}
                     max={duration > 0 ? duration : 1}
                     step={0.1}
                     value={Math.min(currentTime, duration > 0 ? duration : 1)}
                     disabled={!source || duration <= 0}
                     aria-label="موقعیت پخش پیام صوتی"
                     aria-valuetext={`${formatAudioTime(currentTime)} از ${duration > 0 ? formatAudioTime(duration) : 'زمان نامشخص'}`}
                     onChange={(event) => seekTo(Number(event.target.value))}
                     className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 focus-visible:outline-none disabled:cursor-default"
                  />
                  </div>
               </div>
               <div dir="ltr" className={`flex justify-between font-mono text-[11px] tabular-nums ${dark ? 'text-zinc-400' : 'text-muted-foreground'}`}>
                  <span>{formatAudioTime(currentTime)}</span>
                  <span>{duration > 0 ? formatAudioTime(duration) : '--:--'}</span>
               </div>
            </div>
            {source ? (
               <a
                  href={source}
                  download={name}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`دریافت فایل صوتی ${name}`}
                  title="دریافت فایل صوتی"
                  className={`flex size-11 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                     dark ? 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
               >
                  <Download className="size-4" aria-hidden="true" />
               </a>
            ) : null}
         </div>
         {error || !source ? (
            <p role="alert" className={`mt-2 text-xs ${dark ? 'text-rose-300' : 'text-destructive'}`}>
               {source ? 'پخش صدا ممکن نشد. فایل را دریافت کنید یا قالب آن را در مرورگر دیگری باز کنید.' : 'نشانی فایل صوتی در دسترس نیست.'}
            </p>
         ) : null}
      </div>
   );
}
