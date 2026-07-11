import {
   useCallback,
   useEffect,
   useMemo,
   useRef,
   useState,
   type ChangeEvent,
   type DragEvent,
   type FormEvent,
   type KeyboardEvent,
   type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
   Box,
   CalendarClock,
   Check,
   ChevronDown,
   Diamond,
   Loader2,
   Paperclip,
   UploadCloud,
   UserRound,
   X,
   XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogClose,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { DescriptionEditor, type DescriptionSlashCommand } from '@/components/taskara/description-editor';
import { MilestoneSelector } from '@/components/taskara/milestones/milestone-selector';
import { LinearAvatar, PriorityIcon, ProjectGlyph, StatusIcon, linearPriorityMeta, linearStatusMeta } from '@/components/taskara/linear-ui';
import { TaskDueDateControl } from '@/components/taskara/task-due-date-control';
import { taskaraRequest, uploadTaskAttachment } from '@/lib/taskara-client';
import { fa } from '@/lib/fa-copy';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import type { TaskaraAttachment, TaskaraProject, TaskaraTask, TaskaraUser } from '@/lib/taskara-types';
import { taskPriorities, taskStatuses, taskWeights } from '@/lib/taskara-presenters';
import { cn } from '@/lib/utils';
import { useAuthSession } from '@/store/auth-store';

const workspaceComposerPreferenceStoragePrefix = 'taskara:workspace-task-composer-preferences';

const initialTaskForm = {
   projectId: '',
   milestoneId: '',
   title: '',
   description: '',
   status: 'TODO',
   priority: 'NO_PRIORITY',
   weight: '',
   assigneeId: '',
   dueAt: '',
};

type ComposerField = 'status' | 'priority' | 'assignee' | 'project' | 'milestone' | 'weight' | 'dueAt';

const composerSetupFieldOrder: ComposerField[] = ['priority', 'assignee', 'project', 'milestone', 'weight', 'dueAt'];

type TaskComposerOpenDetail = {
   assigneeId?: string;
   dueAt?: string;
   priority?: string;
   projectId?: string;
   milestoneId?: string;
   status?: string;
   title?: string;
   weight?: number | string | null;
};

type TaskComposerPreferences = {
   createMore?: boolean;
   projectId?: string;
};

function preferenceStorageKey(workspaceSlug: string) {
   return `${workspaceComposerPreferenceStoragePrefix}:${workspaceSlug}`;
}

function readPreferences(workspaceSlug: string): TaskComposerPreferences | null {
   if (typeof window === 'undefined') return null;
   const raw = window.localStorage.getItem(preferenceStorageKey(workspaceSlug));
   if (!raw) return null;

   try {
      const parsed = JSON.parse(raw) as TaskComposerPreferences;
      return parsed && typeof parsed === 'object' ? parsed : null;
   } catch {
      return null;
   }
}

function writePreferences(workspaceSlug: string, preferences: TaskComposerPreferences) {
   if (typeof window === 'undefined') return;
   window.localStorage.setItem(preferenceStorageKey(workspaceSlug), JSON.stringify(preferences));
}

function filterProjects(projects: TaskaraProject[], query: string) {
   const normalizedQuery = query.trim().toLocaleLowerCase('fa');
   if (!normalizedQuery) return projects;

   return projects.filter((project) =>
      [project.name, project.keyPrefix, project.description || '', project.team?.name || '', project.team?.slug || '']
         .join(' ')
         .toLocaleLowerCase('fa')
         .includes(normalizedQuery)
   );
}

function filterUsers(users: TaskaraUser[], query: string) {
   const normalizedQuery = query.trim().toLocaleLowerCase('fa');
   if (!normalizedQuery) return users;

   return users.filter((user) =>
      [user.name, user.email, user.phone || '', user.mattermostUsername || '']
         .join(' ')
         .toLocaleLowerCase('fa')
         .includes(normalizedQuery)
   );
}

function assigneeLabel(user: Pick<TaskaraUser, 'id' | 'name'>, currentUserId: string | null) {
   return user.id === currentUserId ? `${user.name} (شما)` : user.name;
}

function isTaskCreateRetryableResult(task: TaskaraTask) {
   return task.syncState === 'pending';
}

function taskWithAddedAttachments(task: TaskaraTask, attachments: TaskaraAttachment[]): TaskaraTask {
   if (!attachments.length) return task;
   const currentAttachmentCount = task._count?.attachments ?? task.attachments?.length ?? 0;
   return {
      ...task,
      attachments: [...(task.attachments || []), ...attachments],
      _count: {
         ...task._count,
         attachments: currentAttachmentCount + attachments.length,
      },
   };
}

function dataTransferHasFiles(dataTransfer: DataTransfer) {
   return Array.from(dataTransfer.types).includes('Files');
}

export function WorkspaceTaskComposer() {
   const { session } = useAuthSession();
   const { milestones, projects, users, createTask, applyTask } = useWorkspaceTaskSync();
   const navigate = useNavigate();
   const workspaceSlug = session?.workspace?.slug || 'taskara';
   const currentUserId = session?.user.id || null;
   const [open, setOpen] = useState(false);
   const [form, setForm] = useState(initialTaskForm);
   const [createMore, setCreateMore] = useState(false);
   const [pendingFiles, setPendingFiles] = useState<File[]>([]);
   const [draggingFiles, setDraggingFiles] = useState(false);
   const [activeComposerField, setActiveComposerField] = useState<ComposerField | null>(null);
   const [descriptionFocusToken, setDescriptionFocusToken] = useState(0);
   const [submitting, setSubmitting] = useState(false);
   const preferencesHydratedRef = useRef(false);
   const restoredWorkspaceRef = useRef<string | null>(null);
   const titleInputRef = useRef<HTMLInputElement>(null);
   const attachmentInputRef = useRef<HTMLInputElement>(null);
   const dragDepthRef = useRef(0);
   const setupQueueRef = useRef<ComposerField[]>([]);

   const usersForAssignee = useMemo(() => {
      if (!currentUserId) return users;
      const currentUser = users.find((user) => user.id === currentUserId);
      if (!currentUser) return users;
      return [currentUser, ...users.filter((user) => user.id !== currentUserId)];
   }, [currentUserId, users]);

   const selectedProject = projects.find((project) => project.id === form.projectId) || null;
   const selectedMilestone = milestones.find((milestone) => milestone.id === form.milestoneId) || null;
   const selectedAssignee = users.find((user) => user.id === form.assigneeId) || null;

   const focusDescription = useCallback(() => {
      window.setTimeout(() => setDescriptionFocusToken((current) => current + 1), 0);
   }, []);

   const openComposerField = useCallback((field: ComposerField) => {
      setupQueueRef.current = [];
      setActiveComposerField(field);
   }, []);

   const startSetupFlow = useCallback(() => {
      setupQueueRef.current = [...composerSetupFieldOrder];
      setActiveComposerField(setupQueueRef.current[0] || null);
   }, []);

   const handleComposerFieldOpenChange = useCallback((field: ComposerField, nextOpen: boolean) => {
      if (nextOpen) {
         if (setupQueueRef.current[0] !== field) setupQueueRef.current = [];
         setActiveComposerField(field);
         return;
      }
      setActiveComposerField((current) => (current === field ? null : current));
   }, []);

   const handleComposerFieldPicked = useCallback(
      (field: ComposerField) => {
         if (setupQueueRef.current.length) {
            const fieldIndex = setupQueueRef.current.indexOf(field);
            setupQueueRef.current = fieldIndex >= 0 ? setupQueueRef.current.slice(fieldIndex + 1) : [];
            const nextField = setupQueueRef.current[0] || null;
            if (nextField) {
               window.setTimeout(() => setActiveComposerField(nextField), 0);
               return;
            }
         }

         setupQueueRef.current = [];
         setActiveComposerField(null);
         focusDescription();
      },
      [focusDescription]
   );

   const descriptionSlashCommands = useMemo<DescriptionSlashCommand[]>(
      () => [
         {
            command: () => openComposerField('status'),
            description: 'انتخاب وضعیت انجام کار',
            icon: <StatusIcon status={form.status} className="size-4" />,
            key: 'taskara-status',
            keywords: ['status', 'state', 'وضعیت', 'انجام', 'برای انجام'],
            title: 'انجام',
         },
         {
            command: () => openComposerField('weight'),
            description: 'انتخاب وزن کار',
            icon: <Box className="size-4" />,
            key: 'taskara-weight',
            keywords: ['weight', 'estimate', 'وزن', 'امتیاز'],
            title: 'وزن',
         },
         {
            command: () => openComposerField('project'),
            description: 'انتخاب پروژه کار',
            icon: <ProjectGlyph name={selectedProject?.name || fa.issue.project} className="size-4 rounded-sm" iconClassName="size-3" />,
            key: 'taskara-project',
            keywords: ['project', 'پروژه'],
            title: 'پروژه',
         },
         {
            command: () => openComposerField('milestone'),
            description: 'اتصال کار به یک مایلستون پروژه',
            icon: <Diamond className="size-4 text-violet-300" />,
            key: 'taskara-milestone',
            keywords: ['milestone', 'goal', 'مایلستون', 'هدف', 'فاز', 'ویژگی'],
            title: fa.project.milestones,
         },
         {
            command: () => openComposerField('priority'),
            description: 'انتخاب اولویت کار',
            icon: <PriorityIcon priority={form.priority} className="size-4" />,
            key: 'taskara-priority',
            keywords: ['priority', 'اهمیت', 'اولویت'],
            title: 'اولویت',
         },
         {
            command: () => openComposerField('assignee'),
            description: 'انتخاب مسئول کار',
            icon: selectedAssignee ? (
               <LinearAvatar name={selectedAssignee.name} src={selectedAssignee.avatarUrl} className="size-4" />
            ) : (
               <UserRound className="size-4" />
            ),
            key: 'taskara-assignee',
            keywords: ['assignee', 'owner', 'person', 'مسئول', 'کارمند'],
            title: 'مسئول',
         },
         {
            command: () => openComposerField('dueAt'),
            description: 'انتخاب سررسید کار',
            icon: <CalendarClock className="size-4" />,
            key: 'taskara-due-at',
            keywords: ['due', 'date', 'deadline', 'سررسید', 'تاریخ'],
            title: 'سررسید',
         },
         {
            command: () => startSetupFlow(),
            description: 'انتخاب اولویت، مسئول، پروژه، مایلستون، وزن و سررسید',
            icon: <Check className="size-4" />,
            key: 'taskara-setup',
            keywords: ['setup', 'configure', 'تنظیم', 'پیکربندی'],
            title: 'تنظیم',
         },
      ],
      [
         form.priority,
         form.status,
         openComposerField,
         selectedAssignee,
         selectedProject?.name,
         selectedMilestone?.name,
         startSetupFlow,
      ]
   );

   useEffect(() => {
      if (restoredWorkspaceRef.current === workspaceSlug) return;
      const stored = readPreferences(workspaceSlug);
      if (stored) {
         if (typeof stored.createMore === 'boolean') setCreateMore(stored.createMore);
         if (typeof stored.projectId === 'string') {
            setForm((current) => ({ ...current, projectId: stored.projectId || current.projectId }));
         }
      }
      restoredWorkspaceRef.current = workspaceSlug;
      preferencesHydratedRef.current = true;
   }, [workspaceSlug]);

   useEffect(() => {
      setForm((current) => {
         const projectId = projects.some((project) => project.id === current.projectId)
            ? current.projectId
            : projects[0]?.id || '';
         const milestoneId = milestones.some(
            (milestone) =>
               milestone.id === current.milestoneId &&
               milestone.projectId === projectId &&
               !milestone.archivedAt &&
               (milestone.status === 'PLANNED' || milestone.status === 'ACTIVE')
         )
            ? current.milestoneId
            : '';
         if (projectId === current.projectId && milestoneId === current.milestoneId) return current;
         return { ...current, projectId, milestoneId };
      });
   }, [milestones, projects]);

   useEffect(() => {
      if (!preferencesHydratedRef.current) return;
      writePreferences(workspaceSlug, {
         createMore,
         projectId: form.projectId || undefined,
      });
   }, [createMore, form.projectId, workspaceSlug]);

   useEffect(() => {
      if (!open) return;
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
   }, [open]);

   const openComposer = useCallback((detail?: TaskComposerOpenDetail) => {
      if (detail && typeof detail === 'object') {
         setForm((current) => {
            const next = { ...current };
            if (typeof detail.title === 'string') next.title = detail.title.slice(0, 300);
            if (typeof detail.projectId === 'string' && projects.some((project) => project.id === detail.projectId)) {
               next.projectId = detail.projectId;
            }
            if (
               typeof detail.milestoneId === 'string' &&
               milestones.some(
                  (milestone) =>
                     milestone.id === detail.milestoneId &&
                     milestone.projectId === next.projectId &&
                     !milestone.archivedAt &&
                     (milestone.status === 'PLANNED' || milestone.status === 'ACTIVE')
               )
            ) {
               next.milestoneId = detail.milestoneId;
            } else if (detail.projectId) {
               next.milestoneId = '';
            }
            if (typeof detail.assigneeId === 'string' && users.some((user) => user.id === detail.assigneeId)) {
               next.assigneeId = detail.assigneeId;
            }
            if (typeof detail.status === 'string' && taskStatuses.includes(detail.status as (typeof taskStatuses)[number])) {
               next.status = detail.status;
            }
            if (typeof detail.priority === 'string' && taskPriorities.includes(detail.priority as (typeof taskPriorities)[number])) {
               next.priority = detail.priority;
            }
            if (typeof detail.dueAt === 'string') next.dueAt = detail.dueAt;
            if (detail.weight !== undefined && detail.weight !== null && detail.weight !== '') {
               const numericWeight = Number(detail.weight);
               if (taskWeights.includes(numericWeight as (typeof taskWeights)[number])) next.weight = String(numericWeight);
            }
            return next;
         });
      }
      setOpen(true);
   }, [milestones, projects, users]);

   const addPendingFiles = useCallback((fileList: FileList | File[] | null) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      setPendingFiles((current) => [...current, ...files]);
   }, []);

   function selectPendingFiles(event: ChangeEvent<HTMLInputElement>) {
      addPendingFiles(event.target.files);
      event.target.value = '';
   }

   function removePendingFile(index: number) {
      setPendingFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
   }

   const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDraggingFiles(true);
   }, []);

   const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDraggingFiles(true);
   }, []);

   const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDraggingFiles(false);
   }, []);

   const handleDrop = useCallback(
      (event: DragEvent<HTMLDivElement>) => {
         if (!dataTransferHasFiles(event.dataTransfer)) return;
         event.preventDefault();
         dragDepthRef.current = 0;
         setDraggingFiles(false);
         addPendingFiles(event.dataTransfer.files);
      },
      [addPendingFiles]
   );

   const handleOpenChange = useCallback((nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) return;
      dragDepthRef.current = 0;
      setupQueueRef.current = [];
      setActiveComposerField(null);
      setDraggingFiles(false);
   }, []);

   useEffect(() => {
      const handleCreateIssue = (event: Event) => {
         const detail = event instanceof CustomEvent ? (event.detail as TaskComposerOpenDetail | undefined) : undefined;
         openComposer(detail);
      };
      window.addEventListener('taskara:create-issue', handleCreateIssue);
      return () => window.removeEventListener('taskara:create-issue', handleCreateIssue);
   }, [openComposer]);

   const openCreatedTask = useCallback(
      (task: TaskaraTask) => {
         navigate(`/${workspaceSlug}/issue/${encodeURIComponent(task.key)}`);
      },
      [navigate, workspaceSlug]
   );

   const copyCreatedTaskLink = useCallback(
      (task: TaskaraTask) => {
         const url = `${window.location.origin}/${workspaceSlug}/issue/${encodeURIComponent(task.key)}`;
         void navigator.clipboard?.writeText(url);
         toast.success(fa.issue.linkCopied);
      },
      [workspaceSlug]
   );

   const sendCreatedTaskMessage = useCallback(async (task: TaskaraTask): Promise<boolean> => {
      if (!task.assignee) {
         toast.error(fa.issue.smsNoAssignee);
         return false;
      }
      if (!task.assignee.phone) {
         toast.error(fa.issue.smsNoPhone);
         return false;
      }
      try {
         await taskaraRequest(`/tasks/${encodeURIComponent(task.key)}/sms/task-created`, { method: 'POST' });
         toast.success(fa.issue.smsSent);
         return true;
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.smsFailed);
         return false;
      }
   }, []);

   async function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (submitting) return;
      if (!projects.length || !form.projectId) {
         toast.error(fa.issue.projectRequired);
         return;
      }
      if (!form.title.trim()) {
         toast.error(fa.issue.titleRequired);
         return;
      }

      const weight = form.weight === '' ? undefined : Number(form.weight);
      if (weight !== undefined && (!Number.isFinite(weight) || !taskWeights.includes(weight as (typeof taskWeights)[number]))) {
         toast.error(fa.issue.invalidWeight);
         return;
      }

      const submittedProjectId = form.projectId;
      const submittedMilestoneId = form.milestoneId;
      const submittedStatus = form.status;
      const submittedWeight = form.weight;
      const submittedAssigneeId = form.assigneeId;
      const filesToUpload = pendingFiles;

      try {
         setSubmitting(true);
         const createdTask = await createTask({
            projectId: form.projectId,
            title: form.title.trim(),
            description: form.description.trim() || undefined,
            status: form.status,
            priority: form.priority,
            weight,
            assigneeId: form.assigneeId || undefined,
            milestoneId: form.milestoneId || undefined,
            dueAt: form.dueAt || undefined,
            labels: [],
            source: 'WEB',
         });

         if (isTaskCreateRetryableResult(createdTask)) {
            if (filesToUpload.length) toast.error(fa.issue.pendingAttachmentUpload);
            toast.success(createdTask.title, { description: fa.issue.createdOffline });
         } else {
            let taskForToast = createdTask;
            if (filesToUpload.length) {
               const uploadResults = await Promise.allSettled(
                  filesToUpload.map((file) => uploadTaskAttachment(createdTask.key, file))
               );
               const uploadedAttachments = uploadResults.flatMap((result) =>
                  result.status === 'fulfilled' ? [result.value] : []
               );
               const failedUploads = uploadResults.flatMap((result) =>
                  result.status === 'rejected' ? [result.reason] : []
               );

               if (uploadedAttachments.length) {
                  taskForToast = taskWithAddedAttachments(createdTask, uploadedAttachments);
                  applyTask(taskForToast);
                  toast.success(
                     uploadedAttachments.length === 1
                        ? fa.issue.attachmentUploaded
                        : fa.issue.attachmentsUploaded.replace(
                             '{count}',
                             uploadedAttachments.length.toLocaleString('fa-IR')
                          )
                  );
               }

               if (failedUploads.length) {
                  const firstError = failedUploads[0];
                  toast.error(
                     failedUploads.length === 1 && firstError instanceof Error
                        ? firstError.message
                        : fa.issue.attachmentUploadFailed
                  );
               }
            }

            let createdToastId: string | number = '';
            createdToastId = toast.success(taskForToast.title, {
               description: (
                  <CreatedTaskToastActions
                     onCopyLink={() => copyCreatedTaskLink(taskForToast)}
                     onOpen={() => {
                        toast.dismiss(createdToastId);
                        openCreatedTask(taskForToast);
                     }}
                     onSendMessage={() => sendCreatedTaskMessage(taskForToast)}
                  />
               ),
            });
         }

         setForm({
            ...initialTaskForm,
            projectId: submittedProjectId,
            milestoneId: createMore ? submittedMilestoneId : '',
            status: submittedStatus,
            weight: submittedWeight,
            assigneeId: createMore ? submittedAssigneeId : '',
         });
         setPendingFiles([]);
         if (attachmentInputRef.current) attachmentInputRef.current.value = '';
         if (!createMore) setOpen(false);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.createFailed);
      } finally {
         setSubmitting(false);
      }
   }

   function handleComposerSubmitShortcut(event: KeyboardEvent<HTMLFormElement>) {
      if (event.key !== 'Enter' || !event.metaKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.requestSubmit();
   }

   return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
         <DialogContent
            aria-label={fa.issue.newIssue}
            showCloseButton={false}
            className="relative flex max-h-[calc(100svh-32px)] max-w-[860px] flex-col gap-0 overflow-hidden rounded-[18px] border-white/10 bg-[#1d1d20] p-0 text-zinc-100 shadow-[0_18px_70px_rgb(0_0_0/0.55)] sm:max-w-[860px]"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
         >
            <DialogHeader className="relative px-5 pb-0 pt-4 text-right">
               <div className="absolute end-4 top-4">
                  <DialogClose asChild>
                     <button
                        aria-label={fa.app.close}
                        className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/6 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/60"
                        title={fa.app.close}
                        type="button"
                     >
                        <X className="size-4" />
                     </button>
                  </DialogClose>
               </div>
               <DialogTitle className="flex min-w-0 items-center gap-2 pe-10 text-sm font-semibold text-zinc-200">
                  <span className="inline-flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-white/8 bg-[#2a2a2d] px-2.5 text-[12px] font-normal text-zinc-300">
                     <ProjectGlyph
                        name={selectedProject?.name || fa.project.newProject}
                        className="size-4 rounded"
                        iconClassName="size-3"
                     />
                     <span className="truncate">{selectedProject?.name || fa.project.newProject}</span>
                  </span>
                  <span>{fa.issue.newIssue}</span>
               </DialogTitle>
               <DialogDescription className="sr-only">{fa.issue.createIssue}</DialogDescription>
            </DialogHeader>

            <form
               className="flex min-h-0 flex-1 flex-col"
               onKeyDownCapture={handleComposerSubmitShortcut}
               onSubmit={handleSubmit}
            >
               <div className="flex min-h-[260px] flex-1 flex-col px-5 pt-7">
                  <Input
                     ref={titleInputRef}
                     className="h-auto border-none bg-transparent px-0 text-right text-xl font-semibold leading-7 text-zinc-100 shadow-none outline-none placeholder:text-zinc-600 focus-visible:ring-0"
                     value={form.title}
                     onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                     placeholder={fa.issue.titlePlaceholder}
                  />
                  <DescriptionEditor
                     className="mt-2"
                     contentClassName="min-h-24 text-right text-sm leading-6 text-zinc-300"
                     focusToken={descriptionFocusToken}
                     showToolbar={false}
                     slashCommands={descriptionSlashCommands}
                     variant="plain"
                     users={users}
                     value={form.description}
                     onChange={(description) => setForm((current) => ({ ...current, description }))}
                     placeholder={fa.issue.descriptionPlaceholder}
                  />
                  <PendingComposerAttachmentList
                     disabled={submitting}
                     files={pendingFiles}
                     onRemove={removePendingFile}
                  />

                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pb-4 lg:flex-nowrap">
                     <input
                        ref={attachmentInputRef}
                        className="hidden"
                        multiple
                        type="file"
                        onChange={selectPendingFiles}
                     />
                     <button
                        aria-label={fa.issue.uploadAttachment}
                        className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-full border border-white/8 bg-[#2a2a2d] px-2 text-zinc-400 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition hover:bg-[#303033] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/35 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={submitting}
                        title={fa.issue.uploadAttachment}
                        type="button"
                        onClick={() => attachmentInputRef.current?.click()}
                     >
                        <Paperclip className="size-3.5" />
                        {pendingFiles.length ? (
                           <span className="min-w-3 text-center text-[11px] leading-none text-zinc-300">
                              {pendingFiles.length.toLocaleString('fa-IR')}
                           </span>
                        ) : null}
                     </button>
                     <ComposerStatusPill
                        open={activeComposerField === 'status'}
                        status={form.status}
                        onChange={(status) => setForm((current) => ({ ...current, status }))}
                        onAfterChange={() => handleComposerFieldPicked('status')}
                        onOpenChange={(nextOpen) => handleComposerFieldOpenChange('status', nextOpen)}
                     />
                     <ComposerPriorityPill
                        open={activeComposerField === 'priority'}
                        priority={form.priority}
                        onChange={(priority) => setForm((current) => ({ ...current, priority }))}
                        onAfterChange={() => handleComposerFieldPicked('priority')}
                        onOpenChange={(nextOpen) => handleComposerFieldOpenChange('priority', nextOpen)}
                     />
                     <ComposerAssigneePill
                        assignee={selectedAssignee}
                        currentUserId={currentUserId}
                        open={activeComposerField === 'assignee'}
                        users={usersForAssignee}
                        onChange={(assigneeId) => setForm((current) => ({ ...current, assigneeId }))}
                        onAfterChange={() => handleComposerFieldPicked('assignee')}
                        onOpenChange={(nextOpen) => handleComposerFieldOpenChange('assignee', nextOpen)}
                     />
                     <ComposerProjectPill
                        open={activeComposerField === 'project'}
                        project={selectedProject}
                        projects={projects}
                        onChange={(projectId) =>
                           setForm((current) => ({
                              ...current,
                              projectId,
                              milestoneId: current.projectId === projectId ? current.milestoneId : '',
                           }))
                        }
                        onAfterChange={() => handleComposerFieldPicked('project')}
                        onOpenChange={(nextOpen) => handleComposerFieldOpenChange('project', nextOpen)}
                     />
                     <MilestoneSelector
                        className="h-6 max-w-[168px] rounded-full border-white/8 bg-[#2a2a2d] px-2.5 text-[12px] text-zinc-300 hover:bg-[#303033]"
                        currentMilestone={selectedMilestone}
                        milestones={milestones}
                        placeholder={fa.milestone.selectMilestone}
                        projectId={form.projectId}
                        value={form.milestoneId || null}
                        variant="pill"
                        onChange={(milestoneId) => {
                           setForm((current) => ({ ...current, milestoneId: milestoneId || '' }));
                           handleComposerFieldPicked('milestone');
                        }}
                     />
                     <ComposerWeightPill
                        open={activeComposerField === 'weight'}
                        weight={form.weight}
                        onChange={(weight) => setForm((current) => ({ ...current, weight }))}
                        onAfterChange={() => handleComposerFieldPicked('weight')}
                        onOpenChange={(nextOpen) => handleComposerFieldOpenChange('weight', nextOpen)}
                     />
                     <TaskDueDateControl
                        dueAt={form.dueAt || null}
                        className="h-6 w-[116px] shrink-0 rounded-full border-white/8 bg-[#2a2a2d] px-2.5 text-[12px] text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] hover:border-white/8 hover:bg-[#303033] hover:text-zinc-300"
                        iconClassName="size-3.5 text-zinc-500"
                        open={activeComposerField === 'dueAt'}
                        onChange={(dueAt) => setForm((current) => ({ ...current, dueAt: dueAt || '' }))}
                        onAfterChange={() => handleComposerFieldPicked('dueAt')}
                        onOpenChange={(nextOpen) => handleComposerFieldOpenChange('dueAt', nextOpen)}
                     />
                  </div>
               </div>

               <div className="flex items-center justify-end border-t border-white/7 px-5 py-3">
                  <div className="flex items-center gap-3">
                     <label className="flex items-center gap-2 text-[13px] text-zinc-500" htmlFor="workspace-composer-create-more">
                        <Switch
                           checked={createMore}
                           className="border-0 data-[state=checked]:bg-indigo-500 data-[state=unchecked]:bg-white/14 [&_[data-slot=switch-thumb]]:bg-zinc-100 [&_[data-slot=switch-thumb]]:shadow-[0_1px_2px_rgb(0_0_0/0.35)] [&_[data-slot=switch-thumb][data-state=checked]]:-translate-x-4"
                           id="workspace-composer-create-more"
                           onCheckedChange={setCreateMore}
                           type="button"
                        />
                        <span>{fa.issue.createMore}</span>
                     </label>
                     <Button
                        type="submit"
                        disabled={submitting || !projects.length}
                        className="h-8 rounded-full bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-400 disabled:bg-indigo-500/40"
                     >
                        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                        {fa.issue.createIssue}
                     </Button>
                  </div>
               </div>
            </form>
            {draggingFiles ? (
               <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-6 backdrop-blur-[1px]">
                  <div className="flex min-h-32 w-full max-w-sm flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-indigo-300/55 bg-[#202023]/95 text-center shadow-2xl">
                     <UploadCloud className="size-8 text-indigo-200" />
                     <span className="text-sm font-medium text-zinc-100">{fa.issue.dropAttachments}</span>
                  </div>
               </div>
            ) : null}
         </DialogContent>
      </Dialog>
   );
}

