'use client';

import type { ButtonHTMLAttributes, ChangeEvent, FormEvent } from 'react';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
   ArrowRight,
   BookOpen,
   Box,
   Check,
   CheckCircle2,
   Copy,
   ExternalLink,
   FileArchive,
   FileText,
   GitPullRequest,
   History,
   ImageIcon,
   Link2,
   Loader2,
   MessageSquareWarning,
   MoreHorizontal,
   Paperclip,
   RotateCcw,
   Search,
   Send,
   Sparkles,
   Tag,
   UserRoundCheck,
   X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DescriptionEditor } from '@/components/taskara/description-editor';
import { SmsConfirmDialog } from '@/components/taskara/sms-confirm-dialog';
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
import { editorValueToPlainText, suggestTaskText, type TaskTextSuggestionResult } from '@/lib/task-text-ai';
import { taskaraRequest, uploadTaskAttachment, uploadTaskCommentAttachment } from '@/lib/taskara-client';
import { sendTaskSyncMutation } from '@/lib/task-sync';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskPriorities, taskStatuses, taskWeights } from '@/lib/taskara-presenters';
import type {
   PaginatedResponse,
   TaskaraActivity,
   TaskaraAssignmentRecommendation,
   TaskaraAssignmentRecommendationResponse,
   TaskaraAttachment,
   TaskaraKnowledgeReference,
   TaskaraProject,
   TaskaraTask,
   TaskaraTaskComment,
   TaskaraTaskReview,
   TaskaraUser,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { selectIssueDetail } from '@/lib/workspace-data/selectors';
import { useAuthSession } from '@/store/auth-store';

type TaskUpdatePatch = {
   title?: string;
   description?: string | null;
   status?: string;
   priority?: string;
   weight?: number | null;
   assigneeId?: string | null;
   projectId?: string | null;
   dueAt?: string | null;
};

type IssueProjectOption = Pick<TaskaraProject, 'id' | 'name' | 'keyPrefix' | 'team'>;
type SavingField = 'title' | 'description' | null;
type SmsSendingKind = 'taskCreated' | 'followUp';
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

const assigneeSearchPlaceholder = 'جستجو بین کارمندان...';
const noAssigneeSearchResult = 'کارمندی پیدا نشد';
const projectSearchPlaceholder = 'جستجو بین پروژه‌ها...';
const noProjectSearchResult = 'پروژه‌ای پیدا نشد';

function filterIssueAssigneeUsers(users: TaskaraUser[], query: string) {
   const normalizedQuery = query.trim().toLocaleLowerCase('fa');
   if (!normalizedQuery) return users;
   return users.filter((user) =>
      [user.name, user.email, user.mattermostUsername || '']
         .join(' ')
         .toLocaleLowerCase('fa')
         .includes(normalizedQuery)
   );
}

function filterIssueProjects(projects: IssueProjectOption[], query: string) {
   const normalizedQuery = query.trim().toLocaleLowerCase('fa');
   if (!normalizedQuery) return projects;
   return projects.filter((project) =>
      [project.name, project.keyPrefix, project.team?.name || '']
         .join(' ')
         .toLocaleLowerCase('fa')
         .includes(normalizedQuery)
   );
}

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

function isSameIssueTask(left: TaskaraTask, right: TaskaraTask) {
   return left.id === right.id || Boolean(left.key && right.key && left.key === right.key);
}

function mergeIssueDetailTask(current: TaskaraTask | null, incoming: TaskaraTask): TaskaraTask {
   if (!current || !isSameIssueTask(current, incoming)) return incoming;

   return {
      ...current,
      ...incoming,
      attachments: incoming.attachments ?? current.attachments,
      blockedTasks: incoming.blockedTasks ?? current.blockedTasks,
      blockingDependencies: incoming.blockingDependencies ?? current.blockingDependencies,
      comments: incoming.comments ?? current.comments,
      labels: incoming.labels ?? current.labels,
      subtasks: incoming.subtasks ?? current.subtasks,
   };
}

function mergeReviews(current: TaskaraTaskReview[], incoming: TaskaraTaskReview[]): TaskaraTaskReview[] {
   const byId = new Map<string, TaskaraTaskReview>();
   for (const review of current) byId.set(review.id, review);
   for (const review of incoming) byId.set(review.id, { ...byId.get(review.id), ...review });
   return [...byId.values()].sort((left, right) => Date.parse(right.requestedAt) - Date.parse(left.requestedAt));
}

export function IssuePage() {
   const { session } = useAuthSession();
   const location = useLocation();
   const navigate = useNavigate();
   const { orgId, taskKey } = useParams();
   const taskSync = useWorkspaceTaskSync();
   const [task, setTask] = useState<TaskaraTask | null>(null);
   const [activities, setActivities] = useState<TaskaraActivity[]>([]);
   const [relatedDocs, setRelatedDocs] = useState<TaskaraKnowledgeReference[]>([]);
   const [reviews, setReviews] = useState<TaskaraTaskReview[]>([]);
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
   const [aiSuggestionLoading, setAiSuggestionLoading] = useState(false);
   const [aiSuggestion, setAiSuggestion] = useState<TaskTextSuggestionResult | null>(null);
   const [aiApplying, setAiApplying] = useState(false);
   const [commentSubmitting, setCommentSubmitting] = useState(false);
   const [assignmentLoading, setAssignmentLoading] = useState(false);
   const [assignmentRecommendations, setAssignmentRecommendations] = useState<TaskaraAssignmentRecommendationResponse | null>(null);
   const [triageDraft, setTriageDraft] = useState('');
   const [triageSubmitting, setTriageSubmitting] = useState<'accept' | 'request-info' | 'decline' | null>(null);
   const [reviewSubmitting, setReviewSubmitting] = useState(false);
   const [reviewCommentDraft, setReviewCommentDraft] = useState('');
   const [selectedReviewerId, setSelectedReviewerId] = useState('');
   const [smsSending, setSmsSending] = useState<SmsSendingKind | null>(null);
   const [smsConfirmKind, setSmsConfirmKind] = useState<SmsSendingKind | null>(null);
   const titleFocusedRef = useRef(false);
   const descriptionFocusedRef = useRef(false);
   const descriptionFileInputRef = useRef<HTMLInputElement>(null);
   const commentFileInputRef = useRef<HTMLInputElement>(null);
   const fallbackIssuesPath = `/${orgId || 'taskara'}/team/all/all`;
   const currentPath = `${location.pathname}${location.search}${location.hash}`;
   const returnPath = getIssueReturnPath(location.state);
   const issueData = useMemo(
      () => selectIssueDetail(taskSync.workspaceData, taskKey),
      [taskKey, taskSync.workspaceData]
   );
   const cachedTask = issueData.task;
   const cachedTaskRef = useRef<TaskaraTask | null>(null);
   const syncUsersRef = useRef<TaskaraUser[]>([]);
   const loadRequestRef = useRef(0);
   const relatedDocsRequestRef = useRef(0);
   const reviewsRequestRef = useRef(0);

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

   const loadRelatedDocs = useCallback(async (taskId: string) => {
      const requestId = ++relatedDocsRequestRef.current;
      try {
         const params = new URLSearchParams({ type: 'TASK', targetId: taskId });
         const references = await taskaraRequest<TaskaraKnowledgeReference[]>(
            `/knowledge/references?${params.toString()}`
         );
         if (requestId === relatedDocsRequestRef.current) setRelatedDocs(references);
      } catch {
         if (requestId === relatedDocsRequestRef.current) setRelatedDocs([]);
      }
   }, []);

   const loadReviews = useCallback(async (idOrKey: string) => {
      const requestId = ++reviewsRequestRef.current;
      try {
         const result = await taskaraRequest<TaskaraTaskReview[]>(
            `/tasks/${encodeURIComponent(idOrKey)}/reviews`
         );
         if (requestId === reviewsRequestRef.current) setReviews(result);
      } catch {
         if (requestId === reviewsRequestRef.current) setReviews([]);
      }
   }, []);

   useEffect(() => {
      cachedTaskRef.current = cachedTask;
      if (!cachedTask) return;
      setTask((current) => mergeIssueDetailTask(current, cachedTask));
      if (!titleFocusedRef.current) setTitleDraft(cachedTask.title);
      if (!descriptionFocusedRef.current) setDescriptionDraft(cachedTask.description || '');
      setAiSuggestion(null);
      setAiSuggestionLoading(false);
      setLoading(false);
   }, [cachedTask]);

   useEffect(() => {
      syncUsersRef.current = issueData.users;
      if (issueData.users.length) setUsers(issueData.users);
   }, [issueData.users]);

   useEffect(() => {
      if (!issueData.reviews.length) return;
      setReviews((current) => mergeReviews(current, issueData.reviews));
   }, [issueData.reviews]);

   const projectOptions = useMemo<IssueProjectOption[]>(() => {
      const options = issueData.projects.map((project) => ({
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
   }, [issueData.projects, task?.project]);

   const load = useCallback(async () => {
      if (!taskKey) return;
      const requestId = ++loadRequestRef.current;
      const cachedTask = cachedTaskRef.current;
      const syncUsers = syncUsersRef.current;
      if (cachedTask) {
         setTask((current) => mergeIssueDetailTask(current, cachedTask));
         if (!titleFocusedRef.current) setTitleDraft(cachedTask.title);
         if (!descriptionFocusedRef.current) setDescriptionDraft(cachedTask.description || '');
         if (syncUsers.length) setUsers(syncUsers);
         setLoading(false);
      } else {
         setTask(null);
         setActivities([]);
         setRelatedDocs([]);
         if (!titleFocusedRef.current) setTitleDraft('');
         if (!descriptionFocusedRef.current) setDescriptionDraft('');
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
         if (requestId !== loadRequestRef.current) return;
         setTask(taskResult);
         if (!titleFocusedRef.current) setTitleDraft(taskResult.title);
         if (!descriptionFocusedRef.current) setDescriptionDraft(taskResult.description || '');
         setUsers(usersResult.items);
         setProjects(projectsResult);
         setActivities(activityResult);
      } catch (err) {
         if (requestId === loadRequestRef.current && !cachedTask) {
            setError(err instanceof Error ? err.message : fa.issue.loadFailed);
         }
      } finally {
         if (requestId === loadRequestRef.current) setLoading(false);
      }
   }, [taskKey]);

   useEffect(() => {
      void load();
   }, [load]);

   useEffect(() => {
      if (!task?.id) {
         relatedDocsRequestRef.current += 1;
         setRelatedDocs([]);
         return;
      }
      void loadRelatedDocs(task.id);
   }, [loadRelatedDocs, task?.id]);

   useEffect(() => {
      const idOrKey = task?.key || taskKey;
      if (!idOrKey) {
         reviewsRequestRef.current += 1;
         setReviews([]);
         return;
      }
      void loadReviews(idOrKey);
   }, [loadReviews, task?.key, taskKey]);

   useEffect(() => {
      if (selectedReviewerId && users.some((user) => user.id === selectedReviewerId)) return;
      const currentUserId = session?.user.id;
      const fallbackReviewer =
         users.find((user) => user.id !== currentUserId && user.id !== task?.assignee?.id) ||
         users.find((user) => user.id !== currentUserId) ||
         users[0];
      setSelectedReviewerId(fallbackReviewer?.id || '');
   }, [selectedReviewerId, session?.user.id, task?.assignee?.id, users]);

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
         const updated = await taskSync.updateTask(task, patch);
         setTask((current) => (current ? { ...current, ...updated } : updated));
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

   async function requestAiSuggestion() {
      if (aiSuggestionLoading) return;
      const title = titleDraft.trim();
      const description = editorValueToPlainText(descriptionDraft);
      if (!title && !description) {
         toast.error('ابتدا عنوان یا توضیحی برای بهبود وارد کنید.');
         return;
      }

      setAiSuggestionLoading(true);
      try {
         const suggestion = await suggestTaskText({ title, description });
         if (!suggestion.titleSuggestion && !suggestion.descriptionSuggestion && !suggestion.summarySuggestion) {
            toast.message('پیشنهاد جدیدی برای این متن پیدا نشد.');
         }
         setAiSuggestion(suggestion);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : 'دریافت پیشنهاد AI ناموفق بود.');
      } finally {
         setAiSuggestionLoading(false);
      }
   }

   async function applyAiSuggestion(
      next: Partial<Pick<TaskTextSuggestionResult, 'titleSuggestion' | 'descriptionSuggestion'>>
   ) {
      if (!task || aiApplying) return;
      const patch: TaskUpdatePatch = {};
      let nextTitleDraft = titleDraft;
      let nextDescriptionDraft = descriptionDraft;

      if ('titleSuggestion' in next) {
         const currentTitle = task.title.trim();
         const nextTitle = (next.titleSuggestion ?? '').trim();
         if (nextTitle && nextTitle !== currentTitle) patch.title = nextTitle;
         nextTitleDraft = nextTitle || nextTitleDraft;
      }

      if ('descriptionSuggestion' in next) {
         const currentDescription = task.description?.trim() || '';
         const nextDescription = (next.descriptionSuggestion ?? '').trim();
         if (nextDescription !== currentDescription) patch.description = nextDescription || null;
         nextDescriptionDraft = nextDescription;
      }

      if (!Object.keys(patch).length) {
         toast.message('تغییری برای اعمال وجود ندارد.');
         return;
      }

      setAiApplying(true);
      try {
         if ('titleSuggestion' in next) setTitleDraft(nextTitleDraft);
         if ('descriptionSuggestion' in next) setDescriptionDraft(nextDescriptionDraft);
         const updated = await updateTask(patch);
         if (updated) {
            if ('titleSuggestion' in next) setTitleDraft(updated.title);
            if ('descriptionSuggestion' in next) setDescriptionDraft(updated.description || '');
            toast.success('پیشنهاد AI اعمال شد.');
         }
      } finally {
         setAiApplying(false);
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

   const uploadInlineDescriptionAttachments = useCallback(
      async (files: File[]) => {
         if (!task || files.length === 0) return [] as TaskaraAttachment[];

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
            return uploaded;
         } finally {
            setDescriptionUploading(false);
         }
      },
      [loadActivity, task]
   );

   const uploadDescriptionInlineImages = useCallback(
      async (files: File[]) => {
         const uploaded = await uploadInlineDescriptionAttachments(files);
         return uploaded.map((attachment) => ({
            altText: attachment.name,
            src: attachment.url,
         }));
      },
      [uploadInlineDescriptionAttachments]
   );

   const uploadDescriptionInlineFiles = useCallback(
      async (files: File[]) => {
         const uploaded = await uploadInlineDescriptionAttachments(files);
         return uploaded.map((attachment) => ({
            kind:
               (attachment.mimeType || '').toLowerCase().startsWith('audio/') ||
               (attachment.mimeType || '').toLowerCase().startsWith('video/')
                  ? ('media' as const)
                  : ('file' as const),
            mimeType: attachment.mimeType || undefined,
            name: attachment.name,
            sizeBytes: attachment.sizeBytes ?? undefined,
            src: attachment.url,
         }));
      },
      [uploadInlineDescriptionAttachments]
   );

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

   async function loadAssignmentRecommendations() {
      if (!task || assignmentLoading || !task.project?.id) return;

      setAssignmentLoading(true);
      try {
         const result = await taskaraRequest<TaskaraAssignmentRecommendationResponse>('/assignment/recommend', {
            method: 'POST',
            body: JSON.stringify({
               taskIdOrKey: task.key,
               projectId: task.project.id,
               priority: task.priority,
               weight: task.weight ?? undefined,
               dueAt: task.dueAt ?? undefined,
               limit: 5,
            }),
         });
         setAssignmentRecommendations(result);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.assignmentRecommendationFailed);
      } finally {
         setAssignmentLoading(false);
      }
   }

   async function acceptAssignmentRecommendation(recommendation: TaskaraAssignmentRecommendation) {
      if (!task || assignmentLoading) return;
      setAssignmentLoading(true);
      try {
         const updated = await updateTask({ assigneeId: recommendation.user.id });
         if (updated) {
            setAssignmentRecommendations((current) =>
               current
                  ? {
                       ...current,
                       task: {
                          id: updated.id,
                          key: updated.key,
                          title: updated.title,
                          assigneeId: updated.assignee?.id || null,
                       },
                    }
                  : current
            );
            toast.success(fa.issue.assignedRecommendedUser);
         }
      } finally {
         setAssignmentLoading(false);
      }
   }

   async function runTriageAction(action: 'accept' | 'request-info' | 'decline') {
      if (!task || triageSubmitting || task.status !== 'BACKLOG') return;
      const note = triageDraft.trim();
      if ((action !== 'accept' || !task.assignee) && note.length < 3) return;
      if (action === 'accept' && task.priority === 'NO_PRIORITY') {
         toast.error(fa.issue.triagePriorityRequired);
         return;
      }

      setTriageSubmitting(action);
      try {
         const body =
            action === 'accept'
               ? {
                    assigneeId: task.assignee?.id || undefined,
                    priority: task.priority,
                    weight: task.weight ?? undefined,
                    dueAt: task.dueAt ?? undefined,
                    unassignedReason: task.assignee ? undefined : note,
                    comment: task.assignee ? note || undefined : undefined,
                 }
               : action === 'request-info'
                 ? { comment: note }
                 : { reason: note };
         const updated = await taskaraRequest<TaskaraTask>(
            `/triage/tasks/${encodeURIComponent(task.key)}/${action}`,
            {
               method: 'POST',
               body: JSON.stringify(body),
            }
         );
         setTask((current) => mergeIssueDetailTask(current, updated));
         setTriageDraft('');
         await loadActivity(updated.key || task.key);
         toast.success(action === 'accept' ? fa.issue.triageAccepted : action === 'request-info' ? fa.issue.triageInfoRequested : fa.issue.triageDeclined);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.triageActionFailed);
      } finally {
         setTriageSubmitting(null);
      }
   }

   function mergeReviewResult(review: TaskaraTaskReview) {
      setReviews((current) => [review, ...current.filter((item) => item.id !== review.id)]);
      if (review.task) {
         setTask((current) => mergeIssueDetailTask(current, review.task as TaskaraTask));
      }
   }

   async function requestReview() {
      if (!task || !selectedReviewerId || reviewSubmitting) return;

      setReviewSubmitting(true);
      try {
         const review = await taskaraRequest<TaskaraTaskReview>(
            `/tasks/${encodeURIComponent(task.key)}/reviews`,
            {
               method: 'POST',
               body: JSON.stringify({
                  reviewerId: selectedReviewerId,
                  comment: reviewCommentDraft.trim() || undefined,
               }),
            }
         );
         mergeReviewResult(review);
         setReviewCommentDraft('');
         await Promise.all([loadActivity(task.key), loadReviews(task.key)]);
         toast.success(fa.issue.reviewRequested);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.reviewRequestFailed);
      } finally {
         setReviewSubmitting(false);
      }
   }

   async function decideReview(review: TaskaraTaskReview, action: 'approve' | 'request-changes' | 'cancel') {
      if (!task || reviewSubmitting) return;

      setReviewSubmitting(true);
      try {
         const updated = await taskaraRequest<TaskaraTaskReview>(
            `/reviews/${encodeURIComponent(review.id)}/${action}`,
            {
               method: 'POST',
               body: JSON.stringify({ comment: reviewCommentDraft.trim() || undefined }),
            }
         );
         mergeReviewResult(updated);
         setReviewCommentDraft('');
         await Promise.all([loadActivity(task.key), loadReviews(task.key)]);
         toast.success(fa.issue.reviewDecisionSaved);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.reviewDecisionFailed);
      } finally {
         setReviewSubmitting(false);
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

   async function sendTaskSms(kind: SmsSendingKind) {
      if (!task) return;
      if (!task.assignee) {
         toast.error(fa.issue.smsNoAssignee);
         return;
      }
      if (!task.assignee.phone) {
         toast.error(fa.issue.smsNoPhone);
         return;
      }

      const endpoint = kind === 'taskCreated' ? 'task-created' : 'follow-up';
      const successMessage = kind === 'taskCreated' ? fa.issue.smsSent : fa.issue.smsFollowUpSent;

      setSmsSending(kind);
      try {
         await taskaraRequest<{ sent: true; receptor: string }>(
            `/tasks/${encodeURIComponent(task.key)}/sms/${endpoint}`,
            { method: 'POST' }
         );
         await loadActivity(task.key);
         toast.success(successMessage);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.smsFailed);
      } finally {
         setSmsSending(null);
      }
   }

   function requestSendTaskSms(kind: SmsSendingKind) {
      if (smsSending) return;
      setSmsConfirmKind(kind);
   }

   function confirmSendTaskSms() {
      if (!smsConfirmKind) return;
      const kind = smsConfirmKind;
      setSmsConfirmKind(null);
      void sendTaskSms(kind);
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
   const activeReview = reviews.find((review) => review.status === 'REQUESTED') || null;
   const latestCompletedReview = reviews.find((review) => review.status !== 'REQUESTED') || null;
   const currentUserId = session?.user.id || '';
   const canCancelActiveReview = Boolean(
      activeReview &&
         (session?.role === 'OWNER' ||
            session?.role === 'ADMIN' ||
            activeReview.requesterId === currentUserId ||
            activeReview.reviewerId === currentUserId ||
            task.assignee?.id === currentUserId ||
            task.reporter?.id === currentUserId)
   );

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

            <div className="flex items-start gap-3">
               <div className="relative min-w-0 flex-1">
                  <input
                     className="w-full border-0 bg-transparent p-0 text-right text-2xl font-semibold leading-8 text-zinc-100 outline-none placeholder:text-zinc-600"
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
               <Tooltip>
                  <TooltipTrigger asChild>
                     <button
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-white/12 bg-transparent text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={aiSuggestionLoading || aiApplying}
                        type="button"
                        onClick={() => void requestAiSuggestion()}
                     >
                        {aiSuggestionLoading ? (
                           <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                           <Sparkles className="size-3.5" />
                        )}
                     </button>
                  </TooltipTrigger>
                  <TooltipContent className="border-white/10 bg-[#202023] text-zinc-200" side="bottom">
                     بهبود و خلاصه‌سازی متن با AI
                  </TooltipContent>
               </Tooltip>
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
                     uploadInlineImages={uploadDescriptionInlineImages}
                     onInlineImageUploadError={(err) => {
                        toast.error(err instanceof Error ? err.message : fa.issue.attachmentUploadFailed);
                     }}
                     uploadInlineFiles={uploadDescriptionInlineFiles}
                     onInlineFileUploadError={(err) => {
                        toast.error(err instanceof Error ? err.message : fa.issue.attachmentUploadFailed);
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

               {aiSuggestion ? (
                  <div className="mt-3 rounded-xl border border-indigo-400/25 bg-indigo-500/10 p-3 text-sm">
                     <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-indigo-100">
                           <Sparkles className="size-4" />
                           <span className="font-medium">پیشنهاد هوشمند AI</span>
                        </div>
                        <button
                           className="text-xs text-zinc-400 transition hover:text-zinc-200"
                           type="button"
                           onClick={() => setAiSuggestion(null)}
                        >
                           بستن
                        </button>
                     </div>
                     {aiSuggestion.titleSuggestion ? (
                        <div className="mb-2 rounded-lg border border-white/10 bg-black/15 p-2">
                           <div className="mb-1 text-xs text-zinc-500">عنوان پیشنهادی</div>
                           <p className="whitespace-pre-wrap text-zinc-100">
                              {aiSuggestion.titleSuggestion}
                           </p>
                        </div>
                     ) : null}
                     {aiSuggestion.descriptionSuggestion ? (
                        <div className="mb-2 rounded-lg border border-white/10 bg-black/15 p-2">
                           <div className="mb-1 text-xs text-zinc-500">متن پخته‌تر پیشنهادی</div>
                           <p className="max-h-36 overflow-auto whitespace-pre-wrap text-zinc-200">
                              {aiSuggestion.descriptionSuggestion}
                           </p>
                        </div>
                     ) : null}
                     {aiSuggestion.summarySuggestion ? (
                        <div className="mb-2 rounded-lg border border-white/10 bg-black/15 p-2">
                           <div className="mb-1 text-xs text-zinc-500">خلاصه پیشنهادی</div>
                           <p className="max-h-24 overflow-auto whitespace-pre-wrap text-zinc-200">
                              {aiSuggestion.summarySuggestion}
                           </p>
                        </div>
                     ) : null}
                     <div className="flex flex-wrap items-center gap-2">
                        <button
                           className="inline-flex h-7 items-center rounded-full border border-white/12 bg-white/6 px-3 text-xs text-zinc-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                           disabled={aiApplying}
                           type="button"
                           onClick={() =>
                              void applyAiSuggestion({
                                 titleSuggestion: aiSuggestion.titleSuggestion,
                                 descriptionSuggestion: aiSuggestion.descriptionSuggestion,
                              })
                           }
                        >
                           اعمال همه پیشنهادها
                        </button>
                        {aiSuggestion.titleSuggestion ? (
                           <button
                              className="inline-flex h-7 items-center rounded-full border border-white/12 bg-white/6 px-3 text-xs text-zinc-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={aiApplying}
                              type="button"
                              onClick={() =>
                                 void applyAiSuggestion({
                                    titleSuggestion: aiSuggestion.titleSuggestion,
                                 })
                              }
                           >
                              فقط عنوان
                           </button>
                        ) : null}
                        {aiSuggestion.descriptionSuggestion ? (
                           <button
                              className="inline-flex h-7 items-center rounded-full border border-white/12 bg-white/6 px-3 text-xs text-zinc-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={aiApplying}
                              type="button"
                              onClick={() =>
                                 void applyAiSuggestion({
                                    descriptionSuggestion: aiSuggestion.descriptionSuggestion,
                                 })
                              }
                           >
                              فقط متن
                           </button>
                        ) : null}
                        {aiSuggestion.summarySuggestion ? (
                           <button
                              className="inline-flex h-7 items-center rounded-full border border-white/12 bg-white/6 px-3 text-xs text-zinc-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={aiApplying}
                              type="button"
                              onClick={() =>
                                 void applyAiSuggestion({
                                    descriptionSuggestion: aiSuggestion.summarySuggestion,
                                 })
                              }
                           >
                              فقط خلاصه
                           </button>
                        ) : null}
                     </div>
                  </div>
               ) : null}

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

         <aside className="min-w-0 overflow-y-auto overflow-x-hidden border-s border-white/6 bg-[#141416] p-3">
            <div className="mb-3 flex items-center justify-end gap-2">
               <SidebarIconButton ariaLabel="Copy issue link" onClick={() => void copyIssueUrl()}>
                  <Link2 className="size-4" />
               </SidebarIconButton>
               <SidebarIconButton ariaLabel="Copy issue key" onClick={() => void copyIssueKey()}>
                  <Copy className="size-4" />
               </SidebarIconButton>
               <div className="inline-flex items-center gap-2">
                  <DropdownMenu dir="rtl">
                     <DropdownMenuTrigger asChild>
                        <button
                           aria-label={fa.issue.moreActions}
                           className="inline-flex size-9 items-center justify-center rounded-full border border-white/8 bg-white/[0.05] text-zinc-400 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition hover:bg-white/8 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-indigo-400/35 focus-visible:outline-none"
                           title={fa.issue.moreActions}
                           type="button"
                        >
                           <MoreHorizontal className="size-4" />
                        </button>
                     </DropdownMenuTrigger>
                     <DropdownMenuContent
                        align="end"
                        className="w-60 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl"
                        sideOffset={8}
                     >
                        <DropdownMenuItem
                           className="h-9 cursor-pointer justify-start gap-2 rounded-lg px-2.5 text-sm text-zinc-200 focus:bg-white/[0.07] focus:text-zinc-100"
                           disabled={Boolean(smsSending)}
                           onSelect={() => requestSendTaskSms('taskCreated')}
                        >
                           {smsSending === 'taskCreated' ? (
                              <Loader2 className="size-4 animate-spin text-zinc-400" />
                           ) : (
                              <Send className="size-4 text-zinc-400" />
                           )}
                           <span className="min-w-0 truncate">{fa.issue.sendTaskSms}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                           className="h-9 cursor-pointer justify-start gap-2 rounded-lg px-2.5 text-sm text-zinc-200 focus:bg-white/[0.07] focus:text-zinc-100"
                           disabled={Boolean(smsSending)}
                           onSelect={() => requestSendTaskSms('followUp')}
                        >
                           {smsSending === 'followUp' ? (
                              <Loader2 className="size-4 animate-spin text-zinc-400" />
                           ) : (
                              <History className="size-4 text-zinc-400" />
                           )}
                           <span className="min-w-0 truncate">{fa.issue.sendTaskFollowUpSms}</span>
                        </DropdownMenuItem>
                     </DropdownMenuContent>
                  </DropdownMenu>
                  <SidebarIconButton ariaLabel={fa.app.close} onClick={closeIssuePage}>
                     <X className="size-4" />
                  </SidebarIconButton>
               </div>
            </div>

            <SidebarSection title={fa.issue.properties}>
               <div className="grid gap-1 p-2 text-sm">
                  <IssueSidebarStatusPicker
                     status={task.status}
                     onChange={(status) => void updateTask({ status })}
                  />
                  <IssueSidebarPriorityPicker
                     priority={task.priority}
                     onChange={(priority) => void updateTask({ priority })}
                  />
                  <IssueSidebarAssigneePicker
                     assignee={task.assignee}
                     users={users}
                     onChange={(assigneeId) => void updateTask({ assigneeId })}
                  />
                  <IssueSidebarWeightPicker
                     weight={task.weight}
                     onChange={(weight) => void updateTask({ weight })}
                  />
                  <TaskDueDateControl
                     className="h-auto min-h-9 w-full gap-3 rounded-lg px-2 py-2 text-sm"
                     dueAt={task.dueAt || null}
                     iconClassName="size-5 text-zinc-500"
                     onChange={(dueAt) => void updateTask({ dueAt })}
                  />
               </div>
            </SidebarSection>

            <TriageSidebarPanel
               draft={triageDraft}
               submitting={triageSubmitting}
               task={task}
               onDraftChange={setTriageDraft}
               onRunAction={(action) => void runTriageAction(action)}
            />

            <AssignmentSidebarPanel
               loading={assignmentLoading}
               recommendations={assignmentRecommendations}
               task={task}
               onAccept={(recommendation) => void acceptAssignmentRecommendation(recommendation)}
               onRefresh={() => void loadAssignmentRecommendations()}
            />

            <ReviewSidebarPanel
               activeReview={activeReview}
               canCancelActiveReview={canCancelActiveReview}
               currentUserId={currentUserId}
               latestCompletedReview={latestCompletedReview}
               reviewCommentDraft={reviewCommentDraft}
               reviewSubmitting={reviewSubmitting}
               selectedReviewerId={selectedReviewerId}
               task={task}
               users={users}
               onCommentChange={setReviewCommentDraft}
               onDecideReview={(review, action) => void decideReview(review, action)}
               onRequestReview={() => void requestReview()}
               onReviewerChange={setSelectedReviewerId}
            />

            <SidebarSection title={fa.issue.relatedDocs} className="mt-3">
               <div className="grid gap-1 p-2 text-sm">
                  {relatedDocs.length ? (
                     relatedDocs.map((reference) => (
                        <Link
                           key={reference.id}
                           className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-white/5"
                           to={`/${orgId || 'taskara'}/wiki/${reference.page.space?.key || reference.page.spaceId}/${reference.page.id}`}
                        >
                           <span className="flex size-5 shrink-0 items-center justify-center text-zinc-500">
                              <BookOpen className="size-5" />
                           </span>
                           <span className="min-w-0 flex-1">
                              <span className="block truncate text-base text-zinc-100">{reference.page.title}</span>
                              <span className="block truncate text-xs text-zinc-500">
                                 {reference.page.space?.name || fa.nav.wiki}
                              </span>
                           </span>
                        </Link>
                     ))
                  ) : (
                     <SidebarEmptyRow icon={<BookOpen className="size-5" />} label={fa.issue.noRelatedDocs} />
                  )}
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
                  <IssueSidebarProjectPicker
                     disabled={!projectOptions.length}
                     project={task.project}
                     projects={projectOptions}
                     onChange={(projectId) => {
                        if (projectId === task.project?.id) return;
                        void updateTask({ projectId });
                     }}
                  />
               </div>
            </SidebarSection>
         </aside>
         <SmsConfirmDialog
            confirmLabel={fa.app.confirm}
            description={fa.app.smsConfirmDescription}
            open={Boolean(smsConfirmKind)}
            pending={Boolean(smsSending)}
            title={smsConfirmKind === 'followUp' ? fa.issue.sendTaskFollowUpSms : fa.issue.sendTaskSms}
            onConfirm={confirmSendTaskSms}
            onOpenChange={(open) => {
               if (!open) setSmsConfirmKind(null);
            }}
         />
      </div>
   );
}

function TriageSidebarPanel({
   draft,
   submitting,
   task,
   onDraftChange,
   onRunAction,
}: {
   draft: string;
   submitting: 'accept' | 'request-info' | 'decline' | null;
   task: TaskaraTask;
   onDraftChange: (value: string) => void;
   onRunAction: (action: 'accept' | 'request-info' | 'decline') => void;
}) {
   if (task.status !== 'BACKLOG') return null;

   const noteRequired = !task.assignee;
   const noteReady = draft.trim().length >= 3;
   const acceptDisabled = Boolean(submitting) || task.priority === 'NO_PRIORITY' || (noteRequired && !noteReady);
   const noteActionDisabled = Boolean(submitting) || !noteReady;

   return (
      <SidebarSection title={fa.issue.triage} className="mt-3">
         <div className="grid gap-2 p-2 text-sm">
            <div className="rounded-lg border border-amber-400/15 bg-amber-400/8 px-2.5 py-2 text-xs leading-5 text-amber-100">
               {task.priority === 'NO_PRIORITY'
                  ? fa.issue.triageNeedsPriority
                  : noteRequired
                    ? fa.issue.triageNeedsOwnerOrReason
                    : fa.issue.triageReady}
            </div>
            <Textarea
               className="min-h-16 resize-none border-white/8 bg-[#141416] text-xs leading-5 text-zinc-300 placeholder:text-zinc-600 focus-visible:ring-amber-400/25"
               placeholder={noteRequired ? fa.issue.triageUnassignedReasonPlaceholder : fa.issue.triageCommentPlaceholder}
               value={draft}
               onChange={(event) => onDraftChange(event.target.value)}
            />
            <div className="grid grid-cols-3 gap-1.5">
               <button
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 text-xs font-medium text-emerald-100 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={acceptDisabled}
                  type="button"
                  onClick={() => onRunAction('accept')}
               >
                  {submitting === 'accept' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  {fa.issue.triageAccept}
               </button>
               <button
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-sky-400/20 bg-sky-400/10 px-2 text-xs font-medium text-sky-100 hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={noteActionDisabled}
                  type="button"
                  onClick={() => onRunAction('request-info')}
               >
                  {submitting === 'request-info' ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareWarning className="size-3.5" />}
                  {fa.issue.triageRequestInfo}
               </button>
               <button
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-rose-400/20 bg-rose-400/10 px-2 text-xs font-medium text-rose-100 hover:bg-rose-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={noteActionDisabled}
                  type="button"
                  onClick={() => onRunAction('decline')}
               >
                  {submitting === 'decline' ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                  {fa.issue.triageDecline}
               </button>
            </div>
         </div>
      </SidebarSection>
   );
}

function AssignmentSidebarPanel({
   loading,
   recommendations,
   task,
   onAccept,
   onRefresh,
}: {
   loading: boolean;
   recommendations: TaskaraAssignmentRecommendationResponse | null;
   task: TaskaraTask;
   onAccept: (recommendation: TaskaraAssignmentRecommendation) => void;
   onRefresh: () => void;
}) {
   const disabled = loading || !task.project?.id || ['DONE', 'CANCELED'].includes(task.status);
   const items = recommendations?.recommendations || [];

   return (
      <SidebarSection title={fa.issue.assignmentAssistant} className="mt-3">
         <div className="grid gap-2 p-2 text-sm">
            <button
               className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-indigo-400/20 bg-indigo-400/10 px-2 text-xs font-medium text-indigo-100 hover:bg-indigo-400/15 disabled:cursor-not-allowed disabled:opacity-50"
               disabled={disabled}
               type="button"
               onClick={onRefresh}
            >
               {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
               {items.length ? fa.issue.refreshAssignmentRecommendations : fa.issue.loadAssignmentRecommendations}
            </button>

            {items.length ? (
               <div className="divide-y divide-white/7 overflow-hidden rounded-lg border border-white/7">
                  {items.map((item) => (
                     <AssignmentRecommendationRow
                        key={item.user.id}
                        disabled={loading || task.assignee?.id === item.user.id}
                        item={item}
                        onAccept={() => onAccept(item)}
                     />
                  ))}
               </div>
            ) : recommendations ? (
               <SidebarEmptyRow icon={<UserRoundCheck className="size-5" />} label={fa.issue.noAssignmentRecommendations} />
            ) : null}
         </div>
      </SidebarSection>
   );
}

function AssignmentRecommendationRow({
   disabled,
   item,
   onAccept,
}: {
   disabled: boolean;
   item: TaskaraAssignmentRecommendation;
   onAccept: () => void;
}) {
   const primaryReason = item.reasons[0];

   return (
      <div className="grid gap-2 bg-[#171719] px-2.5 py-2.5">
         <div className="flex min-w-0 items-center gap-2">
            <LinearAvatar name={item.user.name} src={item.user.avatarUrl} className="size-6" />
            <div className="min-w-0 flex-1">
               <div className="truncate text-sm font-medium text-zinc-100">{item.user.name}</div>
               <div className="truncate text-[11px] text-zinc-500">
                  {fa.issue.assignmentLoad(item.projectedWeight, item.capacity)}
               </div>
            </div>
            <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px]', assignmentStatusClasses[item.status])}>
               {assignmentStatusLabels[item.status]}
            </span>
         </div>

         <div className="h-1.5 overflow-hidden rounded-full bg-white/7">
            <div
               className={cn('h-full rounded-full', assignmentLoadBarClasses[item.status])}
               style={{ width: `${Math.min(item.projectedLoadRatio * 100, 100)}%` }}
            />
         </div>

         <div className="flex min-w-0 items-center justify-between gap-2">
            <span className={cn('min-w-0 truncate text-xs', primaryReason?.tone === 'warning' ? 'text-amber-200' : 'text-zinc-500')}>
               {primaryReason ? assignmentReasonLabel(primaryReason.code) : fa.issue.assignmentReasonFallback}
            </span>
            <button
               className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.035] px-2 text-xs text-zinc-300 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
               disabled={disabled}
               type="button"
               onClick={onAccept}
            >
               <Check className="size-3.5" />
               {fa.issue.assignRecommendedUser}
            </button>
         </div>
      </div>
   );
}

function ReviewSidebarPanel({
   activeReview,
   canCancelActiveReview,
   currentUserId,
   latestCompletedReview,
   reviewCommentDraft,
   reviewSubmitting,
   selectedReviewerId,
   task,
   users,
   onCommentChange,
   onDecideReview,
   onRequestReview,
   onReviewerChange,
}: {
   activeReview: TaskaraTaskReview | null;
   canCancelActiveReview: boolean;
   currentUserId: string;
   latestCompletedReview: TaskaraTaskReview | null;
   reviewCommentDraft: string;
   reviewSubmitting: boolean;
   selectedReviewerId: string;
   task: TaskaraTask;
   users: TaskaraUser[];
   onCommentChange: (value: string) => void;
   onDecideReview: (review: TaskaraTaskReview, action: 'approve' | 'request-changes' | 'cancel') => void;
   onRequestReview: () => void;
   onReviewerChange: (userId: string) => void;
}) {
   const currentUserIsReviewer = activeReview?.reviewerId === currentUserId;
   const canRequestReview = !activeReview && selectedReviewerId && !['DONE', 'CANCELED'].includes(task.status);

   return (
      <SidebarSection title={fa.issue.review} className="mt-3">
         <div className="grid gap-2 p-2 text-sm">
            {activeReview ? (
               <div className="min-w-0 overflow-hidden rounded-lg border border-sky-400/15 bg-sky-400/8 p-2.5">
                  <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
                     <LinearAvatar
                        name={activeReview.reviewer?.name}
                        src={activeReview.reviewer?.avatarUrl}
                        className="size-6 shrink-0"
                     />
                     <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-zinc-100">
                           {activeReview.reviewer?.name || fa.app.unknown}
                        </div>
                        <div className="truncate text-xs text-zinc-500">{fa.issue.reviewer}</div>
                     </div>
                     <ReviewStatusBadge status={activeReview.status} />
                  </div>
                  <div className="mt-2 grid min-w-0 gap-1 overflow-hidden text-xs text-zinc-500">
                     <ReviewMetaRow label={fa.issue.requestedAt} value={formatJalaliDateTime(activeReview.requestedAt)} />
                     {activeReview.dueAt ? (
                        <ReviewMetaRow label={fa.issue.dueAt} value={formatJalaliDateTime(activeReview.dueAt)} />
                     ) : null}
                     {activeReview.comment ? (
                        <p className="mt-1 whitespace-pre-wrap rounded-md border border-white/7 bg-black/15 px-2 py-1.5 text-xs leading-5 text-zinc-300">
                           {activeReview.comment}
                        </p>
                     ) : null}
                  </div>
               </div>
            ) : (
               <ReviewReviewerPicker
                  disabled={reviewSubmitting || ['DONE', 'CANCELED'].includes(task.status)}
                  users={users}
                  value={selectedReviewerId}
                  onChange={onReviewerChange}
               />
            )}

            <Textarea
               className="min-h-16 resize-none border-white/8 bg-[#141416] text-xs leading-5 text-zinc-300 placeholder:text-zinc-600 focus-visible:ring-sky-400/25"
               placeholder={fa.issue.reviewCommentPlaceholder}
               value={reviewCommentDraft}
               onChange={(event) => onCommentChange(event.target.value)}
            />

            {activeReview ? (
               <div className="grid gap-1.5">
                  {currentUserIsReviewer ? (
                     <div className="grid grid-cols-2 gap-1.5">
                        <button
                           className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 text-xs font-medium text-emerald-100 hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                           disabled={reviewSubmitting}
                           type="button"
                           onClick={() => onDecideReview(activeReview, 'approve')}
                        >
                           <CheckCircle2 className="size-3.5" />
                           {fa.issue.approveReview}
                        </button>
                        <button
                           className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 text-xs font-medium text-amber-100 hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                           disabled={reviewSubmitting}
                           type="button"
                           onClick={() => onDecideReview(activeReview, 'request-changes')}
                        >
                           <MessageSquareWarning className="size-3.5" />
                           {fa.issue.requestChanges}
                        </button>
                     </div>
                  ) : null}
                  {canCancelActiveReview ? (
                     <button
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-white/10 bg-white/[0.035] px-2 text-xs text-zinc-300 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={reviewSubmitting}
                        type="button"
                        onClick={() => onDecideReview(activeReview, 'cancel')}
                     >
                        <RotateCcw className="size-3.5" />
                        {fa.issue.cancelReview}
                     </button>
                  ) : null}
               </div>
            ) : (
               <button
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-sky-400/20 bg-sky-400/10 px-2 text-xs font-medium text-sky-100 hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canRequestReview || reviewSubmitting}
                  type="button"
                  onClick={onRequestReview}
               >
                  {reviewSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : <GitPullRequest className="size-3.5" />}
                  {fa.issue.requestReview}
               </button>
            )}

            {!activeReview && latestCompletedReview ? (
               <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-white/7 bg-white/[0.02] px-2 py-1.5">
                  <span className="min-w-0 truncate text-xs text-zinc-500">{formatJalaliDateTime(latestCompletedReview.updatedAt)}</span>
                  <ReviewStatusBadge status={latestCompletedReview.status} />
               </div>
            ) : null}
         </div>
      </SidebarSection>
   );
}

function ReviewReviewerPicker({
   disabled,
   users,
   value,
   onChange,
}: {
   disabled?: boolean;
   users: TaskaraUser[];
   value: string;
   onChange: (userId: string) => void;
}) {
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState('');
   const selected = users.find((user) => user.id === value) || null;
   const filteredUsers = useMemo(() => filterIssueAssigneeUsers(users, query), [query, users]);

   const handleChange = (userId: string) => {
      onChange(userId);
      setOpen(false);
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <SidebarPickerTrigger
               ariaLabel={fa.issue.reviewer}
               disabled={disabled || !users.length}
               muted={!selected}
               icon={
                  selected ? (
                     <LinearAvatar name={selected.name} src={selected.avatarUrl} className="size-5" />
                  ) : (
                     <UserRoundCheck className="size-5 text-zinc-500" />
                  )
               }
               label={selected?.name || fa.issue.reviewer}
               open={open}
            />
         </PopoverTrigger>
         <SidebarPickerContent className="w-80">
            <PickerSearchField
               value={query}
               onChange={setQuery}
               placeholder={assigneeSearchPlaceholder}
            />
            <div className="max-h-72 overflow-y-auto overscroll-contain pe-1">
               {filteredUsers.length ? (
                  filteredUsers.map((user) => (
                     <SidebarPickerOption
                        key={user.id}
                        active={selected?.id === user.id}
                        icon={<LinearAvatar name={user.name} src={user.avatarUrl} className="size-5" />}
                        label={user.name}
                        onClick={() => handleChange(user.id)}
                     />
                  ))
               ) : (
                  <div className="px-3 py-2 text-xs text-zinc-500">{noAssigneeSearchResult}</div>
               )}
            </div>
         </SidebarPickerContent>
      </Popover>
   );
}

function ReviewMetaRow({ label, value }: { label: string; value: string }) {
   return (
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 overflow-hidden">
         <span className="text-zinc-600">{label}</span>
         <span className="min-w-0 truncate text-left text-zinc-400" dir="auto">{value}</span>
      </div>
   );
}

function ReviewStatusBadge({ status }: { status: TaskaraTaskReview['status'] }) {
   return (
      <span className={cn('max-w-24 shrink-0 truncate rounded-full border px-2 py-0.5 text-[11px]', reviewStatusClasses[status])}>
         {reviewStatusLabels[status]}
      </span>
   );
}

const reviewStatusLabels = {
   REQUESTED: 'در انتظار',
   CHANGES_REQUESTED: 'نیازمند تغییر',
   APPROVED: 'تایید شد',
   CANCELED: 'لغو شد',
};

const reviewStatusClasses = {
   REQUESTED: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
   CHANGES_REQUESTED: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
   APPROVED: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
   CANCELED: 'border-zinc-400/15 bg-zinc-400/8 text-zinc-300',
};

const assignmentStatusLabels = {
   available: 'آزاد',
   busy: 'پرکار',
   overloaded: 'اضافه‌بار',
   unavailable: 'غیرفعال',
};

const assignmentStatusClasses = {
   available: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
   busy: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
   overloaded: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
   unavailable: 'border-zinc-400/15 bg-zinc-400/8 text-zinc-300',
};

const assignmentLoadBarClasses = {
   available: 'bg-emerald-400',
   busy: 'bg-amber-400',
   overloaded: 'bg-rose-400',
   unavailable: 'bg-zinc-500',
};

function assignmentReasonLabel(code: string): string {
   switch (code) {
      case 'capacity_available':
         return 'بعد از واگذاری هنوز ظرفیت دارد.';
      case 'no_visible_active_work':
         return 'کار فعال قابل مشاهده‌ای ندارد.';
      case 'project_context':
         return 'در همین پروژه زمینه کاری دارد.';
      case 'busy':
         return 'بعد از واگذاری پرکار می‌شود.';
      case 'over_capacity':
         return 'بعد از واگذاری از ظرفیت عبور می‌کند.';
      case 'zero_capacity':
         return 'ظرفیت این فرد صفر تنظیم شده است.';
      case 'review_load':
         return 'بار بازبینی فعال دارد.';
      case 'blocked_load':
         return 'کار مسدود دارد.';
      case 'due_pressure':
         return 'فشار سررسید دارد.';
      case 'over_wip_limit':
         return 'از حد WIP تیم عبور می‌کند.';
      case 'over_review_wip_limit':
         return 'بار بازبینی از توافق تیم بیشتر است.';
      default:
         return fa.issue.assignmentReasonFallback;
   }
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
         .filter(shouldShowTimelineActivity)
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
      case 'deleted':
         return 'کار را حذف کرد';
      case 'commented':
         return 'دیدگاه ثبت کرد';
      case 'attachment_added':
         return 'پیوست اضافه کرد';
      case 'comment_attachment_added':
         return 'پیوست به دیدگاه اضافه کرد';
      case 'sms_task_created_sent':
         return 'پیامک کار را ارسال کرد';
      case 'sms_task_follow_up_sent':
         return 'پیامک پیگیری کار را ارسال کرد';
      default:
         return 'رویداد ثبت کرد';
   }
}

function getActivityChanges(activity: TaskaraActivity): Array<{ label: string; before: string; after: string }> {
   if (activity.action !== 'updated') return [];
   const before = asRecord(activity.before);
   const after = asRecord(activity.after);
   if (!before || !after) return [];

   const fields = [
      { label: 'عنوان', get: (record: Record<string, unknown>) => formatTextValue(stringValue(record.title)) },
      { label: fa.issue.status, get: (record: Record<string, unknown>) => formatStatus(stringValue(record.status)) },
      { label: fa.issue.priority, get: (record: Record<string, unknown>) => formatPriority(stringValue(record.priority)) },
      { label: fa.issue.weight, get: (record: Record<string, unknown>) => formatWeight(numberValue(record.weight)) },
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

function shouldShowTimelineActivity(activity: TaskaraActivity) {
   if (activity.action === 'commented' || activity.action === 'comment_attachment_added') return false;
   if (isDescriptionOnlyUpdate(activity)) return false;
   return true;
}

function isDescriptionOnlyUpdate(activity: TaskaraActivity) {
   if (activity.action !== 'updated') return false;

   const before = asRecord(activity.before);
   const after = asRecord(activity.after);
   if (!before || !after) return false;

   const changedFields = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => before[key] !== after[key]));
   return changedFields.size === 1 && changedFields.has('description');
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

function formatWeight(value: number | null): string {
   return value === null ? 'بدون وزن' : value.toLocaleString('fa-IR');
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
      <section className={cn('min-w-0 overflow-hidden rounded-lg border border-white/8 bg-[#19191b]', className)}>
         <div className="flex min-w-0 items-center gap-2 px-3 py-2.5 text-sm text-zinc-400">
            <span className="min-w-0 truncate">{title}</span>
         </div>
         {children}
      </section>
   );
}

function IssueSidebarStatusPicker({
   status,
   onChange,
}: {
   status: string;
   onChange: (status: string) => void;
}) {
   const [open, setOpen] = useState(false);
   const handleChange = (nextStatus: string) => {
      onChange(nextStatus);
      setOpen(false);
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <SidebarPickerTrigger
               ariaLabel={fa.issue.status}
               icon={<StatusIcon status={status} className="size-5" />}
               label={linearStatusMeta[status]?.label || status}
               open={open}
            />
         </PopoverTrigger>
         <SidebarPickerContent className="w-72">
            {taskStatuses.map((item) => (
               <SidebarPickerOption
                  key={item}
                  active={status === item}
                  icon={<StatusIcon status={item} className="size-4" />}
                  label={linearStatusMeta[item]?.label || item}
                  onClick={() => handleChange(item)}
               />
            ))}
         </SidebarPickerContent>
      </Popover>
   );
}

function IssueSidebarPriorityPicker({
   priority,
   onChange,
}: {
   priority: string;
   onChange: (priority: string) => void;
}) {
   const [open, setOpen] = useState(false);
   const handleChange = (nextPriority: string) => {
      onChange(nextPriority);
      setOpen(false);
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <SidebarPickerTrigger
               ariaLabel={fa.issue.priority}
               muted={priority === 'NO_PRIORITY'}
               icon={<PriorityIcon priority={priority} className="size-5" />}
               label={
                  priority === 'NO_PRIORITY'
                     ? fa.issue.priority
                     : linearPriorityMeta[priority]?.label || priority
               }
               open={open}
            />
         </PopoverTrigger>
         <SidebarPickerContent className="w-72">
            {taskPriorities.map((item) => (
               <SidebarPickerOption
                  key={item}
                  active={priority === item}
                  icon={<PriorityIcon priority={item} className="size-4" />}
                  label={linearPriorityMeta[item]?.label || item}
                  onClick={() => handleChange(item)}
               />
            ))}
         </SidebarPickerContent>
      </Popover>
   );
}

function IssueSidebarWeightPicker({
   weight,
   onChange,
}: {
   weight?: number | null;
   onChange: (weight: number | null) => void;
}) {
   const [open, setOpen] = useState(false);
   const handleChange = (nextWeight: number | null) => {
      onChange(nextWeight);
      setOpen(false);
   };
   const unset = weight === null || weight === undefined;

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <SidebarPickerTrigger
               ariaLabel={fa.issue.weight}
               muted={unset}
               icon={<Box className="size-5 text-zinc-500" />}
               label={unset ? 'بدون وزن' : weight.toLocaleString('fa-IR')}
               open={open}
            />
         </PopoverTrigger>
         <SidebarPickerContent className="w-56">
            <SidebarPickerOption
               active={unset}
               icon={<Box className="size-4 text-zinc-500" />}
               label="بدون وزن"
               onClick={() => handleChange(null)}
            />
            {taskWeights.map((item) => (
               <SidebarPickerOption
                  key={item}
                  active={weight === item}
                  icon={<Box className="size-4 text-zinc-400" />}
                  label={item.toLocaleString('fa-IR')}
                  onClick={() => handleChange(item)}
               />
            ))}
         </SidebarPickerContent>
      </Popover>
   );
}

function IssueSidebarAssigneePicker({
   assignee,
   users,
   onChange,
}: {
   assignee: TaskaraTask['assignee'];
   users: TaskaraUser[];
   onChange: (assigneeId: string | null) => void;
}) {
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState('');
   const filteredUsers = useMemo(() => filterIssueAssigneeUsers(users, query), [query, users]);

   const handleChange = (assigneeId: string | null) => {
      onChange(assigneeId);
      setOpen(false);
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <SidebarPickerTrigger
               ariaLabel={fa.issue.assignee}
               muted={!assignee}
               icon={
                  assignee ? (
                     <LinearAvatar name={assignee.name} src={assignee.avatarUrl} className="size-5" />
                  ) : (
                     <NoAssigneeIcon className="size-5 text-zinc-500" />
                  )
               }
               label={assignee?.name || fa.issue.assignee}
               open={open}
            />
         </PopoverTrigger>
         <SidebarPickerContent className="w-80">
            <PickerSearchField
               value={query}
               onChange={setQuery}
               placeholder={assigneeSearchPlaceholder}
            />
            <div className="max-h-72 overflow-y-auto overscroll-contain pe-1">
               <SidebarPickerOption
                  active={!assignee?.id}
                  icon={<NoAssigneeIcon className="size-4 text-zinc-500" />}
                  label={fa.issue.noAssignee}
                  onClick={() => handleChange(null)}
               />
               {filteredUsers.length ? (
                  filteredUsers.map((user) => (
                     <SidebarPickerOption
                        key={user.id}
                        active={assignee?.id === user.id}
                        icon={<LinearAvatar name={user.name} src={user.avatarUrl} className="size-5" />}
                        label={user.name}
                        onClick={() => handleChange(user.id)}
                     />
                  ))
               ) : (
                  <div className="px-3 py-2 text-xs text-zinc-500">{noAssigneeSearchResult}</div>
               )}
            </div>
         </SidebarPickerContent>
      </Popover>
   );
}

function IssueSidebarProjectPicker({
   disabled,
   project,
   projects,
   onChange,
}: {
   disabled?: boolean;
   project: TaskaraTask['project'];
   projects: IssueProjectOption[];
   onChange: (projectId: string) => void;
}) {
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState('');
   const filteredProjects = useMemo(() => filterIssueProjects(projects, query), [projects, query]);

   const handleChange = (projectId: string) => {
      onChange(projectId);
      setOpen(false);
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <SidebarPickerTrigger
               ariaLabel={fa.issue.project}
               disabled={disabled}
               muted={!project}
               icon={
                  project ? (
                     <ProjectGlyph name={project.name} className="size-5 rounded-sm" iconClassName="size-3.5" />
                  ) : (
                     <Box className="size-5 text-zinc-500" />
                  )
               }
               label={project?.name || fa.issue.project}
               open={open}
            />
         </PopoverTrigger>
         <SidebarPickerContent className="w-80">
            <PickerSearchField
               value={query}
               onChange={setQuery}
               placeholder={projectSearchPlaceholder}
            />
            <div className="max-h-72 overflow-y-auto overscroll-contain pe-1">
               {filteredProjects.length ? (
                  filteredProjects.map((item) => (
                     <SidebarPickerOption
                        key={item.id}
                        active={project?.id === item.id}
                        icon={
                           <ProjectGlyph
                              name={item.name}
                              className="size-4 rounded-sm"
                              iconClassName="size-3"
                           />
                        }
                        label={item.name}
                        onClick={() => handleChange(item.id)}
                     />
                  ))
               ) : (
                  <div className="px-3 py-2 text-xs text-zinc-500">{noProjectSearchResult}</div>
               )}
            </div>
         </SidebarPickerContent>
      </Popover>
   );
}

type SidebarPickerTriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
   ariaLabel: string;
   icon: React.ReactNode;
   label: string;
   muted?: boolean;
   open: boolean;
};

