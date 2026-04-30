'use client';

import type { ChangeEvent, FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
   ArrowRight,
   Box,
   Copy,
   ExternalLink,
   FileArchive,
   FileText,
   GitBranch,
   History,
   ImageIcon,
   Link2,
   Loader2,
   MoreHorizontal,
   Paperclip,
   Send,
   Tag,
   X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { DescriptionEditor } from '@/components/taskara/description-editor';
import { TaskDueDateControl } from '@/components/taskara/task-due-date-control';
import {
   LinearAvatar,
   NoAssigneeIcon,
   PriorityIcon,
   ProjectGlyph,
   StatusIcon,
   linearPriorityMeta,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDateTime } from '@/lib/jalali';
import { taskaraRequest, uploadTaskAttachment, uploadTaskCommentAttachment } from '@/lib/taskara-client';
import { sendTaskSyncMutation, useTaskSyncPulse } from '@/lib/task-sync';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskPriorities, taskStatuses } from '@/lib/taskara-presenters';
import type {
   PaginatedResponse,
   TaskaraActivity,
   TaskaraAttachment,
   TaskaraProject,
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
   projectId?: string | null;
   dueAt?: string | null;
};

type IssueProjectOption = Pick<TaskaraProject, 'id' | 'name' | 'keyPrefix' | 'team'>;
type SavingField = 'title' | 'description' | null;
type PreviewableAttachment = {
   name: string;
   url: string;
   mimeType?: string | null;
   sizeBytes?: number | null;
};

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

function applyIssuePatch(
   task: TaskaraTask,
   patch: TaskUpdatePatch,
   users: TaskaraUser[],
   projects: TaskaraProject[]
): TaskaraTask {
   const { assigneeId: _assigneeId, projectId: _projectId, ...scalarPatch } = patch;
   const next: TaskaraTask = { ...task, ...scalarPatch, updatedAt: new Date().toISOString() };

   if ('assigneeId' in patch) {
      const assignee = patch.assigneeId ? users.find((user) => user.id === patch.assigneeId) || null : null;
      next.assignee = assignee
         ? {
              id: assignee.id,
              name: assignee.name,
              email: assignee.email,
              phone: assignee.phone,
              avatarUrl: assignee.avatarUrl,
           }
         : null;
   }

   if ('projectId' in patch) {
      const project = patch.projectId ? projects.find((item) => item.id === patch.projectId) || null : null;
      next.project = project
         ? {
              id: project.id,
              name: project.name,
              keyPrefix: project.keyPrefix,
              team: project.team || null,
           }
         : null;
   }

   if (patch.status) {
      next.completedAt = patch.status === 'DONE' ? new Date().toISOString() : null;
   }

   return next;
}

