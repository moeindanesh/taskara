import {
   useCallback,
   useEffect,
   useMemo,
   useRef,
   useState,
   type FormEvent,
   type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
   Box,
   Check,
   ChevronDown,
   Loader2,
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
import { DescriptionEditor } from '@/components/taskara/description-editor';
import { LinearAvatar, PriorityIcon, ProjectGlyph, StatusIcon, linearPriorityMeta, linearStatusMeta } from '@/components/taskara/linear-ui';
import { TaskDueDateControl } from '@/components/taskara/task-due-date-control';
import { taskaraRequest } from '@/lib/taskara-client';
import { fa } from '@/lib/fa-copy';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import type { TaskaraProject, TaskaraTask, TaskaraUser } from '@/lib/taskara-types';
import { taskPriorities, taskStatuses, taskWeights } from '@/lib/taskara-presenters';
import { cn } from '@/lib/utils';
import { useAuthSession } from '@/store/auth-store';

const workspaceComposerPreferenceStoragePrefix = 'taskara:workspace-task-composer-preferences';

const initialTaskForm = {
   projectId: '',
   title: '',
   description: '',
   status: 'TODO',
   priority: 'NO_PRIORITY',
   weight: '',
   assigneeId: '',
   dueAt: '',
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

export function WorkspaceTaskComposer() {
   const { session } = useAuthSession();
   const { projects, users, createTask } = useWorkspaceTaskSync();
   const navigate = useNavigate();
   const workspaceSlug = session?.workspace?.slug || 'taskara';
   const currentUserId = session?.user.id || null;
   const [open, setOpen] = useState(false);
   const [form, setForm] = useState(initialTaskForm);
   const [createMore, setCreateMore] = useState(false);
   const [submitting, setSubmitting] = useState(false);
   const preferencesHydratedRef = useRef(false);
   const restoredWorkspaceRef = useRef<string | null>(null);
   const titleInputRef = useRef<HTMLInputElement>(null);

   const usersForAssignee = useMemo(() => {
      if (!currentUserId) return users;
      const currentUser = users.find((user) => user.id === currentUserId);
      if (!currentUser) return users;
      return [currentUser, ...users.filter((user) => user.id !== currentUserId)];
   }, [currentUserId, users]);

   const selectedProject = projects.find((project) => project.id === form.projectId) || null;
   const selectedAssignee = users.find((user) => user.id === form.assigneeId) || null;

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
         if (projects.some((project) => project.id === current.projectId)) return current;
         return { ...current, projectId: projects[0]?.id || '' };
      });
   }, [projects]);

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

   const openComposer = useCallback(() => {
      setOpen(true);
   }, []);

   useEffect(() => {
      const handleCreateIssue = () => openComposer();
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
      const submittedStatus = form.status;
      const submittedWeight = form.weight;
      const submittedAssigneeId = form.assigneeId;

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
            dueAt: form.dueAt || undefined,
            labels: [],
            source: 'WEB',
         });

         if (isTaskCreateRetryableResult(createdTask)) {
            toast.success(createdTask.title, { description: fa.issue.createdOffline });
         } else {
            let createdToastId: string | number = '';
            createdToastId = toast.success(createdTask.title, {
               description: (
                  <CreatedTaskToastActions
                     onCopyLink={() => copyCreatedTaskLink(createdTask)}
                     onOpen={() => {
                        toast.dismiss(createdToastId);
                        openCreatedTask(createdTask);
                     }}
                     onSendMessage={() => sendCreatedTaskMessage(createdTask)}
                  />
               ),
            });
         }

         setForm({
            ...initialTaskForm,
            projectId: submittedProjectId,
            status: submittedStatus,
            weight: submittedWeight,
            assigneeId: createMore ? submittedAssigneeId : '',
         });
         if (!createMore) setOpen(false);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.createFailed);
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={setOpen}>
         <DialogContent
            aria-label={fa.issue.newIssue}
            showCloseButton={false}
            className="flex max-h-[calc(100svh-32px)] max-w-[860px] flex-col gap-0 overflow-hidden rounded-[18px] border-white/10 bg-[#1d1d20] p-0 text-zinc-100 shadow-[0_18px_70px_rgb(0_0_0/0.55)] sm:max-w-[860px]"
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

            <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
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
                     showToolbar={false}
                     variant="plain"
                     users={users}
                     value={form.description}
                     onChange={(description) => setForm((current) => ({ ...current, description }))}
                     placeholder={fa.issue.descriptionPlaceholder}
                  />

                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pb-4 lg:flex-nowrap">
                     <ComposerStatusPill
                        status={form.status}
                        onChange={(status) => setForm((current) => ({ ...current, status }))}
                     />
                     <ComposerPriorityPill
                        priority={form.priority}
                        onChange={(priority) => setForm((current) => ({ ...current, priority }))}
                     />
                     <ComposerAssigneePill
                        assignee={selectedAssignee}
                        currentUserId={currentUserId}
                        users={usersForAssignee}
                        onChange={(assigneeId) => setForm((current) => ({ ...current, assigneeId }))}
                     />
                     <ComposerProjectPill
                        project={selectedProject}
                        projects={projects}
                        onChange={(projectId) => setForm((current) => ({ ...current, projectId }))}
                     />
                     <ComposerWeightPill
                        weight={form.weight}
                        onChange={(weight) => setForm((current) => ({ ...current, weight }))}
                     />
                     <TaskDueDateControl
                        dueAt={form.dueAt || null}
                        className="h-6 w-[116px] shrink-0 rounded-full border-white/8 bg-[#2a2a2d] px-2.5 text-[12px] text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] hover:border-white/8 hover:bg-[#303033] hover:text-zinc-300"
                        iconClassName="size-3.5 text-zinc-500"
                        onChange={(dueAt) => setForm((current) => ({ ...current, dueAt: dueAt || '' }))}
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
         </DialogContent>
      </Dialog>
   );
}

