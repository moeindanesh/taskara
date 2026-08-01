/**
 * PROTOTYPE — throwaway. Issue #26: what does a human see to know what is takeable?
 *
 * Three variants of the same information on the existing issue page, switchable with `?variant=`.
 * Not production code: no tests, no error handling, casts where the real type is too narrow.
 *
 *   A — «وابستگی‌ها» section in the body, below the description.
 *   B — a takeability row in the properties rail, beside status and assignee.
 *   C — a banner across the top of the body.
 *
 * A NOTE ON THE DATA, because it decided the shape of all three. The API already returns the whole
 * blocking Task on the detail route (`blockingDependencies: { include: { blockedByTask: true } }`),
 * so `status` is on the wire today — but `TaskaraTask` declares only `{ id, key, title }`, so no
 * component could read it without widening the type first. That is the one-line change standing
 * between this prototype and a real implementation.
 *
 * The edge ARRAY is deliberately unfiltered (issue #24: "the count is the predicate, the list is
 * the record"), so a finished blocker is still in it. Every variant therefore derives openness from
 * `status` rather than from membership, and shows closed blockers as history rather than hiding
 * them.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CircleCheck, CircleDot, Lock, Unlock } from 'lucide-react';
import type { TaskaraTask } from '@/lib/taskara-types';

const CLOSED = new Set(['DONE', 'CANCELED']);

interface EdgeTask {
   id: string;
   key: string;
   title: string;
   status?: string;
}

export interface Takeability {
   openBlockers: EdgeTask[];
   closedBlockers: EdgeTask[];
   blocks: EdgeTask[];
   takeable: boolean;
}

export function readTakeability(task: TaskaraTask): Takeability {
   // The cast is the prototype's whole point of friction — see the note above.
   const blockers = (task.blockingDependencies ?? [])
      .map((edge) => edge.blockedByTask as EdgeTask | undefined)
      .filter((value): value is EdgeTask => Boolean(value));
   const blocks = (task.blockedTasks ?? [])
      .map((edge) => edge.task as EdgeTask | undefined)
      .filter((value): value is EdgeTask => Boolean(value));

   const openBlockers = blockers.filter((blocker) => !CLOSED.has(blocker.status ?? ''));
   const closedBlockers = blockers.filter((blocker) => CLOSED.has(blocker.status ?? ''));
   return { openBlockers, closedBlockers, blocks, takeable: openBlockers.length === 0 };
}

const fa = {
   blockedBy: 'مسدود شده توسط',
   blocks: 'مسدود می‌کند',
   takeable: 'آماده برداشت',
   notTakeable: 'آمادهٔ برداشت نیست',
   openBlockers: (count: number) => `${count} مسدودکنندهٔ باز`,
   noBlockers: 'مسدودکننده‌ای ندارد',
   resolved: 'رفع شد',
   dependencies: 'وابستگی‌ها',
   takeState: 'وضعیت برداشت'
};

function TaskLine({ task, dim = false }: { task: EdgeTask; dim?: boolean }) {
   const closed = CLOSED.has(task.status ?? '');
   return (
      <div className="flex items-center gap-2 py-1">
         {closed ? (
            <CircleCheck className="size-3.5 shrink-0 text-emerald-500/80" />
         ) : (
            <CircleDot className="size-3.5 shrink-0 text-amber-400/90" />
         )}
         <span className={`ltr shrink-0 text-xs font-medium ${dim || closed ? 'text-zinc-600' : 'text-zinc-400'}`}>
            {task.key}
         </span>
         <span className={`truncate text-xs ${dim || closed ? 'text-zinc-600 line-through' : 'text-zinc-300'}`}>
            {task.title}
         </span>
      </div>
   );
}

/** A — a section in the body, the way subtasks and attachments already read. */
export function VariantA({ state }: { state: Takeability }) {
   const blockers = [...state.openBlockers, ...state.closedBlockers];
   if (!blockers.length && !state.blocks.length) return null;

   return (
      <section className="mt-6 rounded-lg border border-white/6 bg-[#141416] p-4">
         <h3 className="mb-3 text-xs font-semibold text-zinc-400">{fa.dependencies}</h3>
         <div className="grid gap-4 sm:grid-cols-2">
            <div>
               <div className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <Lock className="size-3" />
                  {fa.blockedBy}
               </div>
               {blockers.length ? (
                  blockers.map((blocker) => <TaskLine key={blocker.id} task={blocker} />)
               ) : (
                  <p className="py-1 text-xs text-zinc-600">{fa.noBlockers}</p>
               )}
            </div>
            <div>
               <div className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <Unlock className="size-3" />
                  {fa.blocks}
               </div>
               {state.blocks.length ? (
                  state.blocks.map((blocked) => <TaskLine key={blocked.id} task={blocked} />)
               ) : (
                  <p className="py-1 text-xs text-zinc-600">—</p>
               )}
            </div>
         </div>
      </section>
   );
}