function PendingComposerAttachmentList({
   disabled,
   files,
   onRemove,
}: {
   disabled: boolean;
   files: File[];
   onRemove: (index: number) => void;
}) {
   if (!files.length) return null;

   return (
      <div className="mt-3 flex max-h-24 flex-wrap gap-2 overflow-y-auto pb-1 pe-1">
         {files.map((file, index) => (
            <div
               key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
               className="inline-flex h-8 max-w-full items-center gap-2 rounded-md border border-white/8 bg-[#171719] px-2 text-zinc-300"
            >
               <Paperclip className="size-3.5 shrink-0 text-zinc-500" />
               <span className="min-w-0 max-w-56 truncate text-xs">{file.name}</span>
               <span className="shrink-0 text-[11px] text-zinc-600">{formatComposerFileSize(file.size)}</span>
               <button
                  aria-label={fa.issue.removeAttachment}
                  className="shrink-0 rounded-full p-0.5 text-zinc-500 transition hover:bg-white/8 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={disabled}
                  type="button"
                  onClick={() => onRemove(index)}
               >
                  <X className="size-3.5" />
               </button>
            </div>
         ))}
      </div>
   );
}

function formatComposerFileSize(bytes: number): string {
   if (bytes < 1024) return `${bytes.toLocaleString('fa-IR')} B`;
   const kilobytes = bytes / 1024;
   if (kilobytes < 1024) return `${kilobytes.toLocaleString('fa-IR', { maximumFractionDigits: 1 })} KB`;
   return `${(kilobytes / 1024).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} MB`;
}