export function IssuePage() {
   const location = useLocation();
   const navigate = useNavigate();
   const { orgId, taskKey } = useParams();
   const taskSync = useWorkspaceTaskSync();
   const [task, setTask] = useState<TaskaraTask | null>(null);
   const [activities, setActivities] = useState<TaskaraActivity[]>([]);
   const [users, setUsers] = useState<TaskaraUser[]>([]);
   const [projects, setProjects] = useState<TaskaraProject[]>([]);
   const [titleDraft, setTitleDraft] = useState('');
   const [descriptionDraft, setDescriptionDraft] = useState('');
   const [commentBody, setCommentBody] = useState('');
   const [commentFiles, setCommentFiles] = useState<File[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [savingField, setSavingField] = useState<SavingField>(null);
   const [descriptionUploading, setDescriptionUploading] = useState(false);
   const [commentSubmitting, setCommentSubmitting] = useState(false);
   const [smsSending, setSmsSending] = useState(false);
   const titleFocusedRef = useRef(false);
   const descriptionFocusedRef = useRef(false);
   const descriptionFileInputRef = useRef<HTMLInputElement>(null);
   const commentFileInputRef = useRef<HTMLInputElement>(null);
   const fallbackIssuesPath = `/${orgId || 'taskara'}/team/all/all`;
   const currentPath = `${location.pathname}${location.search}${location.hash}`;
   const returnPath = getIssueReturnPath(location.state);
   const cachedTask = useMemo(
      () => taskSync.tasks.find((item) => item.key === taskKey || item.id === taskKey) || null,
      [taskKey, taskSync.tasks]
   );
   const cachedTaskRef = useRef<TaskaraTask | null>(null);
   const syncUsersRef = useRef<TaskaraUser[]>([]);

   const closeIssuePage = useCallback(() => {
      if (returnPath && returnPath !== currentPath) {
         navigate(returnPath);
         return;
      }

      if (location.key !== 'default') {
         navigate(-1);
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

   useEffect(() => {
      cachedTaskRef.current = cachedTask;
      if (!cachedTask) return;
      setTask(cachedTask);
      if (!titleFocusedRef.current) setTitleDraft(cachedTask.title);
      if (!descriptionFocusedRef.current) setDescriptionDraft(cachedTask.description || '');
      setLoading(false);
   }, [cachedTask]);

   useEffect(() => {
      syncUsersRef.current = taskSync.users;
      if (taskSync.users.length) setUsers(taskSync.users);
   }, [taskSync.users]);

   const projectOptions = useMemo<IssueProjectOption[]>(() => {
      const options = taskSync.projects.map((project) => ({
         id: project.id,
         name: project.name,
         keyPrefix: project.keyPrefix,
         team: project.team || null,
      }));

      if (task?.project && !options.some((project) => project.id === task.project?.id)) {
         options.unshift({
            id: task.project.id,
            name: task.project.name,
            keyPrefix: task.project.keyPrefix,
            team: task.project.team || null,
         });
      }

      return options;
   }, [task?.project, taskSync.projects]);

   const load = useCallback(async () => {
      if (!taskKey) return;
      const cachedTask = cachedTaskRef.current;
      const syncUsers = syncUsersRef.current;
      if (cachedTask) {
         setTask(cachedTask);
         if (!titleFocusedRef.current) setTitleDraft(cachedTask.title);
         if (!descriptionFocusedRef.current) setDescriptionDraft(cachedTask.description || '');
         if (syncUsers.length) setUsers(syncUsers);
         setLoading(false);
      } else {
         setLoading(true);
      }
      setError('');
      try {
         const [taskResult, usersResult, projectsResult, activityResult] = await Promise.all([
            taskaraRequest<TaskaraTask>(`/tasks/${encodeURIComponent(taskKey)}`),
            syncUsers.length
               ? Promise.resolve({
                    items: syncUsers,
                    total: syncUsers.length,
                    limit: syncUsers.length,
                    offset: 0,
                 } satisfies PaginatedResponse<TaskaraUser>)
               : taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=100').catch(() => ({
                    items: [],
                    total: 0,
                    limit: 0,
                    offset: 0,
                 })),
            taskaraRequest<TaskaraProject[]>('/projects').catch(() => []),
            taskaraRequest<TaskaraActivity[]>(`/tasks/${encodeURIComponent(taskKey)}/activity`).catch(() => []),
         ]);
         setTask(taskResult);
         if (!titleFocusedRef.current) setTitleDraft(taskResult.title);
         if (!descriptionFocusedRef.current) setDescriptionDraft(taskResult.description || '');
         setUsers(usersResult.items);
         setProjects(projectsResult);
         setActivities(activityResult);
      } catch (err) {
         if (!cachedTask) setError(err instanceof Error ? err.message : fa.issue.loadFailed);
      } finally {
         setLoading(false);
      }
   }, [taskKey]);

   useEffect(() => {
      void load();
   }, [load]);

   useTaskSyncPulse(() => {
      void load();
   }, Boolean(taskKey));

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
      const previous = task;
      const optimistic = applyIssuePatch(task, patch, users, projects);
      setTask(optimistic);
      try {
         const { entity: updated } = await sendTaskSyncMutation<TaskaraTask>('task.update', {
            idOrKey: task.key,
            baseVersion: task.version,
            patch,
         });
         if (!updated) throw new Error(fa.issue.updateFailed);
         setTask((current) => (current ? { ...current, ...updated } : updated));
         taskSync.applyTask(updated);
         await loadActivity(updated.key || task.key);
         if (updated.key && updated.key !== task.key) {
            navigate(`/${orgId || 'taskara'}/issue/${encodeURIComponent(updated.key)}`, {
               replace: true,
               state: location.state,
            });
         }
         return updated;
      } catch (err) {
         setTask(previous);
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

   async function saveDescriptionDraft(value = descriptionDraft) {
      if (!task) return;
      const nextDescription = value.trim() || null;
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
         const { entity: comment } = await sendTaskSyncMutation<TaskaraTaskComment>('task.comment.create', {
            idOrKey: task.key,
            body,
            source: 'WEB',
         });
         if (!comment) throw new Error(fa.issue.commentFailed);
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

   async function copyIssueUrl() {
      if (typeof window === 'undefined' || !navigator.clipboard) return;
      try {
         await navigator.clipboard.writeText(window.location.href);
         toast.success('پیوند کار کپی شد.');
      } catch {
         toast.error('کپی پیوند ناموفق بود.');
      }
   }

   async function copyIssueKey() {
      if (!task || !navigator.clipboard) return;
      try {
         await navigator.clipboard.writeText(task.key);
         toast.success('کلید کار کپی شد.');
      } catch {
         toast.error('کپی کلید ناموفق بود.');
      }
   }

   async function sendAssigneeTaskSms() {
      if (!task) return;
      if (!task.assignee) {
         toast.error(fa.issue.smsNoAssignee);
         return;
      }

      setSmsSending(true);
      try {
         await taskaraRequest(`/tasks/${encodeURIComponent(task.key)}/sms/task-created`, { method: 'POST' });
         toast.success(fa.issue.smsSent);
      } catch (err) {
         const message = err instanceof Error ? err.message : fa.issue.smsFailed;
         toast.error(message === 'Task assignee has no phone number' ? fa.issue.smsNoPhone : message);
      } finally {
         setSmsSending(false);
      }
   }

   if (loading) return <div className="p-4 text-sm text-zinc-500">{fa.app.loading}</div>;

   if (error || !task) {
      return (
         <div className="p-4">
            <p className="rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
               {error || fa.issue.noIssueSelected}
            </p>
         </div>
      );
   }

   const comments = task.comments || [];
   const attachments = task.attachments || [];
   const labels = task.labels || [];

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
                  className="w-full border-0 bg-transparent p-0 text-2xl font-semibold leading-8 text-zinc-100 outline-none placeholder:text-zinc-600"
                  dir="auto"
                  value={titleDraft}
                  onFocus={() => {
                     titleFocusedRef.current = true;
                  }}
                  onBlur={() => {
                     titleFocusedRef.current = false;
                     void saveTitleDraft();
                  }}
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
                  <DescriptionEditor
                     value={descriptionDraft}
                     users={users}
                     variant="plain"
                     showToolbar={false}
                     onBlur={(nextDescription) => {
                        descriptionFocusedRef.current = false;
                        void saveDescriptionDraft(nextDescription);
                     }}
                     onCancel={() => {
                        descriptionFocusedRef.current = false;
                        setDescriptionDraft(task.description || '');
                     }}
                     onChange={setDescriptionDraft}
                     onFocus={() => {
                        descriptionFocusedRef.current = true;
                     }}
                     placeholder={fa.issue.descriptionPlaceholder}
                     contentClassName="min-h-24 text-right text-sm leading-6 text-zinc-300"
                  />
                  {savingField === 'description' ? (
                     <Loader2 className="absolute left-0 top-1 size-4 animate-spin text-zinc-500" />
                  ) : null}
               </div>

               <div className="mt-2 flex flex-wrap items-center gap-1">
                  <input
                     ref={descriptionFileInputRef}
                     className="hidden"
                     multiple
                     type="file"
                     onChange={(event) => void uploadDescriptionAttachments(event.target.files)}
                  />
                  <button
                     aria-label={fa.issue.attachToDescription}
                     className="inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                     disabled={descriptionUploading}
                     title={fa.issue.uploadAttachment}
                     type="button"
                     onClick={() => descriptionFileInputRef.current?.click()}
                  >
                     {descriptionUploading ? (
                        <Loader2 className="size-4 animate-spin" />
                     ) : (
                        <Paperclip className="size-4" />
                     )}
                     <span className="sr-only">{fa.issue.uploadAttachment}</span>
                  </button>
               </div>

               <AttachmentList attachments={attachments} className="mt-3" />
            </section>

            <section className="mt-8 border-t border-white/8 pt-5 pb-6">
               <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold text-zinc-100">{fa.issue.activity}</h2>
               </div>

               <ActivityTimeline activities={activities} comments={comments} />

               <form
                  className="mt-6 overflow-hidden rounded-lg border border-white/8 bg-[#19191b] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]"
                  onSubmit={submitComment}
               >
                  <div className="p-3">
                     <Textarea
                        className="min-h-16 resize-none border-0 bg-transparent p-0 text-sm leading-6 text-zinc-300 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
                        value={commentBody}
                        onChange={(event) => setCommentBody(event.target.value)}
                        placeholder={fa.issue.leaveComment}
                     />
                     <PendingAttachmentList files={commentFiles} className="mt-3" onRemove={removeCommentFile} />
                  </div>
                  <div className="flex items-center justify-between border-t border-white/7 px-3 py-2">
                     <input
                        ref={commentFileInputRef}
                        className="hidden"
                        multiple
                        type="file"
                        onChange={selectCommentFiles}
                     />
                     <button
                        aria-label={fa.issue.attachToComment}
                        className="inline-flex size-7 items-center justify-center rounded-full text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200"
                        type="button"
                        onClick={() => commentFileInputRef.current?.click()}
                     >
                        <Paperclip className="size-4" />
                     </button>
                     <button
                        aria-label={fa.issue.leaveComment}
                        className="inline-flex size-8 items-center justify-center rounded-full bg-white/8 text-zinc-400 transition hover:bg-white/12 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={!commentBody.trim() || commentSubmitting}
                        type="submit"
                     >
                        {commentSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                     </button>
                  </div>
               </form>
            </section>
         </main>

         <aside className="min-w-0 border-s border-white/6 bg-[#141416] p-3">
            <div className="mb-3 flex items-center justify-end gap-2">
               <SidebarIconButton
                  ariaLabel={fa.issue.sendTaskSms}
                  disabled={smsSending}
                  onClick={() => void sendAssigneeTaskSms()}
               >
                  {smsSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
               </SidebarIconButton>
               <SidebarIconButton ariaLabel="Copy issue link" onClick={() => void copyIssueUrl()}>
                  <Link2 className="size-4" />
               </SidebarIconButton>
               <SidebarIconButton ariaLabel="Copy issue key" onClick={() => void copyIssueKey()}>
                  <Copy className="size-4" />
               </SidebarIconButton>
               <SidebarIconButton ariaLabel={fa.issue.dependencies}>
                  <GitBranch className="size-4" />
               </SidebarIconButton>
               <div className="inline-flex h-9 items-center overflow-hidden rounded-full border border-white/8 bg-white/[0.05] text-zinc-400 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                  <span
                     aria-hidden="true"
                     className="inline-flex h-full items-center justify-center px-3 text-zinc-500"
                     title={fa.app.more}
                  >
                     <MoreHorizontal className="size-4" />
                  </span>
                  <span className="h-5 w-px bg-white/8" />
                  <button
                     aria-label={fa.app.close}
                     className="inline-flex h-full items-center justify-center px-3 transition hover:bg-white/6 hover:text-zinc-100"
                     type="button"
                     onClick={closeIssuePage}
                  >
                     <X className="size-4" />
                  </button>
               </div>
            </div>

            <SidebarSection title={fa.issue.properties}>
               <div className="grid gap-1 p-2 text-sm">
                  <SidebarSelectRow
                     icon={<StatusIcon status={task.status} className="size-5" />}
                     label={linearStatusMeta[task.status]?.label || task.status}
                  >
                     <select
                        aria-label={fa.issue.status}
                        className="absolute inset-0 cursor-pointer opacity-0"
                        value={task.status}
                        onChange={(event) => void updateTask({ status: event.target.value })}
                     >
                        {taskStatuses.map((status) => (
                           <option key={status} value={status}>
                              {linearStatusMeta[status]?.label || status}
                           </option>
                        ))}
                     </select>
                  </SidebarSelectRow>
                  <SidebarSelectRow
                     muted={task.priority === 'NO_PRIORITY'}
                     icon={<PriorityIcon priority={task.priority} className="size-5" />}
                     label={
                        task.priority === 'NO_PRIORITY'
                           ? fa.issue.priority
                           : linearPriorityMeta[task.priority]?.label || task.priority
                     }
                  >
                     <select
                        aria-label={fa.issue.priority}
                        className="absolute inset-0 cursor-pointer opacity-0"
                        value={task.priority}
                        onChange={(event) => void updateTask({ priority: event.target.value })}
                     >
                        {taskPriorities.map((priority) => (
                           <option key={priority} value={priority}>
                              {linearPriorityMeta[priority]?.label || priority}
                           </option>
                        ))}
                     </select>
                  </SidebarSelectRow>
                  <SidebarSelectRow
                     muted={!task.assignee}
                     icon={
                        task.assignee ? (
                           <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-5" />
                        ) : (
                           <NoAssigneeIcon className="size-5 text-zinc-500" />
                        )
                     }
                     label={task.assignee?.name || fa.issue.assignee}
                  >
                     <select
                        aria-label={fa.issue.assignee}
                        className="absolute inset-0 cursor-pointer opacity-0"
                        value={task.assignee?.id || ''}
                        onChange={(event) => void updateTask({ assigneeId: event.target.value || null })}
                     >
                        <option value="">{fa.app.unset}</option>
                        {users.map((user) => (
                           <option key={user.id} value={user.id}>
                              {user.name}
                           </option>
                        ))}
                     </select>
                  </SidebarSelectRow>
                  <TaskDueDateControl
                     className="h-auto min-h-9 w-full gap-3 rounded-lg px-2 py-2 text-sm"
                     dueAt={task.dueAt || null}
                     iconClassName="size-5 text-zinc-500"
                     onChange={(dueAt) => void updateTask({ dueAt })}
                  />
               </div>
            </SidebarSection>

            <SidebarSection title={fa.issue.labels} className="mt-3">
               <div className="min-h-9 p-2">
                  {labels.length ? (
                     <div className="flex flex-wrap gap-2">
                        {labels.map(({ label }) => (
                           <span
                              key={label.id}
                              className="inline-flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm text-zinc-300 transition hover:bg-white/5"
                           >
                              <span
                                 className="size-2.5 shrink-0 rounded-full"
                                 style={{ backgroundColor: label.color || '#71717a' }}
                              />
                              <span className="truncate">{label.name}</span>
                           </span>
                        ))}
                     </div>
                  ) : (
                     <SidebarEmptyRow icon={<Tag className="size-5" />} label={fa.issue.labels} />
                  )}
               </div>
            </SidebarSection>

            <SidebarSection title={fa.issue.project} className="mt-3">
               <div className="grid gap-1 p-2 text-sm">
                  <SidebarSelectRow
                     muted={!task.project}
                     icon={
                        task.project ? (
                           <ProjectGlyph name={task.project.name} className="size-5 rounded-sm" iconClassName="size-3.5" />
                        ) : (
                           <Box className="size-5 text-zinc-500" />
                        )
                     }
                     label={task.project?.name || fa.issue.project}
                  >
                     <select
                        aria-label={fa.issue.project}
                        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
                        disabled={!projectOptions.length}
                        value={task.project?.id || ''}
                        onChange={(event) => {
                           const projectId = event.target.value;
                           if (!projectId || projectId === task.project?.id) return;
                           void updateTask({ projectId });
                        }}
                     >
                        {!task.project ? <option value="">{fa.app.unset}</option> : null}
                        {projectOptions.map((project) => (
                           <option key={project.id} value={project.id}>
                              {project.name}
                           </option>
                        ))}
                     </select>
                  </SidebarSelectRow>
               </div>
            </SidebarSection>
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
}: {
   activities: TaskaraActivity[];
   comments: TaskaraTaskComment[];
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
      <div className="space-y-3.5 text-sm text-zinc-500">
         {items.length ? (
            items.map((item) =>
               item.type === 'comment' ? (
                  <CommentTimelineItem key={item.id} comment={item.comment} />
               ) : (
                  <ActivityTimelineItem key={item.id} activity={item.activity} />
               )
            )
         ) : (
            <p className="rounded-lg border border-dashed border-white/10 bg-white/[0.015] p-3 text-sm text-zinc-500">
               {fa.issue.noActivity}
            </p>
         )}
      </div>
   );
}

function CommentTimelineItem({ comment }: { comment: TaskaraTaskComment }) {
   return (
      <article className="overflow-hidden rounded-lg border border-white/8 bg-[#19191b] shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]">
         <div className="flex items-start gap-2.5 p-3">
            <LinearAvatar
               name={comment.author?.name}
               src={comment.author?.avatarUrl}
               className="mt-0.5 size-6 shrink-0"
            />
            <div className="min-w-0 flex-1">
               <div className="mb-1.5 flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-100">
                     {comment.author?.name || fa.app.unknown}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500">{formatJalaliDateTime(comment.createdAt)}</span>
               </div>
               <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-200">{comment.body}</p>
               <AttachmentList attachments={comment.attachments || []} compact className="mt-2.5" />
            </div>
         </div>
      </article>
   );
}

function ActivityTimelineItem({ activity }: { activity: TaskaraActivity }) {
   const changes = getActivityChanges(activity);
   const attachment = activity.action === 'attachment_added' ? attachmentFromActivity(activity) : null;
   const activityIcon = getActivityIcon(activity, changes);

   return (
      <div className="flex min-w-0 items-start gap-2.5">
         <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-zinc-500">
            {activityIcon}
         </span>
         <div className="min-w-0 flex-1">
            <p className="min-w-0 text-sm leading-6 text-zinc-500">
               <span className="font-medium text-zinc-400">{activity.actor?.name || fa.app.unknown}</span>
               <span> {activityTitle(activity)}</span>
               <span className="px-1 text-zinc-600">·</span>
               <span className="text-zinc-500">{formatJalaliDateTime(activity.createdAt)}</span>
            </p>
            {changes.length ? (
               <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {changes.map((change) => (
                     <span
                        key={change.label}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-white/7 bg-white/[0.025] px-2 py-0.5 text-xs text-zinc-500"
                     >
                        <span className="text-zinc-400">{change.label}</span>
                        <span className="max-w-28 truncate text-zinc-600">{change.before}</span>
                        <span className="text-zinc-600">←</span>
                        <span className="max-w-32 truncate text-zinc-300">{change.after}</span>
                     </span>
                  ))}
               </div>
            ) : null}
            {attachment ? <AttachmentList attachments={[attachment]} compact className="mt-2" /> : null}
         </div>
      </div>
   );
}

function getActivityIcon(
   activity: TaskaraActivity,
   changes: Array<{ label: string; before: string; after: string }>
): React.ReactNode {
   if (activity.action === 'created') {
      return <LinearAvatar name={activity.actor?.name} src={activity.actor?.avatarUrl} className="size-5" />;
   }
   if (activity.action === 'attachment_added' || activity.action === 'comment_attachment_added') {
      return <Paperclip className="size-4" />;
   }
   const statusChange = changes.find((change) => change.label === fa.issue.status);
   if (statusChange) {
      const status = Object.entries(linearStatusMeta).find(([, meta]) => meta.label === statusChange.after)?.[0];
      return <StatusIcon status={status || 'TODO'} className="size-4" />;
   }
   return <History className="size-4" />;
}

function PendingAttachmentList({
   files,
   className,
   onRemove,
}: {
   files: File[];
   className?: string;
   onRemove: (index: number) => void;
}) {
   const previews = useMemo(
      () =>
         files.map((file, index) => ({
            file,
            index,
            url: URL.createObjectURL(file),
         })),
      [files]
   );

   useEffect(() => {
      return () => previews.forEach((preview) => URL.revokeObjectURL(preview.url));
   }, [previews]);

   if (!files.length) return null;

   return (
      <div className={cn('flex flex-wrap gap-2', className)}>
         {previews.map(({ file, index, url }) => (
            <div
               key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
               className="group w-full max-w-64 overflow-hidden rounded-md border border-white/8 bg-[#151517]"
            >
               <AttachmentPreviewSurface
                  attachment={{
                     name: file.name,
                     url,
                     mimeType: file.type,
                     sizeBytes: file.size,
                  }}
                  compact
               />
               <div className="flex items-center justify-between gap-2 border-t border-white/7 px-2.5 py-1.5">
                  <span className="min-w-0 truncate text-xs text-zinc-400">{file.name}</span>
                  <button
                     aria-label={fa.issue.removeAttachment}
                     className="shrink-0 rounded-full p-1 text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200"
                     type="button"
                     onClick={() => onRemove(index)}
                  >
                     <X className="size-3.5" />
                  </button>
               </div>
            </div>
         ))}
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
      <div className={cn(compact ? 'flex flex-wrap gap-2' : 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3', className)}>
         {attachments.map((attachment) => (
            <a
               key={attachment.id}
               className={cn(
                  'group overflow-hidden border border-white/8 bg-[#19191b] text-zinc-400 shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] transition hover:border-white/14 hover:bg-[#1d1d20] hover:text-zinc-200',
                  compact ? 'w-full max-w-64 rounded-md bg-[#151517]' : 'rounded-lg'
               )}
               href={attachment.url}
               rel="noreferrer"
               target="_blank"
            >
               <AttachmentPreviewSurface attachment={attachment} compact={compact} />
               <div className="flex min-w-0 items-center gap-2 border-t border-white/7 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{attachment.name}</span>
                  {attachment.sizeBytes ? (
                     <span className="shrink-0 text-[11px] text-zinc-600">
                        {formatFileSize(attachment.sizeBytes)}
                     </span>
                  ) : null}
                  <ExternalLink className="size-3.5 shrink-0 text-zinc-600 transition group-hover:text-zinc-300" />
               </div>
            </a>
         ))}
      </div>
   );
}

function AttachmentPreviewSurface({
   attachment,
   compact = false,
}: {
   attachment: PreviewableAttachment;
   compact?: boolean;
}) {
   const [previewFailed, setPreviewFailed] = useState(false);
   const kind = attachmentPreviewKind(attachment);
   const heightClassName = compact ? 'h-16' : 'h-28';

   if (kind === 'image' && !previewFailed) {
      return (
         <div className={cn('overflow-hidden bg-black/20', heightClassName)}>
            <img
               alt={attachment.name}
               className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
               loading="lazy"
               onError={() => setPreviewFailed(true)}
               src={attachment.url}
            />
         </div>
      );
   }

   if (kind === 'video' && !previewFailed) {
      return (
         <div className={cn('overflow-hidden bg-black/25', heightClassName)}>
            <video
               className="h-full w-full object-cover"
               muted
               preload="metadata"
               src={attachment.url}
               onError={() => setPreviewFailed(true)}
            />
         </div>
      );
   }

   if (kind === 'pdf') {
      return (
         <div className={cn('overflow-hidden bg-zinc-950', heightClassName)}>
            <iframe
               className="pointer-events-none h-full w-full border-0 bg-zinc-950"
               src={`${attachment.url}#toolbar=0&navpanes=0&scrollbar=0`}
               title={attachment.name}
            />
         </div>
      );
   }

   const Icon = kind === 'archive' ? FileArchive : kind === 'text' ? FileText : ImageIcon;

   return (
      <div className={cn('flex flex-col items-center justify-center gap-1.5 bg-white/[0.025]', heightClassName)}>
         <Icon className={cn('text-zinc-500', compact ? 'size-5' : 'size-7')} />
         <span className="max-w-[80%] truncate text-[11px] uppercase tracking-[0.08em] text-zinc-600">
            {attachmentExtension(attachment.name) || fileKindLabel(attachment)}
         </span>
      </div>
   );
}

function activityTitle(activity: TaskaraActivity): string {
   switch (activity.action) {
      case 'created':
         return 'کار را ایجاد کرد';
      case 'updated':
         return 'کار را به‌روزرسانی کرد';
      case 'attachment_added':
         return 'پیوست اضافه کرد';
      case 'comment_attachment_added':
         return 'پیوست به دیدگاه اضافه کرد';
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

function attachmentPreviewKind(
   attachment: PreviewableAttachment
): 'image' | 'video' | 'pdf' | 'archive' | 'text' | 'file' {
   const mimeType = attachment.mimeType?.toLowerCase() || '';
   const extension = attachmentExtension(attachment.name);
   if (mimeType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'].includes(extension)) {
      return 'image';
   }
   if (mimeType.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(extension)) return 'video';
   if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
   if (mimeType.includes('zip') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) {
      return 'archive';
   }
   if (mimeType.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'log'].includes(extension)) return 'text';
   return 'file';
}

function attachmentExtension(name: string): string {
   const extension = name.split('.').pop();
   return extension && extension !== name ? extension.toLowerCase() : '';
}

function fileKindLabel(attachment: PreviewableAttachment): string {
   if (attachment.mimeType) return attachment.mimeType.split('/').pop() || 'file';
   return 'file';
}

function SidebarIconButton({
   ariaLabel,
   children,
   disabled = false,
   onClick,
}: {
   ariaLabel: string;
   children: React.ReactNode;
   disabled?: boolean;
   onClick?: () => void;
}) {
   if (!onClick) {
      return (
         <span
            aria-hidden="true"
            className="inline-flex size-9 items-center justify-center rounded-full border border-white/8 bg-white/[0.05] text-zinc-500 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]"
            title={ariaLabel}
         >
            {children}
         </span>
      );
   }

   return (
      <button
         aria-label={ariaLabel}
         className="inline-flex size-9 items-center justify-center rounded-full border border-white/8 bg-white/[0.05] text-zinc-400 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition hover:bg-white/8 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/[0.05] disabled:hover:text-zinc-400"
         disabled={disabled}
         title={ariaLabel}
         type="button"
         onClick={onClick}
      >
         {children}
      </button>
   );
}

function SidebarSection({
   title,
   className,
   children,
}: {
   title: string;
   className?: string;
   children: React.ReactNode;
}) {
   return (
      <section className={cn('overflow-hidden rounded-lg border border-white/8 bg-[#19191b]', className)}>
         <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-zinc-400">
            <span>{title}</span>
         </div>
         {children}
      </section>
   );
}

function SidebarSelectRow({
   icon,
   label,
   muted = false,
   children,
}: {
   icon: React.ReactNode;
   label: string;
   muted?: boolean;
   children: React.ReactNode;
}) {
   return (
      <label className="relative flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-white/5">
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className={cn('min-w-0 flex-1 truncate text-base', muted ? 'text-zinc-500' : 'text-zinc-100')}>
            {label}
         </span>
         {children}
      </label>
   );
}

function SidebarEmptyRow({ icon, label }: { icon: React.ReactNode; label: string }) {
   return (
      <div className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-base text-zinc-500 transition hover:bg-white/5">
         <span className="flex size-5 shrink-0 items-center justify-center text-zinc-500">{icon}</span>
         <span className="truncate">{label}</span>
      </div>
   );
}