function ComposerMenuPill({
   ariaLabel,
   className,
   contentClassName,
   children,
   icon,
   label,
   open,
   onOpenChange,
}: {
   ariaLabel: string;
   className?: string;
   contentClassName?: string;
   children: ReactNode;
   icon: ReactNode;
   label: ReactNode;
   open: boolean;
   onOpenChange: (open: boolean) => void;
}) {
   return (
      <Popover open={open} onOpenChange={onOpenChange}>
         <PopoverTrigger asChild>
            <button
               aria-label={ariaLabel}
               className={cn(
                  'inline-flex h-6 max-w-[168px] shrink-0 items-center gap-1.5 rounded-full border border-white/8 bg-[#2a2a2d] py-0 pl-2 pr-2.5 text-[12px] font-normal text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition hover:bg-[#303033] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/35',
                  className
               )}
               type="button"
            >
               <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
               <span className="min-w-0 flex-1 truncate text-start">{label}</span>
               <ChevronDown className="size-3.5 shrink-0 text-zinc-600" />
            </button>
         </PopoverTrigger>
         <PopoverContent
            align="start"
            className={cn('rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl', contentClassName)}
            sideOffset={8}
         >
            {children}
         </PopoverContent>
      </Popover>
   );
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
   title,
   value,
   onChange,
}: {
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
            placeholder={title}
         />
      </label>
   );
}

function ComposerStatusPill({ status, onChange }: { status: string; onChange: (status: string) => void }) {
   const [open, setOpen] = useState(false);
   const handleChange = (nextStatus: string) => {
      onChange(nextStatus);
      setOpen(false);
   };

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.status}
         contentClassName="w-auto min-w-[11rem]"
         icon={<StatusIcon status={status} className="size-3.5" />}
         label={linearStatusMeta[status]?.label || status}
         open={open}
         onOpenChange={setOpen}
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

function ComposerPriorityPill({ priority, onChange }: { priority: string; onChange: (priority: string) => void }) {
   const [open, setOpen] = useState(false);
   const handleChange = (nextPriority: string) => {
      onChange(nextPriority);
      setOpen(false);
   };

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.priority}
         contentClassName="w-auto min-w-[11rem]"
         icon={<PriorityIcon priority={priority} className="size-3.5" />}
         label={linearPriorityMeta[priority]?.label || priority}
         open={open}
         onOpenChange={setOpen}
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

function ComposerAssigneePill({
   assignee,
   currentUserId,
   users,
   onChange,
}: {
   assignee?: TaskaraTask['assignee'] | null;
   currentUserId: string | null;
   users: TaskaraUser[];
   onChange: (assigneeId: string) => void;
}) {
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState('');
   const filteredUsers = useMemo(() => filterUsers(users, query), [users, query]);
   const handleChange = (nextAssigneeId: string) => {
      onChange(nextAssigneeId);
      setOpen(false);
   };

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.assignee}
         contentClassName="w-80"
         icon={
            assignee ? (
               <LinearAvatar name={assignee.name} src={assignee.avatarUrl} className="size-4" />
            ) : (
               <UserRound className="size-3.5 text-zinc-500" />
            )
         }
         label={assignee ? assigneeLabel(assignee, currentUserId) : fa.issue.assignee}
         open={open}
         onOpenChange={setOpen}
      >
         <MenuSearchField title="جستجو بین کارمندان..." value={query} onChange={setQuery} />
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

function ComposerProjectPill({
   project,
   projects,
   onChange,
}: {
   project?: TaskaraProject | null;
   projects: TaskaraProject[];
   onChange: (projectId: string) => void;
}) {
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState('');
   const filteredProjects = useMemo(() => filterProjects(projects, query), [projects, query]);
   const handleChange = (nextProjectId: string) => {
      onChange(nextProjectId);
      setOpen(false);
   };
   const projectName = project?.name || fa.issue.project;

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.project}
         contentClassName="w-80"
         icon={<ProjectGlyph name={projectName} className="size-4 rounded" iconClassName="size-3" />}
         label={projectName}
         open={open}
         onOpenChange={setOpen}
      >
         <MenuSearchField title="جستجو بین پروژه‌ها..." value={query} onChange={setQuery} />
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

function ComposerWeightPill({ weight, onChange }: { weight: string; onChange: (weight: string) => void }) {
   const [open, setOpen] = useState(false);
   const handleChange = (nextWeight: string) => {
      onChange(nextWeight);
      setOpen(false);
   };
   const weightLabel = weight ? `${fa.issue.weight} ${Number(weight).toLocaleString('fa-IR')}` : fa.issue.weight;

   return (
      <ComposerMenuPill
         ariaLabel={fa.issue.weight}
         contentClassName="w-auto min-w-[11rem]"
         icon={weight ? <Box className="size-3.5 text-zinc-500" /> : <XCircle className="size-3.5 text-zinc-500" />}
         label={weightLabel}
         open={open}
         onOpenChange={setOpen}
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