function ComposerMenuPill({
   ariaLabel,
   className,
   contentClassName,
   children,
   disabled = false,
   icon,
   label,
   open,
   onOpenChange,
}: {
   ariaLabel: string;
   className?: string;
   contentClassName?: string;
   children: ReactNode;
   disabled?: boolean;
   icon: ReactNode;
   label: ReactNode;
   open: boolean;
   onOpenChange: (open: boolean) => void;
}) {
   const contentRef = useRef<HTMLDivElement | null>(null);

   return (
      <Popover open={open} onOpenChange={onOpenChange}>
         <PopoverTrigger asChild>
            <button
               aria-label={ariaLabel}
               className={cn(
                  'inline-flex h-6 max-w-[168px] shrink-0 items-center gap-1.5 rounded-full border border-white/8 bg-[#2a2a2d] py-0 pl-2 pr-2.5 text-[12px] font-normal text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition hover:bg-[#303033] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/35 disabled:cursor-wait disabled:opacity-55',
                  className
               )}
               disabled={disabled}
               type="button"
            >
               <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
               <span className="min-w-0 flex-1 truncate text-start">{label}</span>
               <ChevronDown className="size-3.5 shrink-0 text-zinc-600" />
            </button>
         </PopoverTrigger>
         <PopoverContent
            ref={contentRef}
            align="start"
            className={cn('rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl', contentClassName)}
            sideOffset={8}
            data-composer-menu-content
            onCloseAutoFocus={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
               event.preventDefault();
               window.requestAnimationFrame(() => {
                  contentRef.current
                     ?.querySelector<HTMLElement>('input, button:not(:disabled), [tabindex]:not([tabindex="-1"])')
                     ?.focus();
               });
            }}
         >
            {children}
         </PopoverContent>
      </Popover>
   );
}