const SidebarPickerTrigger = forwardRef<HTMLButtonElement, SidebarPickerTriggerProps>(function SidebarPickerTrigger(
   {
      ariaLabel,
      className,
      disabled = false,
      icon,
      label,
      muted = false,
      open,
      type,
      ...buttonProps
   },
   ref
) {
   return (
      <button
         {...buttonProps}
         ref={ref}
         aria-expanded={open}
         aria-label={ariaLabel}
         className={cn(
            'flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-start transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60',
            className
         )}
         disabled={disabled}
         role="combobox"
         type={type || 'button'}
      >
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className={cn('min-w-0 flex-1 truncate text-base', muted ? 'text-zinc-500' : 'text-zinc-100')}>
            {label}
         </span>
      </button>
   );
});

function SidebarPickerContent({
   children,
   className,
}: {
   children: React.ReactNode;
   className?: string;
}) {
   return (
      <PopoverContent
         align="start"
         className={cn(
            'rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl',
            className
         )}
      >
         {children}
      </PopoverContent>
   );
}

function SidebarPickerOption({
   active,
   icon,
   label,
   onClick,
}: {
   active: boolean;
   icon: React.ReactNode;
   label: string;
   onClick: () => void;
}) {
   return (
      <button
         className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-zinc-300 outline-none transition hover:bg-white/[0.06] focus:bg-white/[0.08]"
         type="button"
         onClick={onClick}
      >
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className="min-w-0 flex-1 truncate text-start">{label}</span>
         {active ? <Check className="size-4 shrink-0 text-zinc-400" /> : null}
      </button>
   );
}

function PickerSearchField({
   value,
   onChange,
   placeholder,
}: {
   value: string;
   onChange: (value: string) => void;
   placeholder: string;
}) {
   return (
      <div className="border-b border-white/8 p-2">
         <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
               value={value}
               onChange={(event) => onChange(event.target.value)}
               placeholder={placeholder}
               className="h-8 rounded-md border-white/10 bg-[#1b1b1d] pr-3 pl-8 text-xs text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-indigo-400/40"
            />
         </label>
      </div>
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
      <div className="relative flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-white/5">
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className={cn('min-w-0 flex-1 truncate text-base', muted ? 'text-zinc-500' : 'text-zinc-100')}>
            {label}
         </span>
         {children}
      </div>
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
