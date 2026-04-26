'use client';

import type { ChangeEvent, FormEvent, SelectHTMLAttributes } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
   ArrowRight,
   CalendarClock,
   ChevronDown,
   ExternalLink,
   FileText,
   History,
   Loader2,
   MessageSquare,
   Paperclip,
   Send,
   X,
} from 'lucide-react';
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
import { taskaraRequest, uploadTaskAttachment, uploadTaskCommentAttachment } from '@/lib/taskara-client';
import { taskPriorities, taskStatuses } from '@/lib/taskara-presenters';
import type {
   PaginatedResponse,
   TaskaraActivity,
   TaskaraAttachment,
   TaskaraTask,
   TaskaraTaskComment,
   TaskaraUser,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

type TaskUpdatePatch = {
   title?: string;
   description?: string | null;
   status?: string;
   priority?: string;
   assigneeId?: string | null;
   dueAt?: string | null;
};

type SavingField = 'title' | 'description' | null;

type IssueReturnLocation = {
   hash?: string;
   pathname?: string;
   search?: string;
};

type IssueLocationState = {
   from?: IssueReturnLocation | string;
};

function getIssueReturnPath(state: unknown): string | null {
   if (!state || typeof state !== 'object' || !('from' in state)) return null;

   const { from } = state as IssueLocationState;
   if (typeof from === 'string') return from.startsWith('/') ? from : null;
   if (!from || typeof from.pathname !== 'string' || !from.pathname.startsWith('/')) return null;

   return `${from.pathname}${from.search || ''}${from.hash || ''}`;
}

export function IssuePage() {
   const location = useLocation();
   const navigate = useNavigate();
   const { orgId, taskKey } = useParams();
   const [task, setTask] = useState<TaskaraTask | null>(null);
   const [activities, setActivities] = useState<TaskaraActivity[]>([]);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [titleDraft, setTitleDraft] = useState('');
   const [descriptionDraft, setDescriptionDraft] = useState('');
   const [commentBody, setCommentBody] = useState('');
   const [commentFiles, setCommentFiles] = useState<File[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [savingField, setSavingField] = useState<SavingField>(null);
   const [descriptionUploading, setDescriptionUploading] = useState(false);
   const [commentSubmitting, setCommentSubmitting] = useState(false);
   const descriptionFileInputRef = useRef<HTMLInputElement>(null);
   const commentFileInputRef = useRef<HTMLInputElement>(null);
   const fallbackIssuesPath = `/${orgId || 'taskara'}/team/all/all`;
   const currentPath = `${location.pathname}${location.search}${location.hash}`;
   const returnPath = getIssueReturnPath(location.state);

   const closeIssuePage = useCallback(() => {
      if (location.key !== 'default') {
         navigate(-1);
         return;
      }

      if (returnPath && returnPath !== currentPath) {
         navigate(returnPath);
         return;
      }

      navigate(fallbackIssuesPath);
   }, [currentPath, fallbackIssuesPath, location.key, navigate, returnPath]);

   const loadActivity = useCallback(async (idOrKey: string) => {
      try {
         const activityResult = await taskaraRequest<TaskaraActivity[]>(
            `/tasks/${encodeURIComponent(idOrKey)}/activity`
         );
         setActivities(activityResult);
      } catch {
         setActivities([]);
      }
   }, []);

   const load = useCallback(async () => {
      if (!taskKey) return;
      setLoading(true);
      setError('');
      try {
         const [taskResult, usersResult, activityResult] = await Promise.all([
            taskaraRequest<TaskaraTask>(`/tasks/${encodeURIComponent(taskKey)}`),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=100').catch(() => ({
               items: [],
               total: 0,
               limit: 0,
               offset: 0,
            })),
            taskaraRequest<TaskaraActivity[]>(`/tasks/${encodeURIComponent(taskKey)}/activity`).catch(() => []),
         ]);
         setTask(taskResult);
         setTitleDraft(taskResult.title);
         setDescriptionDraft(taskResult.description || '');
         setUsers(usersResult.items);
         setActivities(activityResult);
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
         closeIssuePage();
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
   }, [closeIssuePage]);

   async function updateTask(patch: TaskUpdatePatch): Promise<TaskaraTask | null> {
      if (!task) return null;
      try {
         const updated = await taskaraRequest<TaskaraTask>(`/tasks/${encodeURIComponent(task.key)}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
         });
         setTask((current) => (current ? { ...current, ...updated } : updated));
         await loadActivity(task.key);
         return updated;
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.updateFailed);
         return null;
      }
   }

   async function saveTitleDraft() {
      if (!task) return;
      const nextTitle = titleDraft.trim();
      if (!nextTitle) {
         setTitleDraft(task.title);
         toast.error(fa.issue.titleRequired);
         return;
      }
      if (nextTitle === task.title) return;

      setSavingField('title');
      try {
         const updated = await updateTask({ title: nextTitle });
         if (updated) setTitleDraft(updated.title);
      } finally {
         setSavingField(null);
      }
   }

   async function saveDescriptionDraft() {
      if (!task) return;
      const nextDescription = descriptionDraft.trim() || null;
      const currentDescription = task.description?.trim() || null;
      if (nextDescription === currentDescription) return;

      setSavingField('description');
      try {
         const updated = await updateTask({ description: nextDescription });
         if (updated) setDescriptionDraft(updated.description || '');
      } finally {
         setSavingField(null);
      }
   }

   async function uploadDescriptionAttachments(fileList: FileList | null) {
      const files = Array.from(fileList || []);
      if (!task || files.length === 0) return;

      setDescriptionUploading(true);
      try {
         const uploaded = await Promise.all(files.map((file) => uploadTaskAttachment(task.key, file)));
         setTask((current) => {
            if (!current) return current;
            const currentCount = current._count?.attachments ?? current.attachments?.length ?? 0;
            return {
               ...current,
               attachments: [...(current.attachments || []), ...uploaded],
               _count: { ...current._count, attachments: currentCount + uploaded.length },
            };
         });
         await loadActivity(task.key);
         toast.success(
            uploaded.length === 1
               ? fa.issue.attachmentUploaded
               : fa.issue.attachmentsUploaded.replace('{count}', uploaded.length.toLocaleString('fa-IR'))
         );
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.attachmentUploadFailed);
      } finally {
         setDescriptionUploading(false);
         if (descriptionFileInputRef.current) descriptionFileInputRef.current.value = '';
      }
   }

   function selectCommentFiles(event: ChangeEvent<HTMLInputElement>) {
      const files = Array.from(event.target.files || []);
      if (files.length) setCommentFiles((current) => [...current, ...files]);
      event.target.value = '';
   }

   function removeCommentFile(index: number) {
      setCommentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
   }

   async function submitComment(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const body = commentBody.trim();
      if (!task || !body) return;

      setCommentSubmitting(true);
      try {
         const comment = await taskaraRequest<TaskaraTaskComment>(`/tasks/${encodeURIComponent(task.key)}/comments`, {
            method: 'POST',
            body: JSON.stringify({ body, source: 'WEB' }),
         });
         let uploaded: TaskaraAttachment[] = [];
         if (commentFiles.length) {
            try {
               uploaded = await Promise.all(
                  commentFiles.map((file) => uploadTaskCommentAttachment(task.key, comment.id, file))
               );
            } catch (err) {
               toast.error(err instanceof Error ? err.message : fa.issue.attachmentUploadFailed);
            }
         }
         setCommentBody('');
         setCommentFiles([]);
         setTask((current) => {
            if (!current) return current;
            const currentCommentCount = current._count?.comments ?? current.comments?.length ?? 0;
            const currentAttachmentCount = current._count?.attachments ?? current.attachments?.length ?? 0;
            return {
               ...current,
               comments: [...(current.comments || []), { ...comment, attachments: uploaded }],
               _count: {
                  ...current._count,
                  comments: currentCommentCount + 1,
                  attachments: currentAttachmentCount + uploaded.length,
               },
            };
         });
         await loadActivity(task.key);
         toast.success(fa.issue.commentCreated);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.commentFailed);
      } finally {
         setCommentSubmitting(false);
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
                  onClick={closeIssuePage}
               >
                  <ArrowRight className="size-4" />
                  {fa.nav.issues}
               </Button>
               <span className="ltr text-sm font-medium text-zinc-500">{task.key}</span>
            </div>

            <div className="relative">
               <input
                  className="w-full border-0 bg-transparent p-0 text-4xl font-bold leading-tight text-zinc-100 outline-none placeholder:text-zinc-600"
                  dir="auto"
                  value={titleDraft}
                  onBlur={() => void saveTitleDraft()}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                     if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  placeholder={fa.issue.titlePlaceholder}
               />
               {savingField === 'title' ? (
                  <Loader2 className="absolute left-0 top-3 size-4 animate-spin text-zinc-500" />
               ) : null}
            </div>

            <section className="mt-6">
               <div className="relative">
                  <Textarea
                     className="min-h-28 resize-y border-0 bg-transparent p-0 text-base leading-8 text-zinc-400 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
                     dir="auto"
                     value={descriptionDraft}
                     onBlur={() => void saveDescriptionDraft()}
                     onChange={(event) => setDescriptionDraft(event.target.value)}
                     placeholder={fa.issue.descriptionPlaceholder}
                  />
                  {savingField === 'description' ? (
                     <Loader2 className="absolute left-0 top-1 size-4 animate-spin text-zinc-500" />
                  ) : null}
               </div>

               <div className="mt-4 flex flex-wrap items-center gap-2">
                  <input
                     ref={descriptionFileInputRef}
                     className="hidden"
                     multiple
                     type="file"
                     onChange={(event) => void uploadDescriptionAttachments(event.target.files)}
                  />
                  <button
                     aria-label={fa.issue.attachToDescription}
                     className="inline-flex h-8 items-center gap-2 rounded-md border border-white/8 bg-white/[0.03] px-3 text-xs text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                     disabled={descriptionUploading}
                     type="button"
                     onClick={() => descriptionFileInputRef.current?.click()}
                  >
                     {descriptionUploading ? (
                        <Loader2 className="size-4 animate-spin" />
                     ) : (
                        <Paperclip className="size-4" />
                     )}
                     {fa.issue.uploadAttachment}
                  </button>
               </div>

               <AttachmentList attachments={attachments} className="mt-3" />
            </section>

            <form className="mt-10 rounded-xl border border-white/8 bg-white/[0.03] p-3" onSubmit={submitComment}>
               <Textarea
                  className="min-h-20 resize-none border-0 bg-transparent p-0 text-sm text-zinc-300 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
                  value={commentBody}
                  onChange={(event) => setCommentBody(event.target.value)}
                  placeholder={fa.issue.leaveComment}
               />
               {commentFiles.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                     {commentFiles.map((file, index) => (
                        <button
                           key={`${file.name}-${file.size}-${index}`}
                           className="inline-flex max-w-full items-center gap-2 rounded-md border border-white/8 bg-white/[0.04] px-2 py-1 text-xs text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
                           type="button"
                           onClick={() => removeCommentFile(index)}
                        >
                           <FileText className="size-3.5 shrink-0" />
                           <span className="max-w-44 truncate">{file.name}</span>
                           <X className="size-3.5 shrink-0" />
                        </button>
                     ))}
                  </div>
               ) : null}
               <div className="mt-3 flex items-center justify-between">
                  <input
                     ref={commentFileInputRef}
                     className="hidden"
                     multiple
                     type="file"
                     onChange={selectCommentFiles}
                  />
                  <button
                     aria-label={fa.issue.attachToComment}
                     className="rounded-full bg-white/8 p-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                     type="button"
                     onClick={() => commentFileInputRef.current?.click()}
                  >
                     <Paperclip className="size-4" />
                  </button>
                  <button
                     className="rounded-full bg-white/8 p-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                     disabled={!commentBody.trim() || commentSubmitting}
                     type="submit"
                  >
                     {commentSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  </button>
               </div>
            </form>

            <div className="mt-6 pb-8">
               <LinearPanel title={fa.issue.activity}>
                  <ActivityTimeline activities={activities} comments={comments} updatedAt={task.updatedAt} />
               </LinearPanel>
            </div>
         </main>

         <aside className="min-w-0 border-s border-white/6 bg-[#141416] p-4">
            <div className="mb-4 flex items-center justify-between">
               <h2 className="text-sm font-semibold text-zinc-200">{fa.issue.details}</h2>
               <button
                  aria-label={fa.app.close}
                  className="rounded-md p-1 text-zinc-500 hover:bg-white/6 hover:text-zinc-200"
                  type="button"
                  onClick={closeIssuePage}
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
                        <LinearAvatar
                           name={task.assignee?.name}
                           src={task.assignee?.avatarUrl}
                           className="size-5 shrink-0"
                        />
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

type TimelineItem =
   | { id: string; createdAt: string; type: 'activity'; activity: TaskaraActivity }
   | { id: string; createdAt: string; type: 'comment'; comment: TaskaraTaskComment };

function ActivityTimeline({
   activities,
   comments,
   updatedAt,
}: {
   activities: TaskaraActivity[];
   comments: TaskaraTaskComment[];
   updatedAt?: string;
}) {
   const items = useMemo<TimelineItem[]>(() => {
      const activityItems: TimelineItem[] = activities
         .filter((activity) => activity.action !== 'commented' && activity.action !== 'comment_attachment_added')
         .map((activity) => ({
            id: `activity-${activity.id}`,
            createdAt: activity.createdAt,
            type: 'activity',
            activity,
         }));
      const commentItems: TimelineItem[] = comments.map((comment) => ({
         id: `comment-${comment.id}`,
         createdAt: comment.createdAt,
         type: 'comment',
         comment,
      }));

      return [...activityItems, ...commentItems].sort(
         (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime()
      );
   }, [activities, comments]);

   return (
      <div className="space-y-4 p-4 text-sm text-zinc-500">
         {updatedAt ? (
            <div className="flex items-center gap-2">
               <CalendarClock className="size-4" />
               <span>
                  {fa.issue.updatedAt}: {formatJalaliDateTime(updatedAt)}
               </span>
            </div>
         ) : null}

         {items.length ? (
            items.map((item) =>
               item.type === 'comment' ? (
                  <CommentTimelineItem key={item.id} comment={item.comment} />
               ) : (
                  <ActivityTimelineItem key={item.id} activity={item.activity} />
               )
            )
         ) : (
            <p className="rounded-xl border border-white/8 bg-white/[0.02] p-3 text-zinc-500">{fa.issue.noActivity}</p>
         )}
      </div>
   );
}

function CommentTimelineItem({ comment }: { comment: TaskaraTaskComment }) {
   return (
      <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
         <div className="mb-2 flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-2 font-medium text-zinc-300">
               <MessageSquare className="size-4 shrink-0 text-zinc-500" />
               <span className="truncate">{comment.author?.name || fa.app.unknown}</span>
            </span>
            <span className="shrink-0 text-xs text-zinc-600">{formatJalaliDateTime(comment.createdAt)}</span>
         </div>
         <p className="whitespace-pre-wrap leading-7 text-zinc-400">{comment.body}</p>
         <AttachmentList attachments={comment.attachments || []} compact className="mt-3" />
      </div>
   );
}

function ActivityTimelineItem({ activity }: { activity: TaskaraActivity }) {
   const changes = getActivityChanges(activity);
   const attachment = activity.action === 'attachment_added' ? attachmentFromActivity(activity) : null;

   return (
      <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
         <div className="mb-2 flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-2 font-medium text-zinc-300">
               <History className="size-4 shrink-0 text-zinc-500" />
               <span className="truncate">{activity.actor?.name || fa.app.unknown}</span>
            </span>
            <span className="shrink-0 text-xs text-zinc-600">{formatJalaliDateTime(activity.createdAt)}</span>
         </div>
         <p className="leading-7 text-zinc-400">{activityTitle(activity)}</p>
         {changes.length ? (
            <div className="mt-3 space-y-2">
               {changes.map((change) => (
                  <div
                     key={change.label}
                     className="grid gap-2 rounded-lg border border-white/6 bg-black/10 p-2 text-xs text-zinc-500 sm:grid-cols-[96px_minmax(0,1fr)]"
                  >
                     <span className="text-zinc-400">{change.label}</span>
                     <span className="min-w-0">
                        <span className="break-words text-zinc-600">{change.before}</span>
                        <span className="px-2 text-zinc-500">→</span>
                        <span className="break-words text-zinc-300">{change.after}</span>
                     </span>
                  </div>
               ))}
            </div>
         ) : null}
         {attachment ? <AttachmentList attachments={[attachment]} compact className="mt-3" /> : null}
      </div>
   );
}

function AttachmentList({
   attachments,
   compact = false,
   className,
}: {
   attachments: TaskaraAttachment[];
   compact?: boolean;
   className?: string;
}) {
   if (!attachments.length) return null;

   return (
      <div className={cn('grid gap-2', className)}>
         {attachments.map((attachment) => (
            <a
               key={attachment.id}
               className={cn(
                  'flex min-w-0 items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200',
                  compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'
               )}
               href={attachment.url}
               rel="noreferrer"
               target="_blank"
            >
               <FileText className="size-4 shrink-0 text-zinc-500" />
               <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
               {attachment.sizeBytes ? (
                  <span className="shrink-0 text-xs text-zinc-600">{formatFileSize(attachment.sizeBytes)}</span>
               ) : null}
               <ExternalLink className="size-3.5 shrink-0 text-zinc-600" />
            </a>
         ))}
      </div>
   );
}

function activityTitle(activity: TaskaraActivity): string {
   switch (activity.action) {
      case 'created':
         return 'کار ایجاد شد.';
      case 'updated':
         return 'کار به‌روزرسانی شد.';
      case 'attachment_added':
         return 'پیوست به توضیح اضافه شد.';
      case 'comment_attachment_added':
         return 'پیوست به دیدگاه اضافه شد.';
      default:
         return activity.action;
   }
}

function getActivityChanges(activity: TaskaraActivity): Array<{ label: string; before: string; after: string }> {
   if (activity.action !== 'updated') return [];
   const before = asRecord(activity.before);
   const after = asRecord(activity.after);
   if (!before || !after) return [];

   const fields = [
      { label: 'عنوان', get: (record: Record<string, unknown>) => formatTextValue(stringValue(record.title)) },
      { label: 'توضیح', get: (record: Record<string, unknown>) => formatTextValue(stringValue(record.description)) },
      { label: fa.issue.status, get: (record: Record<string, unknown>) => formatStatus(stringValue(record.status)) },
      { label: fa.issue.priority, get: (record: Record<string, unknown>) => formatPriority(stringValue(record.priority)) },
      { label: fa.issue.assignee, get: formatAssignee },
      { label: fa.issue.dueAt, get: (record: Record<string, unknown>) => formatDateValue(stringValue(record.dueAt)) },
   ];

   return fields.reduce<Array<{ label: string; before: string; after: string }>>((changes, field) => {
      const beforeValue = field.get(before);
      const afterValue = field.get(after);
      if (beforeValue !== afterValue) changes.push({ label: field.label, before: beforeValue, after: afterValue });
      return changes;
   }, []);
}

function attachmentFromActivity(activity: TaskaraActivity): TaskaraAttachment | null {
   const after = asRecord(activity.after);
   if (!after) return null;
   const name = stringValue(after.name);
   const url = stringValue(after.url);
   if (!name || !url) return null;

   return {
      id: stringValue(after.id) || activity.id,
      taskId: stringValue(after.taskId) || activity.entityId,
      commentId: stringValue(after.commentId),
      name,
      documentId: stringValue(after.documentId),
      object: stringValue(after.object) || '',
      url,
      mimeType: stringValue(after.mimeType),
      sizeBytes: numberValue(after.sizeBytes),
      createdAt: stringValue(after.createdAt) || activity.createdAt,
   };
}

function formatAssignee(record: Record<string, unknown>): string {
   const assignee = asRecord(record.assignee);
   return formatTextValue(assignee ? stringValue(assignee.name) : null);
}

function formatStatus(value: string | null): string {
   if (!value) return fa.app.unset;
   return linearStatusMeta[value as keyof typeof linearStatusMeta]?.label || value;
}

function formatPriority(value: string | null): string {
   if (!value) return fa.app.unset;
   return linearPriorityMeta[value as keyof typeof linearPriorityMeta]?.label || value;
}

function formatDateValue(value: string | null): string {
   return value ? formatJalaliDateTime(value) : fa.app.unset;
}

function formatTextValue(value: string | null): string {
   if (!value?.trim()) return fa.app.unset;
   const compact = value.replace(/\s+/g, ' ').trim();
   return compact.length > 90 ? `${compact.slice(0, 90)}...` : compact;
}

function stringValue(value: unknown): string | null {
   return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
   return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
   return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function formatFileSize(bytes: number): string {
   if (bytes < 1024) return `${bytes.toLocaleString('fa-IR')} B`;
   const kilobytes = bytes / 1024;
   if (kilobytes < 1024) return `${kilobytes.toLocaleString('fa-IR', { maximumFractionDigits: 1 })} KB`;
   return `${(kilobytes / 1024).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} MB`;
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