function focusComposerMenuButton(event: KeyboardEvent<HTMLButtonElement>, direction: 'first' | 'last' | 'next' | 'previous') {
   const container = event.currentTarget.closest('[data-composer-menu-content]');
   if (!container) return;

   const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
   if (!buttons.length) return;

   const currentIndex = buttons.indexOf(event.currentTarget);
   const lastIndex = buttons.length - 1;
   let nextIndex = currentIndex;

   if (direction === 'first') nextIndex = 0;
   else if (direction === 'last') nextIndex = lastIndex;
   else if (direction === 'next') nextIndex = currentIndex >= lastIndex ? 0 : currentIndex + 1;
   else nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;

   event.preventDefault();
   buttons[nextIndex]?.focus();
}

function LinearMenuOption({
   active,
   icon,
   label,
   meta,
   onClick,
}: {
   active?: boolean;
   icon: ReactNode;
   label: ReactNode;
   meta?: ReactNode;
   onClick: () => void;
}) {
   return (
      <button
         className={cn(
            'group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm leading-none outline-none transition hover:bg-white/[0.04] hover:text-zinc-100 focus-visible:bg-white/[0.04] focus-visible:text-zinc-100',
            active ? 'text-zinc-50' : 'text-zinc-300'
         )}
         type="button"
         onClick={onClick}
         onKeyDown={(event) => {
            if (event.key === 'ArrowDown') focusComposerMenuButton(event, 'next');
            else if (event.key === 'ArrowUp') focusComposerMenuButton(event, 'previous');
            else if (event.key === 'Home') focusComposerMenuButton(event, 'first');
            else if (event.key === 'End') focusComposerMenuButton(event, 'last');
         }}
      >
         <span className="flex size-4 shrink-0 items-center justify-center text-zinc-400">
            {active ? <Check className="size-3.5 text-zinc-100" /> : null}
         </span>
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className="min-w-0 flex-1 truncate text-start">{label}</span>
         {meta ? <span className="shrink-0 text-xs text-zinc-500">{meta}</span> : null}
      </button>
   );
}

