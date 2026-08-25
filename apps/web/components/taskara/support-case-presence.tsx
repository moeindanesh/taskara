import { useEffect, useState } from 'react';
import { AlertTriangle, Eye, PencilLine, RefreshCw, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supportCollaborationClient } from '@/lib/support-collaboration-client';
import type { SupportPresenceCollision } from '@/lib/support-collaboration-types';
import { TaskaraClientError } from '@/lib/taskara-client';

const heartbeatMilliseconds = 15_000;

export function SupportCasePresenceNotice({
   caseKey,
   caseVersion,
   intent,
   onRefreshRequested,
}: {
   caseKey: string;
   caseVersion: number;
   intent: 'VIEWING' | 'EDITING';
   onRefreshRequested: () => void;
}) {
   const [clientId] = useState(createSupportPresenceClientId);
   const [collision, setCollision] = useState<SupportPresenceCollision>();
   const [versionConflict, setVersionConflict] = useState(false);

   useEffect(() => {
      let cancelled = false;
      let conflictReported = false;

      async function heartbeat() {
         try {
            const result = await supportCollaborationClient.touchPresence(caseKey, {
               clientId,
               intent,
               baseVersion: caseVersion,
            });
            if (cancelled) return;
            setCollision(result.collision);
            setVersionConflict(false);
         } catch (caught) {
            if (cancelled || !(caught instanceof TaskaraClientError) || caught.status !== 409) return;
            setVersionConflict(true);
            if (!conflictReported) {
               conflictReported = true;
               onRefreshRequested();
            }
         }
      }

      void heartbeat();
      const interval = window.setInterval(() => void heartbeat(), heartbeatMilliseconds);
      return () => {
         cancelled = true;
         window.clearInterval(interval);
         void supportCollaborationClient.releasePresence(caseKey, caseVersion, clientId).catch(() => undefined);
      };
   }, [caseKey, caseVersion, clientId, intent, onRefreshRequested]);

   const readers = collision?.readers || [];
   if (!readers.length && !versionConflict) return null;

   return (
      <section aria-live="polite" className="rounded-xl border border-amber-400/20 bg-amber-400/[0.055] p-3 text-amber-100" data-testid="support-case-presence-warning">
         <div className="flex items-start gap-3">
            {versionConflict || collision?.hasVersionSkew ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" /> : <Users className="mt-0.5 size-4 shrink-0 text-amber-300" />}
            <div className="min-w-0 flex-1">
               <h2 className="text-sm font-medium">{versionConflict || collision?.hasVersionSkew ? 'نسخه پرونده تغییر کرده است' : collision?.hasConcurrentEditor ? 'هم‌زمان روی این پرونده کار می‌شود' : 'افراد دیگری این پرونده را می‌بینند'}</h2>
               {readers.length ? <ul className="mt-1.5 space-y-1 text-xs leading-6 text-amber-100/70">{readers.map((reader, index) => <li key={`${reader.user.id}:${index}`} className="flex items-center gap-1.5">{reader.intent === 'EDITING' ? <PencilLine className="size-3" /> : <Eye className="size-3" />}<span>{reader.user.name} {reader.intent === 'EDITING' ? 'در حال ویرایش است' : 'در حال مشاهده است'}{reader.staleVersion ? ' (با نسخه قدیمی)' : ''}</span></li>)}</ul> : null}
               <p className="mt-1 text-[11px] leading-5 text-amber-100/55">پیش از ثبت تغییر، آخرین نسخه را بررسی کنید. این حضور کوتاه‌عمر است و در مرورگر ذخیره نمی‌شود.</p>
            </div>
            {versionConflict || collision?.hasVersionSkew ? <Button className="shrink-0 border border-amber-300/15 bg-amber-300/5 text-amber-100 hover:bg-amber-300/10" size="sm" type="button" variant="secondary" onClick={onRefreshRequested}><RefreshCw className="size-3.5" /> تازه‌سازی</Button> : null}
         </div>
      </section>
   );
}

export function createSupportPresenceClientId(): string {
   const random = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
   return `support-presence-${random}`;
}

export function supportPresenceIntentForTarget(target: EventTarget | null): 'EDITING' | null {
   if (!(target instanceof HTMLElement)) return null;
   return target.closest('input, textarea, select, [contenteditable="true"]') ? 'EDITING' : null;
}
