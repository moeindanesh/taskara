'use client';

import type { FormEvent, SelectHTMLAttributes } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, CalendarClock, ChevronDown, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import {
   LinearAvatar,
   LinearPanel,
   linearPriorityMeta,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDateTime } from '@/lib/jalali';
import { taskaraRequest } from '@/lib/taskara-client';
import { taskPriorities, taskStatuses } from '@/lib/taskara-presenters';
import type { PaginatedResponse, TaskaraTask, TaskaraTaskComment, TaskaraUser } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

type TaskUpdatePatch = {
   status?: string;
   priority?: string;
   assigneeId?: string | null;
   dueAt?: string | null;
};

export function IssuePage() {
   const navigate = useNavigate();
   const { orgId, taskKey } = useParams();
   const [task, setTask] = useState<TaskaraTask | null>(null);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [commentBody, setCommentBody] = useState('');
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');

   const load = useCallback(async () => {
      if (!taskKey) return;
      setLoading(true);
      setError('');
      try {
         const [taskResult, usersResult] = await Promise.all([
            taskaraRequest<TaskaraTask>(`/tasks/${encodeURIComponent(taskKey)}`),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=100').catch(() => ({
               items: [],
               total: 0,
               limit: 0,
               offset: 0,
            })),
         ]);
         setTask(taskResult);
         setUsers(usersResult.items);
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.issue.loadFailed);
      } finally {
         setLoading(false);
      }
   }, [taskKey]);

   useEffect(() => {
      void load();
   }, [load]);

   useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
         if (event.key !== 'Escape') return;
         navigate(`/${orgId || 'taskara'}/team/all/all`);
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
   }, [navigate, orgId]);

   async function updateTask(patch: TaskUpdatePatch) {
      if (!task) return;
      try {
         const updated = await taskaraRequest<TaskaraTask>(`/tasks/${encodeURIComponent(task.key)}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
         });
         setTask((current) => (current ? { ...current, ...updated } : updated));
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.updateFailed);
      }
   }

   async function submitComment(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!task || !commentBody.trim()) return;

      try {
         await taskaraRequest<TaskaraTaskComment>(`/tasks/${encodeURIComponent(task.key)}/comments`, {
            method: 'POST',
            body: JSON.stringify({ body: commentBody.trim(), source: 'WEB' }),
         });
         setCommentBody('');
         toast.success(fa.issue.commentCreated);
         await load();
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.commentFailed);
      }
   }

   if (loading) return <div className="p-6 text-sm text-zinc-500">{fa.app.loading}</div>;

   if (error || !task) {
      return (
         <div className="p-6">
            <p className="rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
               {error || fa.issue.noIssueSelected}
            </p>
         </div>
      );
   }

   const comments = task.comments || [];
   const attachments = task.attachments || [];

   return (
      <div className="grid h-full min-h-0 bg-[#101011] lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="issue-page">
         <main className="min-w-0 overflow-y-auto px-6 py-5">
            <div className="mb-8 flex items-center justify-between gap-3">
               <Button
                  className="rounded-full border-white/8 bg-white/5 text-zinc-300 hover:bg-white/10"
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => navigate(`/${orgId || 'taskara'}/team/all/all`)}
               >
                  <ArrowRight className="size-4" />
                  {fa.nav.issues}
               </Button>
               <span className="ltr text-sm font-medium text-zinc-500">{task.key}</span>
            </div>

            <h1 className="text-4xl font-bold leading-tight text-zinc-100">{task.title}</h1>
            <p className="mt-6 min-h-20 whitespace-pre-wrap text-base leading-8 text-zinc-400">
               {task.description || fa.issue.descriptionPlaceholder}
            </p>

            <div className="mt-10 space-y-4">
               <LinearPanel title={fa.issue.activity}>
                  <div className="space-y-4 p-4 text-sm text-zinc-500">
                     <div className="flex items-center gap-2">
                        <CalendarClock className="size-4" />
                        <span>{fa.issue.updatedAt}: {formatJalaliDateTime(task.updatedAt)}</span>
                     </div>
                     {attachments.length ? (
                        <div className="text-zinc-400">
                           {fa.issue.attachments}: {attachments.length.toLocaleString('fa-IR')}
                        </div>
                     ) : null}
                     {comments.map((comment) => (
                        <div key={comment.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
                           <div className="mb-1 flex items-center justify-between gap-2">
                              <span className="font-medium text-zinc-300">{comment.author?.name || fa.app.unknown}</span>
                              <span className="text-xs text-zinc-600">{formatJalaliDateTime(comment.createdAt)}</span>
                           </div>
                           <p className="whitespace-pre-wrap leading-7 text-zinc-400">{comment.body}</p>
                        </div>
                     ))}
                  </div>
               </LinearPanel>
            </div>

            <form className="mt-6 rounded-xl border border-white/8 bg-white/[0.03] p-3" onSubmit={submitComment}>
               <Textarea
                  className="min-h-20 resize-none border-0 bg-transparent p-0 text-sm text-zinc-300 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
                  value={commentBody}
                  onChange={(event) => setCommentBody(event.target.value)}
                  placeholder={fa.issue.leaveComment}
               />
               <div className="mt-3 flex justify-end">
                  <button
                     className="rounded-full bg-white/8 p-1.5 text-zinc-500 disabled:opacity-40"
                     disabled={!commentBody.trim()}
                     type="submit"
                  >
                     <Send className="size-4" />
                  </button>
               </div>
            </form>
         </main>

         <aside className="min-w-0 border-s border-white/6 bg-[#141416] p-4">
            <div className="mb-4 flex items-center justify-between">
               <h2 className="text-sm font-semibold text-zinc-200">{fa.issue.details}</h2>
               <button
                  aria-label={fa.app.close}
                  className="rounded-md p-1 text-zinc-500 hover:bg-white/6 hover:text-zinc-200"
                  type="button"
                  onClick={() => navigate(`/${orgId || 'taskara'}/team/all/all`)}
               >
                  <X className="size-4" />
               </button>
            </div>

            <LinearPanel title={fa.issue.properties}>
               <div className="grid gap-3 p-4 text-sm">
                  <PropertyRow label={fa.issue.status}>
                     <DetailSelect
                        aria-label={fa.issue.status}
                        value={task.status}
                        onChange={(event) => void updateTask({ status: event.target.value })}
                     >
                        {taskStatuses.map((status) => (
                           <option key={status} value={status}>
                              {linearStatusMeta[status]?.label || status}
                           </option>
                        ))}
                     </DetailSelect>
                  </PropertyRow>
                  <PropertyRow label={fa.issue.priority}>
                     <DetailSelect
                        aria-label={fa.issue.priority}
                        value={task.priority}
                        onChange={(event) => void updateTask({ priority: event.target.value })}
                     >
                        {taskPriorities.map((priority) => (
                           <option key={priority} value={priority}>
                              {linearPriorityMeta[priority]?.label || priority}
                           </option>
                        ))}
                     </DetailSelect>
                  </PropertyRow>
                  <PropertyRow label={fa.issue.assignee}>
                     <div className="flex min-w-0 items-center gap-2">
                        <LinearAvatar name={task.assignee?.name} className="size-5 shrink-0" />
                        <DetailSelect
                           aria-label={fa.issue.assignee}
                           className="min-w-0 flex-1"
                           value={task.assignee?.id || ''}
                           onChange={(event) => void updateTask({ assigneeId: event.target.value || null })}
                        >
                           <option value="">{fa.app.unset}</option>
                           {users.map((user) => (
                              <option key={user.id} value={user.id}>
                                 {user.name}
                              </option>
                           ))}
                        </DetailSelect>
                     </div>
                  </PropertyRow>
                  <PropertyRow label={fa.issue.project}>{task.project?.name || fa.app.unknown}</PropertyRow>
                  <PropertyRow label={fa.issue.dueAt}>
                     <LazyJalaliDatePicker
                        ariaLabel={fa.issue.dueAt}
                        value={task.dueAt || null}
                        onChange={(dueAt) => void updateTask({ dueAt })}
                     />
                  </PropertyRow>
                  <PropertyRow label={fa.issue.comments}>
                     {(task._count?.comments ?? comments.length).toLocaleString('fa-IR')}
                  </PropertyRow>
                  <PropertyRow label={fa.issue.attachments}>
                     {(task._count?.attachments ?? attachments.length).toLocaleString('fa-IR')}
                  </PropertyRow>
               </div>
            </LinearPanel>
         </aside>
      </div>
   );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
   return (
      <div className="grid min-h-9 grid-cols-[92px_minmax(0,1fr)] items-center gap-3">
         <span className="text-start text-xs text-zinc-500">{label}</span>
         <span className="min-w-0 text-start text-zinc-300">{children}</span>
      </div>
   );
}

function DetailSelect({
   className,
   children,
   ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
   return (
      <span className={cn('relative block w-full min-w-0', className)}>
         <select
            className="h-8 w-full cursor-pointer appearance-none rounded-md border border-white/8 bg-white/[0.03] py-0 ps-3 pe-8 text-start text-sm text-zinc-300 outline-none transition hover:bg-white/[0.05] focus-visible:ring-1 focus-visible:ring-indigo-400/60"
            {...props}
         >
            {children}
         </select>
         <ChevronDown className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
      </span>
   );
}