function MenuSearchField({
   onEnter,
   title,
   value,
   onChange,
}: {
   onEnter?: () => void;
   title: string;
   value: string;
   onChange: (value: string) => void;
}) {
   return (
      <label className="mb-1 flex h-9 items-center border-b border-white/7 px-2.5">
         <span className="sr-only">{title}</span>
         <input
            className="h-full w-full bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
               if (event.key === 'Enter' && onEnter) {
                  event.preventDefault();
                  onEnter();
                  return;
               }

               if (event.key !== 'ArrowDown') return;
               const container = event.currentTarget.closest('[data-composer-menu-content]');
               const firstButton = container?.querySelector<HTMLButtonElement>('button:not(:disabled)');
               if (!firstButton) return;
               event.preventDefault();
               firstButton.focus();
            }}
            placeholder={title}
         />
      </label>
   );
}

export function ComposerStatusPill({
   className,
   disabled = false,
   open,
   status,
   onAfterChange,
   onChange,
   onOpenChange,
}: {
   className?: string;
   disabled?: boolean;
   open: boolean;
   status: string;
   onAfterChange: () => void;
   onChange: (status: string) => void;
   onOpenChange: (open: boolean) => void;
}) {
   const handleChange = (nextStatus: string) => {
      onChange(nextStatus);
      onOpenChange(false);
      onAfterChange();
   };

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.status}
         className={className}
         contentClassName="w-auto min-w-[11rem]"
         disabled={disabled}
         icon={<StatusIcon status={status} className="size-3.5" />}
         label={linearStatusMeta[status]?.label || status}
         open={open}
         onOpenChange={onOpenChange}
      >
         {taskStatuses.map((item) => (
            <LinearMenuOption
               key={item}
               active={status === item}
               icon={<StatusIcon status={item} />}
               label={linearStatusMeta[item]?.label || item}
               onClick={() => handleChange(item)}
            />
         ))}
      </ComposerMenuPill>
   );
}