/** B — a property in the rail, so takeability sits beside status and assignee. */
export function VariantB({ state }: { state: Takeability }) {
   return (
      <div className="border-b border-white/6 px-2 py-3">
         <div className="mb-2 text-[11px] text-zinc-500">{fa.takeState}</div>
         <div
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${
               state.takeable ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
            }`}
         >
            {state.takeable ? <Unlock className="size-3" /> : <Lock className="size-3" />}
            {state.takeable ? fa.takeable : fa.openBlockers(state.openBlockers.length)}
         </div>
         {state.openBlockers.length ? (
            <div className="mt-2 space-y-0.5">
               {state.openBlockers.map((blocker) => (
                  <TaskLine key={blocker.id} task={blocker} />
               ))}
            </div>
         ) : null}
         {state.closedBlockers.length ? (
            <div className="mt-2 text-[11px] text-zinc-600">
               {state.closedBlockers.length} {fa.resolved}
            </div>
         ) : null}
      </div>
   );
}

/** C — a banner, impossible to miss and impossible to avoid on the tasks that need neither. */
export function VariantC({ state }: { state: Takeability }) {
   return (
      <div
         className={`mb-5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 ${
            state.takeable
               ? 'border-emerald-500/20 bg-emerald-500/5'
               : 'border-amber-500/20 bg-amber-500/5'
         }`}
      >
         {state.takeable ? (
            <Unlock className="size-4 shrink-0 text-emerald-400" />
         ) : (
            <Lock className="size-4 shrink-0 text-amber-400" />
         )}
         <span className={`text-sm font-medium ${state.takeable ? 'text-emerald-300' : 'text-amber-300'}`}>
            {state.takeable ? fa.takeable : fa.notTakeable}
         </span>
         {state.openBlockers.map((blocker) => (
            <span
               key={blocker.id}
               className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-xs text-zinc-300"
            >
               <span className="ltr font-medium text-zinc-400">{blocker.key}</span>
               <span className="max-w-[16rem] truncate">{blocker.title}</span>
            </span>
         ))}
      </div>
   );
}

const VARIANTS = ['A', 'B', 'C'] as const;
export type VariantKey = (typeof VARIANTS)[number];
const NAMES: Record<VariantKey, string> = {
   A: 'Body section',
   B: 'Property in the rail',
   C: 'Banner'
};

export function useTakeabilityVariant(): VariantKey {
   const [params] = useSearchParams();
   const raw = (params.get('variant') ?? '').toUpperCase();
   return (VARIANTS as readonly string[]).includes(raw) ? (raw as VariantKey) : 'A';
}

/** Fixed pill at the bottom. Deliberately ugly so it reads as scaffolding, not design. */
export function PrototypeSwitcher() {
   const [params, setParams] = useSearchParams();
   const current = useTakeabilityVariant();

   const go = (step: number) => {
      const next = VARIANTS[(VARIANTS.indexOf(current) + step + VARIANTS.length) % VARIANTS.length];
      const updated = new URLSearchParams(params);
      updated.set('variant', next);
      setParams(updated, { replace: true });
   };

   useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
         const target = event.target as HTMLElement | null;
         if (target && (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;
         // The app is RTL but these are physical keys; left means previous, as it does everywhere.
         if (event.key === 'ArrowLeft') go(-1);
         if (event.key === 'ArrowRight') go(1);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
   });

   if (import.meta.env.PROD) return null;

   return (
      <div
         dir="ltr"
         className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border-2 border-fuchsia-500 bg-black px-2 py-1 font-mono text-xs text-fuchsia-300 shadow-lg"
      >
         <button className="rounded p-1 hover:bg-white/10" type="button" onClick={() => go(-1)}>
            <ChevronLeft className="size-4" />
         </button>
         <span className="px-1">
            PROTO #26 · {current} — {NAMES[current]}
         </span>
         <button className="rounded p-1 hover:bg-white/10" type="button" onClick={() => go(1)}>
            <ChevronRight className="size-4" />
         </button>
      </div>
   );
}