export function ComposerPriorityPill({
   className,
   disabled = false,
   open,
   priority,
   onAfterChange,
   onChange,
   onOpenChange,
}: {
   className?: string;
   disabled?: boolean;
   open: boolean;
   priority: string;
   onAfterChange: () => void;
   onChange: (priority: string) => void;
   onOpenChange: (open: boolean) => void;
}) {
   const handleChange = (nextPriority: string) => {
      onChange(nextPriority);
      onOpenChange(false);
      onAfterChange();
   };

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.priority}
         className={className}
         contentClassName="w-auto min-w-[11rem]"
         disabled={disabled}
         icon={<PriorityIcon priority={priority} className="size-3.5" />}
         label={linearPriorityMeta[priority]?.label || priority}
         open={open}
         onOpenChange={onOpenChange}
      >
         {taskPriorities.map((item) => (
            <LinearMenuOption
               key={item}
               active={priority === item}
               icon={<PriorityIcon priority={item} />}
               label={linearPriorityMeta[item]?.label || item}
               onClick={() => handleChange(item)}
            />
         ))}
      </ComposerMenuPill>
   );
}

export function ComposerAssigneePill({
   assignee,
   className,
   currentUserId,
   disabled = false,
   open,
   users,
   onAfterChange,
   onChange,
   onOpenChange,
}: {
   assignee?: TaskaraTask['assignee'] | null;
   className?: string;
   currentUserId: string | null;
   disabled?: boolean;
   open: boolean;
   users: TaskaraUser[];
   onAfterChange: () => void;
   onChange: (assigneeId: string) => void;
   onOpenChange: (open: boolean) => void;
}) {
   const [query, setQuery] = useState('');
   const filteredUsers = useMemo(() => filterUsers(users, query), [users, query]);
   useEffect(() => {
      if (!open) setQuery('');
   }, [open]);

   const handleChange = (nextAssigneeId: string) => {
      onChange(nextAssigneeId);
      onOpenChange(false);
      onAfterChange();
   };

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.assignee}
         className={className}
         contentClassName="w-80"
         disabled={disabled}
         icon={
            assignee ? (
               <LinearAvatar name={assignee.name} src={assignee.avatarUrl} className="size-4" />
            ) : (
               <UserRound className="size-3.5 text-zinc-500" />
            )
         }
         label={assignee ? assigneeLabel(assignee, currentUserId) : fa.issue.assignee}
         open={open}
         onOpenChange={onOpenChange}
      >
         <MenuSearchField
            title="جستجو بین کارمندان..."
            value={query}
            onChange={setQuery}
            onEnter={() => {
               const firstUser = filteredUsers[0];
               if (firstUser) handleChange(firstUser.id);
            }}
         />
         <div className="max-h-72 overflow-y-auto overscroll-contain pe-1">
            <LinearMenuOption
               active={!assignee?.id}
               icon={<XCircle className="size-4 text-zinc-500" />}
               label={fa.issue.noAssignee}
               onClick={() => handleChange('')}
            />
            {filteredUsers.length ? (
               filteredUsers.map((user) => (
                  <LinearMenuOption
                     key={user.id}
                     active={assignee?.id === user.id}
                     icon={<LinearAvatar name={user.name} src={user.avatarUrl} className="size-5" />}
                     label={assigneeLabel(user, currentUserId)}
                     onClick={() => handleChange(user.id)}
                  />
               ))
            ) : (
               <div className="px-3 py-2 text-xs text-zinc-500">کارمندی پیدا نشد</div>
            )}
         </div>
      </ComposerMenuPill>
   );
}

export function ComposerProjectPill({
   className,
   disabled = false,
   open,
   project,
   projects,
   onAfterChange,
   onChange,
   onOpenChange,
}: {
   className?: string;
   disabled?: boolean;
   open: boolean;
   project?: TaskaraProject | null;
   projects: TaskaraProject[];
   onAfterChange: () => void;
   onChange: (projectId: string) => void;
   onOpenChange: (open: boolean) => void;
}) {
   const [query, setQuery] = useState('');
   const filteredProjects = useMemo(() => filterProjects(projects, query), [projects, query]);
   useEffect(() => {
      if (!open) setQuery('');
   }, [open]);

   const handleChange = (nextProjectId: string) => {
      onChange(nextProjectId);
      onOpenChange(false);
      onAfterChange();
   };
   const projectName = project?.name || fa.issue.project;

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.project}
         className={className}
         contentClassName="w-80"
         disabled={disabled}
         icon={<ProjectGlyph name={projectName} className="size-4 rounded" iconClassName="size-3" />}
         label={projectName}
         open={open}
         onOpenChange={onOpenChange}
      >
         <MenuSearchField
            title="جستجو بین پروژه‌ها..."
            value={query}
            onChange={setQuery}
            onEnter={() => {
               const firstProject = filteredProjects[0];
               if (firstProject) handleChange(firstProject.id);
            }}
         />
         {projects.length ? (
            <div className="max-h-72 overflow-y-auto overscroll-contain pe-1">
               {filteredProjects.length ? (
                  filteredProjects.map((item) => (
                     <LinearMenuOption
                        key={item.id}
                        active={project?.id === item.id}
                        icon={<ProjectGlyph name={item.name} className="size-4 rounded-sm" iconClassName="size-3" />}
                        label={item.name}
                        meta={item.team?.name || item.keyPrefix}
                        onClick={() => handleChange(item.id)}
                     />
                  ))
               ) : (
                  <div className="px-3 py-2 text-xs text-zinc-500">پروژه‌ای پیدا نشد</div>
               )}
            </div>
         ) : (
            <div className="px-3 py-2 text-xs text-zinc-500">{fa.issue.projectRequired}</div>
         )}
      </ComposerMenuPill>
   );
}

function ComposerWeightPill({
   open,
   weight,
   onAfterChange,
   onChange,
   onOpenChange,
}: {
   open: boolean;
   weight: string;
   onAfterChange: () => void;
   onChange: (weight: string) => void;
   onOpenChange: (open: boolean) => void;
}) {
   const handleChange = (nextWeight: string) => {
      onChange(nextWeight);
      onOpenChange(false);
      onAfterChange();
   };
   const weightLabel = weight ? `${fa.issue.weight} ${Number(weight).toLocaleString('fa-IR')}` : fa.issue.weight;

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.weight}
         contentClassName="w-auto min-w-[11rem]"
         icon={weight ? <Box className="size-3.5 text-zinc-500" /> : <XCircle className="size-3.5 text-zinc-500" />}
         label={weightLabel}
         open={open}
         onOpenChange={onOpenChange}
      >
         <LinearMenuOption
            active={!weight}
            icon={<XCircle className="size-4 text-zinc-500" />}
            label="بدون وزن"
            onClick={() => handleChange('')}
         />
         {taskWeights.map((item) => (
            <LinearMenuOption
               key={item}
               active={Number(weight) === item}
               icon={<Box className="size-4 text-zinc-400" />}
               label={`${fa.issue.weight} ${item.toLocaleString('fa-IR')}`}
               onClick={() => handleChange(String(item))}
            />
         ))}
      </ComposerMenuPill>
   );
}

function ToastActionButton({
   children,
   disabled,
   onClick,
}: {
   children: ReactNode;
   disabled?: boolean;
   onClick: () => void;
}) {
   return (
      <button
         className="inline-flex h-7 items-center rounded-md border border-white/10 bg-white/5 px-2.5 text-[12px] font-medium text-zinc-200 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/5"
         disabled={disabled}
         onClick={onClick}
         type="button"
      >
         {children}
      </button>
   );
}

function CreatedTaskToastActions({
   onCopyLink,
   onOpen,
   onSendMessage,
}: {
   onCopyLink: () => void;
   onOpen: () => void;
   onSendMessage: () => Promise<boolean>;
}) {
   const [linkCopied, setLinkCopied] = useState(false);
   const [messageSending, setMessageSending] = useState(false);
   const [messageSent, setMessageSent] = useState(false);

   return (
      <div className="mt-1 flex flex-col gap-2">
         <span>{fa.issue.created}</span>
         <div className="flex flex-wrap items-center gap-2">
            <ToastActionButton onClick={onOpen}>{fa.issue.openIssue}</ToastActionButton>
            <ToastActionButton
               disabled={linkCopied}
               onClick={() => {
                  setLinkCopied(true);
                  onCopyLink();
               }}
            >
               {fa.issue.copyLink}
            </ToastActionButton>
            <ToastActionButton
               disabled={messageSending || messageSent}
               onClick={async () => {
                  setMessageSending(true);
                  const sent = await onSendMessage();
                  setMessageSending(false);
                  if (sent) setMessageSent(true);
               }}
            >
               {fa.issue.sendTaskSms}
            </ToastActionButton>
         </div>
      </div>
   );
}
