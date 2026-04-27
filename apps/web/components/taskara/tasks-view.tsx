'use client';

import type { ChangeEvent, CSSProperties, Dispatch, DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
   Check,
   CalendarClock,
   Box,
   CaseSensitive,
   ChevronDown,
   ChevronLeft,
   ChevronRight,
   CircleDashed,
   Copy,
   FolderKanban,
   Link as LinkIcon,
   LayoutGrid,
   LayoutList,
   Maximize2,
   Minimize2,
   MoreHorizontal,
   PanelRight,
   Paperclip,
   Plus,
   Repeat2,
   Rows3,
   Save,
   Search,
   Star,
   Tag,
   Trash2,
   X,
   XCircle,
} from 'lucide-react';
import {
   Dialog,
   DialogClose,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import {
   ContextMenu,
   ContextMenuContent,
   ContextMenuItem,
   ContextMenuSeparator,
   ContextMenuSub,
   ContextMenuSubContent,
   ContextMenuSubTrigger,
   ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
   LinearAvatar,
   LinearEmptyState,
   LinearPanel,
   LinearPill,
   NoAssigneeIcon,
   PriorityIcon,
   ShortcutKey,
   StatusIcon,
   linearPriorityMeta,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate, formatJalaliDateTimeInput } from '@/lib/jalali';
import { taskaraRequest, uploadTaskAttachment } from '@/lib/taskara-client';
import type { TaskUpdatePatch } from '@/lib/task-sync';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { useAuthSession } from '@/store/auth-store';
import type {
   TaskViewCompletedIssues,
   TaskViewDisplayProperty,
   TaskViewGrouping,
   TaskViewLayout,
   TaskViewOrdering,
   TaskViewSubGrouping,
   TaskaraProject,
   TaskaraTask,
   TaskaraTaskViewState,
   TaskaraTeam,
   TaskaraUser,
   TaskaraView,
} from '@/lib/taskara-types';
import { taskPriorities, taskStatuses } from '@/lib/taskara-presenters';
import { cn } from '@/lib/utils';
import { getUserColorsFromName } from '@/lib/name-colors';

const activeStatuses = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'];
const currentTeamFallback = 'all';
const createIssueShortcutKeys = new Set(['c', 'ز']);
const hasSystemShortcutModifier = (event: KeyboardEvent) => event.metaKey || event.ctrlKey || event.altKey;
const assigneeSearchPlaceholder = 'جستجو بین کارمندان...';
const noAssigneeSearchResult = 'کارمندی پیدا نشد';

const initialTaskForm = {
   projectId: '',
   title: '',
   description: '',
   status: 'TODO',
   priority: 'NO_PRIORITY',
   assigneeId: '',
   dueAt: '',
   labels: '',
};

type SystemViewKey = 'all' | 'active' | 'backlog';
type ActiveViewKey = `system:${SystemViewKey}` | string;
type MenuAnchor = { bottom: number; left: number; right: number; top: number; width: number; height: number };

type FilterSection = 'status' | 'assignee' | 'priority' | 'project' | 'labels';
type FilterMenuSection = FilterSection | 'content';
type FilterSubmenuSide = 'left' | 'right';

type GroupDescriptor = {
   key: string;
   label: string;
   toneClassName: string;
   toneStyle?: CSSProperties;
   icon: ReactNode;
   tasks: TaskaraTask[];
   offset: number;
};

const systemViewOrder: Array<{ key: SystemViewKey; label: string }> = [
   { key: 'all', label: fa.issue.all },
   { key: 'active', label: fa.issue.active },
   { key: 'backlog', label: fa.issue.backlog },
];

function getSystemViewKey(viewKey: ActiveViewKey): SystemViewKey | null {
   if (viewKey === 'system:all') return 'all';
   if (viewKey === 'system:active') return 'active';
   if (viewKey === 'system:backlog') return 'backlog';
   return null;
}

const layoutOptions: Array<{ value: TaskViewLayout; label: string; icon: typeof LayoutList }> = [
   { value: 'list', label: fa.issue.listView, icon: LayoutList },
   { value: 'board', label: fa.issue.boardView, icon: LayoutGrid },
];

const groupingOptions: Array<{ value: TaskViewGrouping; label: string }> = [
   { value: 'status', label: fa.issue.status },
   { value: 'assignee', label: fa.issue.assignee },
   { value: 'project', label: fa.issue.project },
   { value: 'priority', label: fa.issue.priority },
];

const orderingOptions: Array<{ value: TaskViewOrdering; label: string }> = [
   { value: 'priority', label: fa.issue.priority },
   { value: 'updatedAt', label: fa.issue.updatedAt },
   { value: 'createdAt', label: fa.issue.createdAt },
   { value: 'dueAt', label: fa.issue.dueAt },
   { value: 'title', label: 'عنوان' },
];

const linearGroupingOptions: Array<{ value: TaskViewGrouping; label: string }> = [
   { value: 'status', label: fa.issue.status },
   { value: 'assignee', label: fa.issue.assignee },
   { value: 'project', label: fa.issue.project },
   { value: 'priority', label: fa.issue.priority },
];

const linearSubGroupingOptions: Array<{ value: TaskViewSubGrouping; label: string }> = [
   { value: 'none', label: 'بدون گروه‌بندی' },
   ...linearGroupingOptions,
];

const linearOrderingOptions: Array<{ value: TaskViewOrdering; label: string }> = [
   { value: 'priority', label: fa.issue.priority },
   { value: 'updatedAt', label: fa.issue.updatedAt },
   { value: 'createdAt', label: fa.issue.createdAt },
   { value: 'dueAt', label: fa.issue.dueAt },
   { value: 'title', label: 'عنوان' },
];

const completedIssueOptions: Array<{ value: TaskViewCompletedIssues; label: string }> = [
   { value: 'all', label: 'همه' },
   { value: 'week', label: 'هفته گذشته' },
   { value: 'month', label: 'ماه گذشته' },
   { value: 'none', label: 'هیچ‌کدام' },
];

const defaultDisplayProperties: TaskViewDisplayProperty[] = [
   'id',
   'status',
   'assignee',
   'priority',
   'project',
   'dueAt',
   'labels',
   'createdAt',
];

const displayPropertyOptions: Array<{ value: TaskViewDisplayProperty; label: string }> = [
   { value: 'id', label: 'شناسه' },
   { value: 'status', label: fa.issue.status },
   { value: 'assignee', label: fa.issue.assignee },
   { value: 'priority', label: fa.issue.priority },
   { value: 'project', label: fa.issue.project },
   { value: 'dueAt', label: fa.issue.dueAt },
   { value: 'labels', label: fa.issue.labels },
];

const filterMenuCopy = {
   addFilter: 'افزودن فیلتر...',
   filterPlaceholder: 'فیلتر...',
   ai: 'فیلتر هوشمند',
   advanced: 'فیلتر پیشرفته',
   agent: fa.role.AGENT,
   creator: 'سازنده',
   relations: 'ارتباط‌ها',
   suggestedLabel: 'برچسب پیشنهادی',
   dates: 'تاریخ‌ها',
   projectProperties: 'ویژگی‌های پروژه',
   subscribers: 'دنبال‌کنندگان',
   autoClosed: 'بسته‌شده خودکار',
   content: 'محتوا',
   links: 'لینک‌ها',
   template: 'قالب',
   clearAll: 'پاک کردن همه فیلترها',
   noMatches: 'نتیجه‌ای پیدا نشد',
   contentHint: 'عنوان، توضیح، شناسه و پروژه',
};

const displayMenuCopy = {
   completedIssues: 'کارهای انجام‌شده',
   listOptions: 'گزینه‌های فهرست',
   displayProperties: 'ویژگی‌های نمایشی',
};

const taskCountLabel = (count: number) => `${count.toLocaleString('fa-IR')} کار`;

function viewDisplayDefaults() {
   return {
      subGroupBy: 'none' as const,
      showSubIssues: true,
      nestedSubIssues: false,
      orderCompletedByRecency: false,
      completedIssues: 'all' as const,
      displayProperties: [...defaultDisplayProperties],
   };
}

function buildSystemViewState(key: SystemViewKey, teamId: string): TaskaraTaskViewState {
   if (key === 'active') {
      return {
         scope: 'tasks',
         teamId,
         query: '',
         status: activeStatuses,
         assigneeIds: [],
         priority: [],
         projectIds: [],
         labels: [],
         layout: 'list',
         groupBy: 'status',
         orderBy: 'priority',
         showEmptyGroups: false,
         ...viewDisplayDefaults(),
      };
   }

   if (key === 'backlog') {
      return {
         scope: 'tasks',
         teamId,
         query: '',
         status: ['BACKLOG'],
         assigneeIds: [],
         priority: [],
         projectIds: [],
         labels: [],
         layout: 'list',
         groupBy: 'status',
         orderBy: 'priority',
         showEmptyGroups: false,
         ...viewDisplayDefaults(),
      };
   }

   return {
      scope: 'tasks',
      teamId,
      query: '',
      status: [],
      assigneeIds: [],
      priority: [],
      projectIds: [],
      labels: [],
      layout: 'list',
      groupBy: 'status',
      orderBy: 'priority',
      showEmptyGroups: false,
      ...viewDisplayDefaults(),
   };
}

function normalizeViewState(state: Partial<TaskaraTaskViewState> | undefined, teamId: string): TaskaraTaskViewState {
   return {
      ...buildSystemViewState('all', teamId),
      ...state,
      scope: 'tasks',
      teamId,
      query: state?.query || '',
      status: state?.status || [],
      assigneeIds: state?.assigneeIds || [],
      priority: state?.priority || [],
      projectIds: state?.projectIds || [],
      labels: state?.labels || [],
      subGroupBy: state?.subGroupBy || 'none',
      showSubIssues: state?.showSubIssues ?? true,
      nestedSubIssues: state?.nestedSubIssues ?? false,
      orderCompletedByRecency: state?.orderCompletedByRecency ?? false,
      completedIssues: state?.completedIssues || 'all',
      displayProperties: state?.displayProperties || [...defaultDisplayProperties],
   };
}

function compareDateString(a?: string | null, b?: string | null, fallback = 0) {
   if (!a && !b) return fallback;
   if (!a) return 1;
   if (!b) return -1;
   return new Date(a).getTime() - new Date(b).getTime();
}

function makeDueDate(daysFromNow: number) {
   const dueDate = new Date();
   dueDate.setDate(dueDate.getDate() + daysFromNow);
   dueDate.setHours(18, 0, 0, 0);
   return dueDate.toISOString();
}

function makeEndOfIranWorkWeek() {
   const dueDate = new Date();
   const day = dueDate.getDay();
   const daysUntilFriday = (5 - day + 7) % 7 || 7;
   dueDate.setDate(dueDate.getDate() + daysUntilFriday);
   dueDate.setHours(18, 0, 0, 0);
   return dueDate.toISOString();
}

function labelNames(task: TaskaraTask) {
   return (task.labels || []).map((item) => item.label.name);
}

function compareTasks(a: TaskaraTask, b: TaskaraTask, orderBy: TaskViewOrdering) {
   if (orderBy === 'title') return a.title.localeCompare(b.title, 'fa');
   if (orderBy === 'createdAt') return compareDateString(a.createdAt, b.createdAt);
   if (orderBy === 'updatedAt') return compareDateString(a.updatedAt, b.updatedAt);
   if (orderBy === 'dueAt') return compareDateString(a.dueAt, b.dueAt);

   const priorityIndexA = Math.max(taskPriorities.indexOf(a.priority as (typeof taskPriorities)[number]), 0);
   const priorityIndexB = Math.max(taskPriorities.indexOf(b.priority as (typeof taskPriorities)[number]), 0);
   if (priorityIndexA !== priorityIndexB) return priorityIndexB - priorityIndexA;
   return compareDateString(a.updatedAt, b.updatedAt, 0);
}

function taskMatchesQuery(task: TaskaraTask, query: string) {
   if (!query) return true;
   const normalizedQuery = query.trim().toLowerCase();
   return [task.key, task.title, task.description || '', task.project?.name || '']
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
}

function filterAssigneeUsers(users: TaskaraUser[], query: string) {
   const normalizedQuery = query.trim().toLocaleLowerCase('fa');
   if (!normalizedQuery) return users;
   return users.filter((user) =>
      [user.name, user.email, user.mattermostUsername || '']
         .join(' ')
         .toLocaleLowerCase('fa')
         .includes(normalizedQuery)
   );
}

function assigneeLabel(user: TaskaraUser, currentUserId: string | null) {
   return user.id === currentUserId ? `${user.name} (شما)` : user.name;
}

function matchesViewState(task: TaskaraTask, state: TaskaraTaskViewState) {
   if (state.status.length && !state.status.includes(task.status)) return false;
   if (
      state.assigneeIds.length &&
      !state.assigneeIds.some((value) => {
         if (value === 'unassigned') return !task.assignee?.id;
         return task.assignee?.id === value;
      })
   ) {
      return false;
   }
   if (state.priority.length && !state.priority.includes(task.priority)) return false;
   if (state.projectIds.length && !state.projectIds.includes(task.project?.id || '')) return false;
   if (state.labels.length && !(task.labels || []).some((item) => state.labels.includes(item.label.id))) return false;
   if (!matchesCompletedIssueSetting(task, state.completedIssues)) return false;
   return taskMatchesQuery(task, state.query);
}

function matchesCompletedIssueSetting(task: TaskaraTask, setting: TaskViewCompletedIssues) {
   const isCompleted = task.status === 'DONE' || task.status === 'CANCELED';
   if (!isCompleted || setting === 'all') return true;
   if (setting === 'none') return false;

   const completedAt = task.completedAt || task.updatedAt;
   if (!completedAt) return false;

   const age = Date.now() - new Date(completedAt).getTime();
   const maxAge = setting === 'week' ? 7 : 30;
   return age <= maxAge * 24 * 60 * 60 * 1000;
}

export function TasksView() {
   const location = useLocation();
   const navigate = useNavigate();
   const { orgId, teamId } = useParams();
   const { session } = useAuthSession();
   const activeTeamSlug = teamId && teamId !== currentTeamFallback ? teamId : null;
   const currentTeamKey = activeTeamSlug || currentTeamFallback;
   const isMyIssuesView = currentTeamKey === currentTeamFallback;
   const currentUserId = session?.user.id || null;
   const taskSync = useWorkspaceTaskSync();
   const {
      tasks,
      projects,
      teams,
      users,
      views: syncedViews,
      loading,
      error,
      refresh: load,
      createTask: createSyncedTask,
      updateTask: updateSyncedTask,
      deleteTask: deleteSyncedTask,
   } = taskSync;

   const [views, setViews] = useState<TaskaraView[]>([]);
   const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
   const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
   const [composerOpen, setComposerOpen] = useState(false);
   const [composerFullscreen, setComposerFullscreen] = useState(false);
   const [createMore, setCreateMore] = useState(false);
   const [form, setForm] = useState(initialTaskForm);
   const [composerFiles, setComposerFiles] = useState<File[]>([]);
   const [composerSubmitting, setComposerSubmitting] = useState(false);
   const [composerDraggingFiles, setComposerDraggingFiles] = useState(false);
   const [isPending, startTransition] = useTransition();
   const [activeViewKey, setActiveViewKey] = useState<ActiveViewKey>('system:active');
   const [draftView, setDraftView] = useState<TaskaraTaskViewState>(() =>
      buildSystemViewState('active', currentTeamKey)
   );
   const [filterOpen, setFilterOpen] = useState(false);
   const [displayOpen, setDisplayOpen] = useState(false);
   const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
   const [activeFilterSection, setActiveFilterSection] = useState<FilterMenuSection | null>(null);
   const [saveDialogOpen, setSaveDialogOpen] = useState(false);
   const [saveMode, setSaveMode] = useState<'create' | 'update'>('create');
   const [viewName, setViewName] = useState('');
   const [viewShared, setViewShared] = useState(true);
   const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
   const composerFileInputRef = useRef<HTMLInputElement>(null);

   const getDefaultMenuAnchor = useCallback((): MenuAnchor => {
      const right = Math.max(window.innerWidth - 24, 0);
      return {
         bottom: 56,
         height: 36,
         left: right - 36,
         right,
         top: 20,
         width: 36,
      };
   }, []);

   const getFilterSubmenuSide = useCallback((anchor: MenuAnchor): FilterSubmenuSide => {
      if (typeof window === 'undefined') return 'left';
      return anchor.left < window.innerWidth / 2 ? 'right' : 'left';
   }, []);

   const openFilterMenu = useCallback(
      (anchor?: MenuAnchor) => {
         setMenuAnchor(anchor || getDefaultMenuAnchor());
         setActiveFilterSection(null);
         setDisplayOpen(false);
         setFilterOpen(true);
      },
      [getDefaultMenuAnchor]
   );

   const openDisplayMenu = useCallback(
      (anchor?: MenuAnchor) => {
         setMenuAnchor(anchor || getDefaultMenuAnchor());
         setFilterOpen(false);
         setDisplayOpen(true);
      },
      [getDefaultMenuAnchor]
   );

   useEffect(() => {
      const openFilters = (event: Event) => {
         const detail = (event as CustomEvent<{ anchor?: MenuAnchor }>).detail;
         openFilterMenu(detail?.anchor);
      };
      const openDisplay = (event: Event) => {
         const detail = (event as CustomEvent<{ anchor?: MenuAnchor }>).detail;
         openDisplayMenu(detail?.anchor);
      };

      window.addEventListener('taskara:open-filters', openFilters);
      window.addEventListener('taskara:open-display', openDisplay);

      return () => {
         window.removeEventListener('taskara:open-filters', openFilters);
         window.removeEventListener('taskara:open-display', openDisplay);
      };
   }, [openDisplayMenu, openFilterMenu]);

   useEffect(() => {
      window.dispatchEvent(
         new CustomEvent('taskara:menu-state', {
            detail: { displayOpen, filterOpen },
         })
      );
   }, [displayOpen, filterOpen]);

   useEffect(() => {
      const nextState = buildSystemViewState('active', currentTeamKey);
      setActiveViewKey('system:active');
      setDraftView(nextState);
      setHighlightedIndex(null);
   }, [currentTeamKey]);

   const scopedSyncedViews = useMemo(
      () => syncedViews.filter((view) => (view.state.teamId || currentTeamFallback) === currentTeamKey),
      [currentTeamKey, syncedViews]
   );

   useEffect(() => {
      setViews(scopedSyncedViews);
   }, [scopedSyncedViews]);

   const scopedProjects = useMemo(
      () => (activeTeamSlug ? projects.filter((project) => project.team?.slug === activeTeamSlug) : projects),
      [activeTeamSlug, projects]
   );

   useEffect(() => {
      setForm((current) => ({
         ...current,
         projectId: scopedProjects.some((project) => project.id === current.projectId)
            ? current.projectId
            : scopedProjects[0]?.id || '',
      }));
   }, [scopedProjects]);

   const activeTeam = useMemo(
      () => (activeTeamSlug ? teams.find((team) => team.slug === activeTeamSlug) || null : null),
      [activeTeamSlug, teams]
   );

   const unassignedProjects = useMemo(
      () => projects.filter((project) => !project.team?.id),
      [projects]
   );

   const scopedTasks = useMemo(
      () => {
         const teamTasks = activeTeamSlug ? tasks.filter((task) => task.project?.team?.slug === activeTeamSlug) : tasks;
         return isMyIssuesView && currentUserId
            ? teamTasks.filter((task) => task.assignee?.id === currentUserId)
            : teamTasks;
      },
      [activeTeamSlug, currentUserId, isMyIssuesView, tasks]
   );

   useEffect(() => {
      setSelectedTaskId((current) => (current && scopedTasks.some((task) => task.id === current) ? current : null));
   }, [scopedTasks]);

   const labelOptions = useMemo(() => {
      const map = new Map<string, string>();
      for (const task of scopedTasks) {
         for (const item of task.labels || []) {
            map.set(item.label.id, item.label.name);
         }
      }
      return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'fa'));
   }, [scopedTasks]);

   const activeSavedView = useMemo(
      () => views.find((view) => view.id === activeViewKey) || null,
      [activeViewKey, views]
   );

   const hasDraftChanges = useMemo(() => {
      const systemViewKey = getSystemViewKey(activeViewKey);
      const baseline = activeSavedView
         ? normalizeViewState(activeSavedView.state, currentTeamKey)
         : systemViewKey
           ? buildSystemViewState(systemViewKey, currentTeamKey)
           : null;

      if (!baseline) return false;
      return JSON.stringify(baseline) !== JSON.stringify(draftView);
   }, [activeSavedView, activeViewKey, currentTeamKey, draftView]);

   const filteredTasks = useMemo(() => {
      return scopedTasks
         .filter((task) => (draftView.status.length ? draftView.status.includes(task.status) : true))
         .filter((task) =>
            draftView.assigneeIds.length
               ? draftView.assigneeIds.some((value) => {
                    if (value === 'unassigned') return !task.assignee?.id;
                    return task.assignee?.id === value;
                 })
               : true
         )
         .filter((task) => (draftView.priority.length ? draftView.priority.includes(task.priority) : true))
         .filter((task) => (draftView.projectIds.length ? draftView.projectIds.includes(task.project?.id || '') : true))
         .filter((task) =>
            draftView.labels.length
               ? (task.labels || []).some((item) => draftView.labels.includes(item.label.id))
               : true
         )
         .filter((task) => matchesCompletedIssueSetting(task, draftView.completedIssues))
         .filter((task) => taskMatchesQuery(task, draftView.query))
         .sort((a, b) => compareTasks(a, b, draftView.orderBy));
   }, [draftView, scopedTasks]);

   const groupedTasks = useMemo<GroupDescriptor[]>(() => {
      const groups: Array<Omit<GroupDescriptor, 'tasks' | 'offset'> & { tasks: TaskaraTask[] }> = [];

      const pushGroup = (group: Omit<GroupDescriptor, 'tasks' | 'offset'> & { tasks: TaskaraTask[] }) => {
         if (!draftView.showEmptyGroups && group.tasks.length === 0) return;
         groups.push(group);
      };

      if (draftView.groupBy === 'status') {
         for (const status of taskStatuses) {
            const tasksInGroup = filteredTasks.filter((task) => task.status === status);
            pushGroup({
               key: status,
               label: linearStatusMeta[status]?.label || status,
               icon: <StatusIcon status={status} />,
               toneClassName: linearStatusMeta[status]?.groupClassName || 'bg-white/5',
               tasks: tasksInGroup,
            });
         }
      } else if (draftView.groupBy === 'priority') {
         for (const priority of taskPriorities) {
            const tasksInGroup = filteredTasks.filter((task) => task.priority === priority);
            pushGroup({
               key: priority,
               label: linearPriorityMeta[priority]?.label || priority,
               icon: <PriorityIcon priority={priority} />,
               toneClassName: 'bg-white/[0.04]',
               tasks: tasksInGroup,
            });
         }
      } else if (draftView.groupBy === 'project') {
         const availableProjects = scopedProjects
            .map((project) => ({
               key: project.id,
               label: project.name,
               icon: <FolderKanban className="size-4 text-pink-400" />,
               toneClassName: 'bg-pink-500/7',
               tasks: filteredTasks.filter((task) => task.project?.id === project.id),
            }))
            .sort((a, b) => a.label.localeCompare(b.label, 'fa'));

         for (const project of availableProjects) pushGroup(project);
      } else {
         const availableUsers = [
            {
               key: 'unassigned',
               label: fa.issue.noAssignee,
               icon: <NoAssigneeIcon className="size-4 text-zinc-400" />,
               toneClassName: 'bg-white/[0.04]',
               tasks: filteredTasks.filter((task) => !task.assignee?.id),
            },
            ...users
               .map((user) => {
                  const colors = getUserColorsFromName(user.name);

                  return {
                     key: user.id,
                     label: user.name,
                     icon: <LinearAvatar name={user.name} src={user.avatarUrl} className="size-4" />,
                     toneClassName: '',
                     toneStyle: { backgroundColor: colors.groupBackground },
                     tasks: filteredTasks.filter((task) => task.assignee?.id === user.id),
                  };
               })
               .sort((a, b) => a.label.localeCompare(b.label, 'fa')),
         ];

         for (const user of availableUsers) pushGroup(user);
      }

      let offset = 0;
      return groups.map((group) => {
         const next = { ...group, offset };
         offset += group.tasks.length;
         return next;
      });
   }, [draftView.groupBy, draftView.showEmptyGroups, filteredTasks, scopedProjects, users]);

   const visibleTasks = useMemo(() => groupedTasks.flatMap((group) => group.tasks), [groupedTasks]);

   const viewCounts = useMemo(
      () => ({
         all: scopedTasks.length,
         active: scopedTasks.filter((task) => activeStatuses.includes(task.status)).length,
         backlog: scopedTasks.filter((task) => task.status === 'BACKLOG').length,
      }),
      [scopedTasks]
   );

   const openComposer = useCallback((fullscreen = false) => {
      setComposerFullscreen(fullscreen);
      setComposerOpen(true);
   }, []);

   const openIssuePage = useCallback(
      (task: TaskaraTask) => {
         if (task.syncState === 'pending') {
            toast.message(fa.issue.pendingSync);
            return;
         }
         navigate(`/${orgId || 'taskara'}/issue/${encodeURIComponent(task.key)}`, {
            state: {
               from: {
                  hash: location.hash,
                  pathname: location.pathname,
                  search: location.search,
               },
            },
         });
      },
      [location.hash, location.pathname, location.search, navigate, orgId]
   );

   useEffect(() => {
      const handleCreateIssue = () => openComposer(false);
      window.addEventListener('taskara:create-issue', handleCreateIssue);
      return () => window.removeEventListener('taskara:create-issue', handleCreateIssue);
   }, [openComposer]);

   useEffect(() => {
      if (composerOpen) return;
      setComposerFiles([]);
      setComposerDraggingFiles(false);
   }, [composerOpen]);

   const isEditableTarget = useCallback((target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
   }, []);

   useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
         if (isEditableTarget(event.target)) return;
         const key = event.key.toLowerCase();
         const hasSystemModifier = hasSystemShortcutModifier(event);

         if (!hasSystemModifier && key === 'f') {
            event.preventDefault();
            openFilterMenu();
            return;
         }

         if (!hasSystemModifier && createIssueShortcutKeys.has(key)) {
            event.preventDefault();
            openComposer(false);
            return;
         }

         if (!hasSystemModifier && event.shiftKey && key === 'v') {
            event.preventDefault();
            openDisplayMenu();
            return;
         }

         if (!hasSystemModifier && !event.shiftKey && key === 'v') {
            event.preventDefault();
            openComposer(true);
            return;
         }

         if (event.key === 'Escape') {
            setSelectedTaskId(null);
            setHighlightedIndex(null);
            return;
         }

         if (!hasSystemModifier && (event.key === 'ArrowDown' || key === 'j')) {
            event.preventDefault();
            setHighlightedIndex((current) => {
               if (visibleTasks.length === 0) return null;
               return current === null ? 0 : Math.min(current + 1, visibleTasks.length - 1);
            });
            return;
         }

         if (!hasSystemModifier && (event.key === 'ArrowUp' || key === 'k')) {
            event.preventDefault();
            setHighlightedIndex((current) => {
               if (visibleTasks.length === 0) return null;
               return current === null ? visibleTasks.length - 1 : Math.max(current - 1, 0);
            });
            return;
         }

         if (!hasSystemModifier && key === 'x') {
            event.preventDefault();
            const task = highlightedIndex === null ? null : visibleTasks[highlightedIndex];
            if (task) setSelectedTaskId((current) => (current === task.id ? null : task.id));
         }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
   }, [highlightedIndex, isEditableTarget, openComposer, openDisplayMenu, openFilterMenu, visibleTasks]);

   useEffect(() => {
      if (visibleTasks.length === 0) {
         setHighlightedIndex(null);
         setSelectedTaskId(null);
      } else if (highlightedIndex !== null && highlightedIndex > visibleTasks.length - 1) {
         setHighlightedIndex(visibleTasks.length - 1);
      }
   }, [highlightedIndex, visibleTasks.length]);

   const addComposerFiles = useCallback((files: FileList | File[]) => {
      const nextFiles = Array.from(files).filter((file) => file.size > 0);
      if (!nextFiles.length) return;
      setComposerFiles((current) => [...current, ...nextFiles]);
   }, []);

   const removeComposerFile = useCallback((index: number) => {
      setComposerFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
   }, []);

   const isComposerFileDrag = (event: DragEvent<HTMLElement>) =>
      Array.from(event.dataTransfer.types).includes('Files');

   const handleComposerFileChange = (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) addComposerFiles(event.target.files);
      event.target.value = '';
   };

   const handleComposerDragEnter = (event: DragEvent<HTMLElement>) => {
      if (!isComposerFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setComposerDraggingFiles(true);
   };

   const handleComposerDragOver = (event: DragEvent<HTMLElement>) => {
      if (!isComposerFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      setComposerDraggingFiles(true);
   };

   const handleComposerDragLeave = (event: DragEvent<HTMLElement>) => {
      if (!isComposerFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      const leftComposer =
         event.clientX <= bounds.left ||
         event.clientX >= bounds.right ||
         event.clientY <= bounds.top ||
         event.clientY >= bounds.bottom;
      if (leftComposer) setComposerDraggingFiles(false);
   };

   const handleComposerDrop = (event: DragEvent<HTMLElement>) => {
      if (!isComposerFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setComposerDraggingFiles(false);
      addComposerFiles(event.dataTransfer.files);
   };

   async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (composerSubmitting) return;
      if (!scopedProjects.length || !form.projectId) {
         toast.error(fa.issue.projectRequired);
         return;
      }
      if (!form.title.trim()) {
         toast.error(fa.issue.titleRequired);
         return;
      }

      try {
         setComposerSubmitting(true);
         const filesToUpload = [...composerFiles];
         const submittedProjectId = form.projectId;
         const submittedStatus = form.status;
         const assigneeId = form.assigneeId || (isMyIssuesView ? currentUserId || undefined : undefined);
         const createTaskPromise = createSyncedTask({
            projectId: form.projectId,
            title: form.title.trim(),
            description: form.description.trim() || undefined,
            status: form.status,
            priority: form.priority,
            assigneeId,
            dueAt: form.dueAt || undefined,
            labels: form.labels
               .split(',')
               .map((label) => label.trim())
               .filter(Boolean),
            source: 'WEB',
         });

         setSelectedTaskId(null);
         setComposerFiles([]);
         setForm({
            ...initialTaskForm,
            projectId: submittedProjectId,
            status: submittedStatus,
            priority: 'NO_PRIORITY',
         });
         if (!createMore) setComposerOpen(false);
         void handleCreatedTaskAttachments(createTaskPromise, filesToUpload);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.createFailed);
      } finally {
         setComposerSubmitting(false);
      }
   }

   async function handleCreatedTaskAttachments(createTaskPromise: Promise<TaskaraTask>, filesToUpload: File[]) {
      let createdTask: TaskaraTask;
      try {
         createdTask = await createTaskPromise;
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.createFailed);
         return;
      }

      const createdLocally = createdTask.syncState === 'pending';
      toast.success(createdLocally ? fa.issue.createdOffline : fa.issue.created);

      if (!filesToUpload.length) return;
      if (createdLocally) {
         toast.error(fa.issue.pendingAttachmentUpload);
         return;
      }

      const uploadResults = await Promise.allSettled(
         filesToUpload.map((file) => uploadTaskAttachment(createdTask.key || createdTask.id, file))
      );
      const failedUploads = uploadResults.filter((result) => result.status === 'rejected').length;
      const successfulUploads = filesToUpload.length - failedUploads;

      if (successfulUploads > 0) {
         toast.success(
            successfulUploads === 1
               ? fa.issue.attachmentUploaded
               : fa.issue.attachmentsUploaded.replace('{count}', successfulUploads.toLocaleString('fa-IR'))
         );
      }
      if (failedUploads > 0) {
         toast.error(fa.issue.attachmentUploadFailed);
      }
   }

   const handleComposerSubmitShortcut = (event: ReactKeyboardEvent<HTMLFormElement>) => {
      if (event.key !== 'Enter' || !event.metaKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.currentTarget.requestSubmit();
   };

   async function updateTask(task: TaskaraTask, patch: TaskUpdatePatch) {
      try {
         await updateSyncedTask(task, patch);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.updateFailed);
      }
   }

   async function deleteTask(task: TaskaraTask) {
      if (!window.confirm(`${fa.issue.deleteConfirm}\n${task.key} ${task.title}`)) return;

      try {
         await deleteSyncedTask(task);
         setSelectedTaskId((current) => (current === task.id ? null : current));
         setHighlightedIndex(null);
         toast.success(fa.issue.deleted);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.deleteFailed);
      }
   }

   function applySystemView(key: SystemViewKey) {
      setActiveViewKey(`system:${key}`);
      setDraftView(buildSystemViewState(key, currentTeamKey));
      setSelectedTaskId(null);
      setHighlightedIndex(null);
   }

   function applySavedView(view: TaskaraView) {
      setActiveViewKey(view.id);
      setDraftView(normalizeViewState(view.state, currentTeamKey));
      setSelectedTaskId(null);
      setHighlightedIndex(null);
   }

   function toggleArrayFilter(key: FilterSection, value: string) {
      const property =
         key === 'status'
            ? 'status'
            : key === 'assignee'
              ? 'assigneeIds'
              : key === 'priority'
                ? 'priority'
                : key === 'project'
                  ? 'projectIds'
                  : 'labels';

      setDraftView((current) => {
         const currentValues = current[property];
         const nextValues = currentValues.includes(value)
            ? currentValues.filter((item) => item !== value)
            : [...currentValues, value];
         return { ...current, [property]: nextValues };
      });
   }

   function clearFilters() {
      setDraftView((current) => ({
         ...current,
         query: '',
         status: [],
         assigneeIds: [],
         priority: [],
         projectIds: [],
         labels: [],
      }));
   }

   function toggleGroup(groupKey: string) {
      setCollapsedGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }));
   }

   function openComposerForGroup(group: GroupDescriptor) {
      setForm((current) => {
         if (draftView.groupBy === 'status') return { ...current, status: group.key };
         if (draftView.groupBy === 'priority') return { ...current, priority: group.key };
         if (draftView.groupBy === 'assignee') {
            return { ...current, assigneeId: group.key === 'unassigned' ? '' : group.key };
         }
         if (draftView.groupBy === 'project') return { ...current, projectId: group.key };
         return current;
      });
      openComposer(false);
   }

   async function createView() {
      try {
         const created = await taskaraRequest<TaskaraView>('/views', {
            method: 'POST',
            body: JSON.stringify({
               name: viewName.trim(),
               isShared: viewShared,
               state: draftView,
            }),
         });
         setViews((current) => [created, ...current]);
         setActiveViewKey(created.id);
         setSaveDialogOpen(false);
         toast.success(fa.issue.saveView);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.saveView);
      }
   }

   async function updateView() {
      if (!activeSavedView) return;
      try {
         const updated = await taskaraRequest<TaskaraView>(`/views/${activeSavedView.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
               name: viewName.trim() || activeSavedView.name,
               isShared: viewShared,
               state: draftView,
            }),
         });
         setViews((current) => current.map((view) => (view.id === updated.id ? updated : view)));
         setActiveViewKey(updated.id);
         setSaveDialogOpen(false);
         toast.success(fa.issue.updateView);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.updateView);
      }
   }

   async function deleteActiveView() {
      if (!activeSavedView) return;
      try {
         await taskaraRequest(`/views/${activeSavedView.id}`, { method: 'DELETE' });
         setViews((current) => current.filter((view) => view.id !== activeSavedView.id));
         applySystemView('active');
         toast.success(fa.issue.deleteView);
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.issue.deleteView);
      }
   }

   async function assignProjectToActiveTeam(projectId: string) {
      if (!activeTeam) return;

      try {
         await taskaraRequest(`/projects/${projectId}`, {
            method: 'PATCH',
            body: JSON.stringify({ teamId: activeTeam.id }),
         });
         toast.success(fa.project.teamUpdated);
         startTransition(() => {
            void load();
         });
      } catch (err) {
         toast.error(err instanceof Error ? err.message : fa.project.teamUpdateFailed);
      }
   }

   const selectedSavedViewCount = useMemo(() => {
      return activeSavedView
         ? scopedTasks.filter((task) => matchesViewState(task, normalizeViewState(activeSavedView.state, currentTeamKey)))
              .length
         : 0;
   }, [activeSavedView, currentTeamKey, scopedTasks]);

   const usersForAssignee = useMemo(() => {
      if (!currentUserId) return users;
      const currentUser = users.find((user) => user.id === currentUserId);
      if (!currentUser) return users;
      return [currentUser, ...users.filter((user) => user.id !== currentUserId)];
   }, [currentUserId, users]);

   const activeFilterCount =
      draftView.status.length +
      draftView.assigneeIds.length +
      draftView.priority.length +
      draftView.projectIds.length +
      draftView.labels.length +
      (draftView.query.trim() ? 1 : 0);
   const composerProject = scopedProjects.find((project) => project.id === form.projectId) || scopedProjects[0] || null;
   const composerAssignee = users.find((user) => user.id === form.assigneeId) || null;

   return (
      <div className="h-full bg-[#101011]" data-testid="issues-screen">
         {error ? (
            <p className="mx-4 mt-4 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
               {error}
            </p>
         ) : null}

         <div className="grid h-full lg:grid-cols-1">
            <main className="min-w-0 overflow-hidden">
               <div className="border-b border-white/6 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                     <div className="flex flex-wrap items-center gap-2">
                        {systemViewOrder.map((view) => (
                           <ViewChip
                              key={view.key}
                              active={activeViewKey === `system:${view.key}`}
                              onClick={() => applySystemView(view.key)}
                           >
                              {view.label}
                              <span>{viewCounts[view.key].toLocaleString('fa-IR')}</span>
                           </ViewChip>
                        ))}
                        {views.map((view) => (
                           <ViewChip
                              key={view.id}
                              active={activeViewKey === view.id}
                              onClick={() => applySavedView(view)}
                           >
                              {view.name}
                              {activeViewKey === view.id ? (
                                 <span>{selectedSavedViewCount.toLocaleString('fa-IR')}</span>
                              ) : null}
                           </ViewChip>
                        ))}
                     </div>

                     <div className="flex items-center gap-1.5">
                        <Button
                           aria-label={activeSavedView ? fa.issue.updateView : fa.issue.saveView}
                           size="icon"
                           variant="ghost"
                           className={cn(
                              'size-8 rounded-full border border-white/8 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100',
                              !hasDraftChanges && 'hidden'
                           )}
                           onClick={() => {
                              if (activeSavedView) {
                                 setSaveMode('update');
                                 setViewName(activeSavedView.name);
                                 setViewShared(activeSavedView.isShared);
                              } else {
                                 setSaveMode('create');
                                 setViewName('');
                                 setViewShared(true);
                              }
                              setSaveDialogOpen(true);
                           }}
                        >
                           <Save className="size-4" />
                        </Button>

                     </div>
                  </div>
               </div>

               <div className="h-[calc(100%-61px)] overflow-auto">
                  {loading ? (
                     <div className="p-4 text-sm text-zinc-500">{fa.app.loading}</div>
                  ) : activeTeam && scopedProjects.length === 0 && unassignedProjects.length > 0 ? (
                     <TeamProjectAttachEmpty
                        projects={unassignedProjects}
                        teamName={activeTeam.name}
                        onAssign={(projectId) => void assignProjectToActiveTeam(projectId)}
                     />
                  ) : groupedTasks.length === 0 || visibleTasks.length === 0 ? (
                     <div className="p-5">
                        <LinearEmptyState>{fa.issue.noMatchingIssues}</LinearEmptyState>
                     </div>
                  ) : draftView.layout === 'board' ? (
                     <div className="flex h-full gap-3 overflow-x-auto px-3 py-3">
                        {groupedTasks.map((group) => (
                           <BoardGroup
                              key={group.key}
                              collapsed={Boolean(collapsedGroups[group.key])}
                              displayProperties={draftView.displayProperties}
                              group={group}
                              highlightedIndex={highlightedIndex}
                              labelOptions={labelOptions}
                              projects={scopedProjects}
                              selectedTaskId={selectedTaskId}
                              onAdd={() => openComposerForGroup(group)}
                              onDelete={(task) => void deleteTask(task)}
                              onOpen={openIssuePage}
                              onAssigneeChange={(task, assigneeId) => void updateTask(task, { assigneeId })}
                              onDueAtChange={(task, dueAt) => void updateTask(task, { dueAt })}
                              onLabelsChange={(task, labels) => void updateTask(task, { labels })}
                              onPriorityChange={(task, priority) => void updateTask(task, { priority })}
                              onProjectChange={(task, projectId) => void updateTask(task, { projectId })}
                              onSelect={(task, absoluteIndex) => {
                                 setSelectedTaskId(task.id);
                                 setHighlightedIndex(absoluteIndex);
                              }}
                              onStatusChange={(task, status) => void updateTask(task, { status })}
                              onToggleCollapse={() => toggleGroup(group.key)}
                              users={usersForAssignee}
                           />
                        ))}
                     </div>
                  ) : (
                     <div>
                        {groupedTasks.map((group) => (
                           <ListGroup
                              key={group.key}
                              collapsed={Boolean(collapsedGroups[group.key])}
                              displayProperties={draftView.displayProperties}
                              group={group}
                              highlightedIndex={highlightedIndex}
                              labelOptions={labelOptions}
                              projects={scopedProjects}
                              selectedTaskId={selectedTaskId}
                              onAdd={() => openComposerForGroup(group)}
                              onDelete={(task) => void deleteTask(task)}
                              onOpen={openIssuePage}
                              onPriorityChange={(task, priority) => void updateTask(task, { priority })}
                              onProjectChange={(task, projectId) => void updateTask(task, { projectId })}
                              onSelect={(task, absoluteIndex) => {
                                 setSelectedTaskId(task.id);
                                 setHighlightedIndex(absoluteIndex);
                              }}
                              onStatusChange={(task, status) => void updateTask(task, { status })}
                              onAssigneeChange={(task, assigneeId) => void updateTask(task, { assigneeId })}
                              onDueAtChange={(task, dueAt) => void updateTask(task, { dueAt })}
                              onLabelsChange={(task, labels) => void updateTask(task, { labels })}
                              onToggleCollapse={() => toggleGroup(group.key)}
                              users={usersForAssignee}
                           />
                        ))}
                     </div>
                  )}
               </div>
            </main>

         </div>

         <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
            <DialogContent className="border-white/10 bg-[#1d1d20] text-zinc-100">
               <DialogHeader>
                  <DialogTitle>{saveMode === 'create' ? fa.issue.saveAsNewView : fa.issue.updateView}</DialogTitle>
                  <DialogDescription className="text-zinc-500">
                     {fa.issue.saveView}
                  </DialogDescription>
               </DialogHeader>
               <div className="space-y-4">
                  <div className="space-y-2">
                     <label className="text-sm text-zinc-400" htmlFor="view-name">
                        {fa.issue.viewName}
                     </label>
                     <Input
                        id="view-name"
                        className="border-white/8 bg-white/[0.03] text-zinc-100"
                        value={viewName}
                        onChange={(event) => setViewName(event.target.value)}
                     />
                  </div>
                  <label className="flex items-center justify-between rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2">
                     <span className="text-sm text-zinc-300">{fa.issue.sharedView}</span>
                     <input
                        checked={viewShared}
                        className="h-4 w-4 accent-indigo-500"
                        onChange={(event) => setViewShared(event.target.checked)}
                        type="checkbox"
                     />
                  </label>
                  <div className="flex justify-end gap-2">
                     <Button variant="ghost" onClick={() => setSaveDialogOpen(false)}>
                        {fa.app.cancel}
                     </Button>
                     <Button
                        className="bg-indigo-500 hover:bg-indigo-400"
                        disabled={!viewName.trim()}
                        onClick={() => void (saveMode === 'create' ? createView() : updateView())}
                     >
                        {saveMode === 'create' ? fa.issue.saveView : fa.issue.updateView}
                     </Button>
                  </div>
               </div>
            </DialogContent>
         </Dialog>

         {filterOpen && menuAnchor ? (
            <LinearFloatingPanel anchor={menuAnchor} width={280} onClose={() => setFilterOpen(false)}>
               <TaskFilterPopover
                  activeSection={activeFilterSection}
                  activeFilterCount={activeFilterCount}
                  currentUserId={currentUserId}
                  draftView={draftView}
                  labelOptions={labelOptions}
                  projects={scopedProjects}
                  tasks={scopedTasks}
                  users={users}
                  submenuSide={getFilterSubmenuSide(menuAnchor)}
                  onClear={clearFilters}
                  onSetQuery={(query) => setDraftView((current) => ({ ...current, query }))}
                  onSectionChange={setActiveFilterSection}
                  onToggle={(section, value) => toggleArrayFilter(section, value)}
               />
            </LinearFloatingPanel>
         ) : null}

         {displayOpen && menuAnchor ? (
            <LinearFloatingPanel anchor={menuAnchor} width={320} onClose={() => setDisplayOpen(false)}>
               <TaskDisplayPopover draftView={draftView} onChange={setDraftView} />
            </LinearFloatingPanel>
         ) : null}

         <Dialog
            open={composerOpen}
            onOpenChange={(open) => {
               setComposerOpen(open);
               if (!open) setComposerFullscreen(false);
            }}
         >
            <DialogContent
               aria-label={fa.issue.newIssue}
               showCloseButton={false}
               className={cn(
                  'flex max-h-[calc(100svh-32px)] flex-col gap-0 overflow-hidden rounded-[18px] border-white/10 bg-[#1d1d20] p-0 text-zinc-100 shadow-[0_18px_70px_rgb(0_0_0/0.55)]',
                  composerFullscreen
                     ? 'h-[calc(100svh-48px)] max-w-[calc(100vw-48px)] sm:max-w-[calc(100vw-48px)]'
                     : 'top-[35%] max-w-[760px] sm:max-w-[760px]'
               )}
               onDragEnter={handleComposerDragEnter}
               onDragLeave={handleComposerDragLeave}
               onDragOver={handleComposerDragOver}
               onDrop={handleComposerDrop}
            >
               <div
                  aria-hidden="true"
                  className={cn(
                     'pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[18px] border border-indigo-400/70 bg-indigo-500/12 text-sm font-medium text-indigo-100 opacity-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] backdrop-blur-[1px] transition-opacity',
                     composerDraggingFiles && 'opacity-100'
                  )}
               >
                  {fa.issue.dropAttachments}
               </div>
               <DialogHeader className="relative px-5 pt-4 pb-0 text-right">
                  <div className="absolute top-4 end-4 flex items-center gap-2">
                     <button
                        aria-label={fa.issue.createFullscreen}
                        className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/6 hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-indigo-400/60 focus-visible:outline-none"
                        title={fa.issue.createFullscreen}
                        type="button"
                        onClick={() => setComposerFullscreen((current) => !current)}
                     >
                        {composerFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                     </button>
                     <DialogClose asChild>
                        <button
                           aria-label={fa.app.close}
                           className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/6 hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-indigo-400/60 focus-visible:outline-none"
                           title={fa.app.close}
                           type="button"
                        >
                           <X className="size-4" />
                        </button>
                     </DialogClose>
                  </div>
                  <DialogTitle className="flex min-w-0 items-center gap-2 pe-20 text-sm font-semibold text-zinc-200">
                     <LinearPill className="h-7 max-w-[190px] shrink-0 font-normal">
                        <span className="inline-flex size-4 items-center justify-center rounded bg-pink-500/15 text-pink-300">
                           <FolderKanban className="size-3" />
                        </span>
                        <span className="truncate">{composerProject?.name || fa.project.newProject}</span>
                     </LinearPill>
                     <ChevronLeft className="size-4 shrink-0 text-zinc-600" />
                     <span>{fa.issue.newIssue}</span>
                  </DialogTitle>
                  <DialogDescription className="sr-only">{fa.issue.createIssue}</DialogDescription>
               </DialogHeader>

               <form className="flex min-h-0 flex-1 flex-col" onKeyDown={handleComposerSubmitShortcut} onSubmit={handleCreateTask}>
                  <div
                     className={cn(
                        'flex min-h-[246px] flex-1 flex-col px-5 pt-7',
                        composerFullscreen && 'min-h-0 overflow-auto'
                     )}
                  >
                     <Input
                        autoFocus
                     className="h-auto border-none bg-transparent px-0 text-xl leading-7 font-semibold text-zinc-100 shadow-none outline-none placeholder:text-zinc-600 focus-visible:ring-0"
                        value={form.title}
                        onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                        placeholder={fa.issue.titlePlaceholder}
                     />
                     <Textarea
                     className="mt-2 min-h-16 resize-none border-none bg-transparent px-0 text-sm leading-6 text-zinc-300 shadow-none placeholder:text-zinc-600 focus-visible:ring-0"
                        value={form.description}
                        onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                        placeholder={fa.issue.descriptionPlaceholder}
                     />
                     {composerFiles.length ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                           {composerFiles.map((file, index) => (
                              <span
                                 key={`${file.name}-${file.lastModified}-${index}`}
                                 className="inline-flex h-7 max-w-full items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] ps-2.5 pe-1 text-xs text-zinc-300"
                              >
                                 <Paperclip className="size-3.5 shrink-0 text-zinc-500" />
                                 <span className="min-w-0 max-w-[220px] truncate">{file.name}</span>
                                 <span className="shrink-0 text-zinc-600">{formatFileSize(file.size)}</span>
                                 <button
                                    aria-label={fa.issue.removeAttachment}
                                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-indigo-400/60 focus-visible:outline-none"
                                    type="button"
                                    onClick={() => removeComposerFile(index)}
                                 >
                                    <X className="size-3.5" />
                                 </button>
                              </span>
                           ))}
                        </div>
                     ) : null}
                     <div className="mt-auto flex flex-wrap items-center gap-1.5 pb-4">
                        <ComposerSelectPill
                           ariaLabel={fa.issue.status}
                           icon={<StatusIcon status={form.status} className="size-3.5" />}
                           value={form.status}
                           onChange={(status) => setForm((current) => ({ ...current, status }))}
                        >
                           {taskStatuses.map((status) => (
                              <option key={status} value={status}>
                                 {linearStatusMeta[status]?.label || status}
                              </option>
                           ))}
                        </ComposerSelectPill>
                        <ComposerSelectPill
                           ariaLabel={fa.issue.priority}
                           icon={<PriorityIcon priority={form.priority} className="size-3.5" />}
                           value={form.priority}
                           onChange={(priority) => setForm((current) => ({ ...current, priority }))}
                        >
                           {taskPriorities.map((priority) => (
                              <option key={priority} value={priority}>
                                 {linearPriorityMeta[priority]?.label || priority}
                              </option>
                           ))}
                        </ComposerSelectPill>
                        <ComposerSelectPill
                           ariaLabel={fa.issue.assignee}
                           icon={
                              composerAssignee ? (
                                 <LinearAvatar
                                    name={composerAssignee.name}
                                    src={composerAssignee.avatarUrl}
                                    className="size-4"
                                 />
                              ) : (
                                 <NoAssigneeIcon className="size-3.5 text-zinc-500" />
                              )
                           }
                           value={form.assigneeId}
                           onChange={(assigneeId) => setForm((current) => ({ ...current, assigneeId }))}
                        >
                           <option value="">{fa.app.unset}</option>
                           {usersForAssignee.map((user) => (
                              <option key={user.id} value={user.id}>
                                 {assigneeLabel(user, currentUserId)}
                              </option>
                           ))}
                        </ComposerSelectPill>
                        <ComposerSelectPill
                           ariaLabel={fa.issue.project}
                           icon={<FolderKanban className="size-3.5 text-pink-400" />}
                           value={form.projectId}
                           onChange={(projectId) => setForm((current) => ({ ...current, projectId }))}
                        >
                           {scopedProjects.map((project) => (
                              <option key={project.id} value={project.id}>
                                 {project.name}
                              </option>
                           ))}
                        </ComposerSelectPill>
                        <ComposerTextPill
                           ariaLabel={fa.issue.labels}
                           icon={<Tag className="size-3.5 text-zinc-500" />}
                           value={form.labels}
                           onChange={(event) => setForm((current) => ({ ...current, labels: event.target.value }))}
                           placeholder={fa.issue.labels}
                        />
                        <Popover>
                           <PopoverTrigger asChild>
                              <button
                                 aria-label={fa.app.more}
                                 className="inline-flex h-6 items-center justify-center rounded-full border border-white/8 bg-[#2a2a2d] px-2 text-zinc-500 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition hover:bg-[#303033] hover:text-zinc-300 focus-visible:ring-2 focus-visible:ring-indigo-400/35 focus-visible:outline-none"
                                 type="button"
                              >
                                 <MoreHorizontal className="size-3.5" />
                              </button>
                           </PopoverTrigger>
                           <PopoverContent
                              align="start"
                              className="w-80 rounded-xl border-white/10 bg-[#202023] p-3 text-zinc-100 shadow-2xl"
                              sideOffset={8}
                           >
                              <div className="space-y-3">
                                 <div className="text-xs font-medium text-zinc-500">{fa.issue.dueAt}</div>
                                 <LazyJalaliDatePicker
                                    ariaLabel={fa.issue.dueAt}
                                    value={form.dueAt}
                                    onChange={(dueAt) => setForm((current) => ({ ...current, dueAt: dueAt || '' }))}
                                 />
                                 <div className="text-xs text-zinc-600">
                                    {form.dueAt
                                       ? formatJalaliDateTimeInput(form.dueAt)
                                       : formatJalaliDateTimeInput(new Date().toISOString())}
                                 </div>
                              </div>
                           </PopoverContent>
                        </Popover>
                     </div>
                  </div>
                  <div className="flex items-center justify-between border-t border-white/7 px-5 py-3">
                     <input
                        ref={composerFileInputRef}
                        className="sr-only"
                        multiple
                        type="file"
                        onChange={handleComposerFileChange}
                     />
                     <button
                        aria-label={fa.issue.attachments}
                        className="inline-flex size-7 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-zinc-500 transition hover:bg-white/[0.08] hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-indigo-400/60 focus-visible:outline-none"
                        title={fa.issue.attachments}
                        type="button"
                        disabled={composerSubmitting}
                        onClick={() => composerFileInputRef.current?.click()}
                     >
                        <Paperclip className="size-4" />
                     </button>
                     <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-[13px] text-zinc-500" htmlFor="composer-create-more">
                           <Switch
                              checked={createMore}
                              className="border-0 data-[state=unchecked]:bg-white/14 data-[state=checked]:bg-indigo-500 [&_[data-slot=switch-thumb]]:bg-zinc-100 [&_[data-slot=switch-thumb]]:shadow-[0_1px_2px_rgb(0_0_0/0.35)] [&_[data-slot=switch-thumb][data-state=checked]]:-translate-x-4"
                              id="composer-create-more"
                              onCheckedChange={setCreateMore}
                              type="button"
                           />
                           <span>{fa.issue.createMore}</span>
                        </label>
                        <Button
                           disabled={composerSubmitting || isPending || !scopedProjects.length}
                           className="h-8 rounded-full bg-indigo-500 px-4 text-sm font-normal text-white hover:bg-indigo-400 disabled:bg-indigo-500/40"
                        >
                           {fa.issue.createIssue}
                        </Button>
                     </div>
                  </div>
               </form>
            </DialogContent>
         </Dialog>
      </div>
   );
}

function formatFileSize(bytes: number) {
   if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

   const units = ['B', 'KB', 'MB', 'GB'];
   let size = bytes;
   let unitIndex = 0;

   while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
   }

   return `${size.toLocaleString('fa-IR', {
      maximumFractionDigits: unitIndex === 0 ? 0 : 1,
   })} ${units[unitIndex]}`;
}

function ViewChip({
   active,
   children,
   onClick,
}: {
   active: boolean;
   children: ReactNode;
   onClick: () => void;
}) {
   return (
      <button
         className={cn(
            'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm transition',
            active
               ? 'border-white/10 bg-white/8 text-zinc-100'
               : 'border-white/7 bg-transparent text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
         )}
         type="button"
         onClick={onClick}
      >
         {children}
      </button>
   );
}

function ComposerSelectPill({
   ariaLabel,
   children,
   className,
   icon,
   onChange,
   value,
}: {
   ariaLabel: string;
   children: ReactNode;
   className?: string;
   icon: ReactNode;
   onChange: (value: string) => void;
   value: string;
}) {
   return (
      <label className={cn('relative inline-flex h-6 max-w-[168px] shrink-0', className)}>
         <span className="sr-only">{ariaLabel}</span>
         <span className="pointer-events-none absolute start-2 top-1/2 z-10 flex -translate-y-1/2 items-center">
            {icon}
         </span>
         <select
            aria-label={ariaLabel}
            className="h-6 min-w-0 cursor-pointer appearance-none rounded-full border border-white/8 bg-[#2a2a2d] py-0 ps-6 pe-2.5 text-[12px] font-normal text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] outline-none transition hover:bg-[#303033] focus:ring-2 focus:ring-indigo-400/35"
            value={value}
            onChange={(event) => onChange(event.target.value)}
         >
            {children}
         </select>
      </label>
   );
}

function ComposerTextPill({
   ariaLabel,
   icon,
   onChange,
   placeholder,
   value,
}: {
   ariaLabel: string;
   icon: ReactNode;
   onChange: (event: ChangeEvent<HTMLInputElement>) => void;
   placeholder: string;
   value: string;
}) {
   return (
      <label className="relative inline-flex h-6 w-[128px] shrink-0">
         <span className="sr-only">{ariaLabel}</span>
         <span className="pointer-events-none absolute start-2 top-1/2 z-10 flex -translate-y-1/2 items-center">
            {icon}
         </span>
         <input
            aria-label={ariaLabel}
            className="h-6 w-full rounded-full border border-white/8 bg-[#2a2a2d] py-0 ps-6 pe-2.5 text-[12px] font-normal text-zinc-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] outline-none transition placeholder:text-zinc-500 hover:bg-[#303033] focus:ring-2 focus:ring-indigo-400/35"
            value={value}
            onChange={onChange}
            placeholder={placeholder}
         />
      </label>
   );
}

function LinearFloatingPanel({
   anchor,
   children,
   onClose,
   width,
}: {
   anchor: MenuAnchor;
   children: ReactNode;
   onClose: () => void;
   width: number;
}) {
   const panelRef = useRef<HTMLDivElement>(null);
   const viewportWidth = typeof window === 'undefined' ? width + 24 : window.innerWidth;
   const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight;
   const panelWidth = Math.min(width, viewportWidth - 24);
   const right = Math.min(Math.max(viewportWidth - anchor.right, 12), Math.max(viewportWidth - panelWidth - 12, 12));
   const top = Math.min(anchor.bottom + 8, Math.max(viewportHeight - 80, 12));

   useEffect(() => {
      const handlePointerDown = (event: PointerEvent) => {
         if (panelRef.current?.contains(event.target as Node)) return;
         onClose();
      };
      const handleKeyDown = (event: KeyboardEvent) => {
         if (event.key === 'Escape') onClose();
      };

      window.addEventListener('pointerdown', handlePointerDown);
      window.addEventListener('keydown', handleKeyDown);
      return () => {
         window.removeEventListener('pointerdown', handlePointerDown);
         window.removeEventListener('keydown', handleKeyDown);
      };
   }, [onClose]);

   return (
      <div
         ref={panelRef}
         className="fixed z-50 text-zinc-100"
         dir="rtl"
         style={{ right, top, width: panelWidth }}
      >
         {children}
      </div>
   );
}

function TaskFilterPopover({
   activeSection,
   currentUserId,
   draftView,
   projects,
   users,
   labelOptions,
   tasks,
   activeFilterCount,
   submenuSide,
   onSectionChange,
   onSetQuery,
   onToggle,
   onClear,
}: {
   activeSection: FilterMenuSection | null;
   currentUserId: string | null;
   draftView: TaskaraTaskViewState;
   projects: TaskaraProject[];
   users: TaskaraUser[];
   labelOptions: Array<{ id: string; name: string }>;
   tasks: TaskaraTask[];
   activeFilterCount: number;
   submenuSide: FilterSubmenuSide;
   onSectionChange: Dispatch<SetStateAction<FilterMenuSection | null>>;
   onSetQuery: (query: string) => void;
   onToggle: (section: FilterSection, value: string) => void;
   onClear: () => void;
}) {
   const rootItems: Array<{
      key: string;
      label: string;
      icon: ReactNode;
      section?: FilterMenuSection;
      count?: number;
      separatorBefore?: boolean;
   }> = [
      {
         key: 'status',
         label: fa.issue.status,
         icon: <CircleDashed className="size-4 text-zinc-400" />,
         section: 'status',
         count: draftView.status.length,
      },
      {
         key: 'assignee',
         label: fa.issue.assignee,
         icon: <NoAssigneeIcon className="size-4 text-zinc-400" />,
         section: 'assignee',
         count: draftView.assigneeIds.length,
      },
      {
         key: 'priority',
         label: fa.issue.priority,
         icon: <Rows3 className="size-4 text-zinc-400" />,
         section: 'priority',
         count: draftView.priority.length,
      },
      {
         key: 'labels',
         label: fa.issue.labels,
         icon: <Tag className="size-4 text-zinc-400" />,
         section: 'labels',
         count: draftView.labels.length,
      },
      {
         key: 'project',
         label: fa.issue.project,
         icon: <Box className="size-4 text-zinc-400" />,
         section: 'project',
         count: draftView.projectIds.length,
      },
      {
         key: 'content',
         label: filterMenuCopy.content,
         icon: <CaseSensitive className="size-4 text-zinc-400" />,
         section: 'content',
         count: draftView.query.trim() ? 1 : 0,
      },
   ];

   return (
      <div className="relative w-full">
         <div
            className="overflow-y-auto rounded-lg border border-white/10 bg-[#1b1b1d] py-1 shadow-[0_18px_60px_rgb(0_0_0/0.5)]"
            style={{ maxHeight: 'min(360px, calc(100svh - 80px))' }}
         >
            <label className="flex h-9 items-center border-b border-white/7 px-2.5">
               <span className="sr-only">{filterMenuCopy.addFilter}</span>
               <input
                  className="h-full w-full bg-transparent text-sm font-normal text-zinc-200 outline-none placeholder:text-zinc-500"
                  value={draftView.query}
                  onChange={(event) => {
                     onSetQuery(event.target.value);
                     onSectionChange('content');
                  }}
                  onFocus={() => onSectionChange('content')}
                  placeholder={filterMenuCopy.addFilter}
               />
            </label>

            <div className="py-1">
               {rootItems.map((item) => (
                  <FilterRootRow
                     key={item.key}
                     active={activeSection === item.section}
                     count={item.count}
                     icon={item.icon}
                     label={item.label}
                     separatorBefore={item.separatorBefore}
                     onSelect={() => {
                        if (item.section) onSectionChange(item.section);
                     }}
                  />
               ))}
            </div>

            {activeFilterCount > 0 ? (
               <button
                  className="mx-1.5 mt-1 flex h-9 w-[calc(100%-12px)] items-center justify-center gap-2 rounded-lg text-xs text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-100"
                  type="button"
                  onClick={onClear}
               >
                  <XCircle className="size-4" />
                  {filterMenuCopy.clearAll}
               </button>
            ) : null}
         </div>

         {activeSection ? (
            <FilterSubmenu
               activeSection={activeSection}
               currentUserId={currentUserId}
               draftView={draftView}
               labelOptions={labelOptions}
               projects={projects}
               tasks={tasks}
               users={users}
               submenuSide={submenuSide}
               onSetQuery={onSetQuery}
               onToggle={onToggle}
            />
         ) : null}
      </div>
   );
}

function FilterRootRow({
   active,
   count,
   icon,
   label,
   onSelect,
   separatorBefore,
}: {
   active: boolean;
   count?: number;
   icon: ReactNode;
   label: string;
   onSelect: () => void;
   separatorBefore?: boolean;
}) {
   return (
      <>
         {separatorBefore ? <div className="my-1 h-px bg-white/7" /> : null}
         <button
            className={cn(
               'mx-1.5 flex h-9 w-[calc(100%-12px)] items-center gap-2.5 rounded-lg px-2.5 text-sm leading-none outline-none transition hover:bg-white/[0.04] hover:text-zinc-100 focus-visible:bg-white/[0.04] focus-visible:text-zinc-100',
               active
                  ? 'bg-white/[0.06] text-zinc-50'
                  : 'text-zinc-300'
            )}
            type="button"
            onClick={onSelect}
            onFocus={onSelect}
            onMouseEnter={onSelect}
         >
            <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
            <span className="min-w-0 flex-1 truncate text-start">{label}</span>
            {count ? <span className="text-xs text-zinc-500">{count.toLocaleString('fa-IR')}</span> : null}
            <ChevronLeft className="size-3.5 shrink-0 text-zinc-500" />
         </button>
      </>
   );
}

function FilterSubmenu({
   activeSection,
   currentUserId,
   draftView,
   labelOptions,
   projects,
   tasks,
   users,
   submenuSide,
   onSetQuery,
   onToggle,
}: {
   activeSection: FilterMenuSection;
   currentUserId: string | null;
   draftView: TaskaraTaskViewState;
   labelOptions: Array<{ id: string; name: string }>;
   projects: TaskaraProject[];
   tasks: TaskaraTask[];
   users: TaskaraUser[];
   submenuSide: FilterSubmenuSide;
   onSetQuery: (query: string) => void;
   onToggle: (section: FilterSection, value: string) => void;
}) {
   const [query, setQuery] = useState('');
   const currentUser = currentUserId ? users.find((user) => user.id === currentUserId) || null : null;
   const priorityOrder = ['NO_PRIORITY', 'URGENT', 'HIGH', 'MEDIUM', 'LOW'];
   const topBySection: Record<FilterMenuSection, number> = {
      status: 48,
      assignee: 84,
      priority: 120,
      labels: 156,
      project: 192,
      content: 228,
   };

   useEffect(() => {
      setQuery('');
   }, [activeSection]);

   const matchesQuery = (label: string) => label.toLowerCase().includes(query.trim().toLowerCase());
   const submenuStyle =
      submenuSide === 'right'
         ? { top: topBySection[activeSection], right: -268 }
         : { top: topBySection[activeSection], left: -268 };

   const options =
      activeSection === 'status'
         ? taskStatuses.map((status) => ({
              id: status,
              label: linearStatusMeta[status]?.label || status,
              active: draftView.status.includes(status),
              count: tasks.filter((task) => task.status === status).length,
              icon: <StatusIcon status={status} />,
              onClick: () => onToggle('status', status),
           }))
           : activeSection === 'assignee'
           ? [
                {
                   id: 'unassigned',
                   label: fa.issue.noAssignee,
                   active: draftView.assigneeIds.includes('unassigned'),
                   count: tasks.filter((task) => !task.assignee?.id).length,
                   icon: <NoAssigneeIcon className="size-4 text-zinc-400" />,
                   onClick: () => onToggle('assignee', 'unassigned'),
                },
                ...(currentUser
                   ? [
                        {
                           id: 'current-user',
                           label: fa.issue.currentUser,
                           active: draftView.assigneeIds.includes(currentUser.id),
                           count: tasks.filter((task) => task.assignee?.id === currentUser.id).length,
                           icon: <LinearAvatar name={currentUser.name} src={currentUser.avatarUrl} className="size-4" />,
                           onClick: () => onToggle('assignee', currentUser.id),
                        },
                     ]
                   : []),
                ...users
                   .filter((user) => user.id !== currentUserId)
                   .map((user) => ({
                      id: user.id,
                      label: user.name,
                      active: draftView.assigneeIds.includes(user.id),
                      count: tasks.filter((task) => task.assignee?.id === user.id).length,
                      icon: <LinearAvatar name={user.name} src={user.avatarUrl} className="size-4" />,
                      onClick: () => onToggle('assignee', user.id),
                   })),
             ]
           : activeSection === 'priority'
             ? priorityOrder.map((priority) => ({
                  id: priority,
                  label: linearPriorityMeta[priority]?.label || priority,
                  active: draftView.priority.includes(priority),
                  count: tasks.filter((task) => task.priority === priority).length,
                  icon: <PriorityIcon priority={priority} />,
                  onClick: () => onToggle('priority', priority),
               }))
             : activeSection === 'project'
               ? projects.map((project) => ({
                    id: project.id,
                    label: project.name,
                    active: draftView.projectIds.includes(project.id),
                    count: tasks.filter((task) => task.project?.id === project.id).length,
                    icon: <FolderKanban className="size-4 text-pink-400" />,
                    onClick: () => onToggle('project', project.id),
                 }))
               : activeSection === 'labels'
                 ? labelOptions.map((label) => ({
                      id: label.id,
                      label: label.name,
                      active: draftView.labels.includes(label.id),
                      count: tasks.filter((task) => (task.labels || []).some((item) => item.label.id === label.id)).length,
                      icon: <Tag className="size-4 text-zinc-400" />,
                      onClick: () => onToggle('labels', label.id),
                   }))
                 : [];

   const filteredOptions = options.filter((option) => matchesQuery(option.label));

   return (
      <div
         className="absolute w-[260px] overflow-hidden rounded-lg border border-white/10 bg-[#1b1b1d] shadow-[0_18px_60px_rgb(0_0_0/0.5)]"
         style={submenuStyle}
      >
         <label className="flex h-9 items-center border-b border-white/7 px-2.5">
            <span className="sr-only">{filterMenuCopy.filterPlaceholder}</span>
            <input
               className="h-full w-full bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
               value={activeSection === 'content' ? draftView.query : query}
               onChange={(event) => {
                  if (activeSection === 'content') {
                     onSetQuery(event.target.value);
                  } else {
                     setQuery(event.target.value);
                  }
               }}
               placeholder={filterMenuCopy.filterPlaceholder}
            />
         </label>

         <div className="max-h-[280px] overflow-y-auto p-1.5">
            {activeSection === 'content' ? (
               <div className="px-2.5 py-3 text-xs text-zinc-500">{filterMenuCopy.contentHint}</div>
            ) : filteredOptions.length ? (
               filteredOptions.map((option) => (
                  <FilterOptionRow
                     key={option.id}
                     active={option.active}
                     count={taskCountLabel(option.count)}
                     icon={option.icon}
                     label={option.label}
                     onClick={option.onClick}
                  />
               ))
            ) : (
               <div className="px-3 py-4 text-sm text-zinc-500">{filterMenuCopy.noMatches}</div>
            )}
         </div>
      </div>
   );
}

function FilterOptionRow({
   active,
   count,
   icon,
   label,
   onClick,
}: {
   active: boolean;
   count: string;
   icon: ReactNode;
   label: string;
   onClick: () => void;
}) {
   return (
      <button
         className={cn(
            'group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm leading-none outline-none transition hover:bg-white/[0.04] hover:text-zinc-100 focus-visible:bg-white/[0.04] focus-visible:text-zinc-100',
            active
               ? 'text-zinc-50'
               : 'text-zinc-300'
         )}
         type="button"
         onClick={onClick}
      >
         <span
            className={cn(
               'flex size-5 shrink-0 items-center justify-center rounded-md border border-transparent text-zinc-400 transition',
               active && 'text-zinc-100'
            )}
         >
            {active ? <Check className="size-3.5" /> : null}
         </span>
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className="min-w-0 flex-1 truncate text-start">{label}</span>
         <span className="shrink-0 text-xs text-zinc-500">{count}</span>
      </button>
   );
}

function TaskDisplayPopover({
   draftView,
   onChange,
}: {
   draftView: TaskaraTaskViewState;
   onChange: Dispatch<SetStateAction<TaskaraTaskViewState>>;
}) {
   const toggleDisplayProperty = (property: TaskViewDisplayProperty) => {
      onChange((current) => {
         const displayProperties = current.displayProperties.includes(property)
            ? current.displayProperties.filter((item) => item !== property)
            : [...current.displayProperties, property];
         return { ...current, displayProperties };
      });
   };

   return (
      <div
         className="overflow-y-auto rounded-lg border border-white/10 bg-[#1b1b1d] p-2 shadow-[0_18px_60px_rgb(0_0_0/0.5)]"
         style={{ maxHeight: 'min(460px, calc(100svh - 80px))' }}
      >
         <div className="grid grid-cols-2 gap-2">
            {layoutOptions.map((option) => {
               const Icon = option.icon;
               return (
                  <button
                     key={option.value}
                     className={cn(
                        'flex h-9 items-center justify-center gap-2 rounded-lg border text-sm leading-none transition',
                        draftView.layout === option.value
                           ? 'border-white/20 bg-transparent text-zinc-50'
                           : 'border-white/10 bg-transparent text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
                     )}
                     type="button"
                     onClick={() => onChange((current) => ({ ...current, layout: option.value }))}
                  >
                     <Icon className="size-4" />
                     {option.label}
                  </button>
               );
            })}
         </div>

         <div className="mt-3 space-y-2">
            <DisplaySettingRow label={fa.issue.grouping}>
               <LinearSelectControl
                  value={draftView.groupBy}
                  options={linearGroupingOptions}
                  onChange={(value) => onChange((current) => ({ ...current, groupBy: value as TaskViewGrouping }))}
               />
            </DisplaySettingRow>
            <DisplaySettingRow label={fa.issue.ordering}>
               <div className="flex items-center gap-2">
                  <Rows3 className="size-4 rotate-90 text-zinc-300" />
                  <LinearSelectControl
                     value={draftView.orderBy}
                     options={linearOrderingOptions}
                     onChange={(value) => onChange((current) => ({ ...current, orderBy: value as TaskViewOrdering }))}
                  />
               </div>
            </DisplaySettingRow>
         </div>

         <div className="my-3 h-px bg-white/7" />

         <div className="space-y-2">
            <DisplaySettingRow label={displayMenuCopy.completedIssues}>
               <LinearSelectControl
                  value={draftView.completedIssues}
                  options={completedIssueOptions}
                  onChange={(value) =>
                     onChange((current) => ({ ...current, completedIssues: value as TaskViewCompletedIssues }))
                  }
               />
            </DisplaySettingRow>
         </div>

         <div className="my-3 h-px bg-white/7" />

         <div>
            <div className="text-[15px] font-semibold text-zinc-100">{displayMenuCopy.listOptions}</div>
            <div className="mt-2 space-y-2">
               <DisplaySwitchRow
                  checked={draftView.showEmptyGroups}
                  label={fa.issue.showEmptyGroups}
                  onCheckedChange={(checked) => onChange((current) => ({ ...current, showEmptyGroups: checked }))}
               />
            </div>
         </div>

         <div className="mt-3">
            <div className="text-[15px] text-zinc-400">{displayMenuCopy.displayProperties}</div>
            <div className="mt-2 flex flex-wrap gap-2">
               {displayPropertyOptions.map((property) => (
                  <DisplayPropertyChip
                     key={property.value}
                     active={draftView.displayProperties.includes(property.value)}
                     label={property.label}
                     onClick={() => toggleDisplayProperty(property.value)}
                  />
               ))}
            </div>
         </div>
      </div>
   );
}

function LinearSelectControl<T extends string>({
   onChange,
   options,
   value,
}: {
   onChange: (value: T) => void;
   options: Array<{ value: T; label: string }>;
   value: T;
}) {
   return (
      <label className="relative inline-flex h-9 min-w-[116px]">
         <span className="sr-only">{value}</span>
         <select
            className="h-9 w-full cursor-pointer appearance-none rounded-lg border border-white/10 bg-[#2b2b2e] py-0 pe-8 ps-2.5 text-sm text-zinc-100 outline-none transition hover:bg-[#333336] focus:ring-2 focus:ring-indigo-400/35"
            value={value}
            onChange={(event) => onChange(event.target.value as T)}
         >
            {options.map((option) => (
               <option key={option.value} value={option.value}>
                  {option.label}
               </option>
            ))}
         </select>
         <ChevronDown className="pointer-events-none absolute end-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
      </label>
   );
}

function DisplaySettingRow({ label, children }: { label: string; children: ReactNode }) {
   return (
      <div className="flex min-h-9 items-center justify-between gap-3">
         <span className="text-xs font-medium leading-5 text-zinc-400">{label}</span>
         {children}
      </div>
   );
}

function DisplaySwitchRow({
   checked,
   label,
   onCheckedChange,
}: {
   checked: boolean;
   label: string;
   onCheckedChange: (checked: boolean) => void;
}) {
   return (
      <div className="flex min-h-9 items-center justify-between gap-3">
         <span className="text-xs font-medium leading-5 text-zinc-400">{label}</span>
         <Switch
            checked={checked}
            className="h-6 w-10 border-0 data-[state=checked]:bg-[#6266e8] data-[state=unchecked]:bg-[#6a6a70] [&_[data-slot=switch-thumb]]:size-5 [&_[data-slot=switch-thumb]]:bg-zinc-50 [&_[data-slot=switch-thumb][data-state=checked]]:-translate-x-4"
            onCheckedChange={onCheckedChange}
            type="button"
         />
      </div>
   );
}

function DisplayPropertyChip({
   active,
   label,
   onClick,
}: {
   active: boolean;
   label: string;
   onClick: () => void;
}) {
   return (
      <button
         className={cn(
            'h-8 rounded-full border px-3 text-xs font-medium transition',
            active
               ? 'border-white/20 bg-transparent text-zinc-50'
               : 'border-white/10 bg-transparent text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
         )}
         type="button"
         onClick={onClick}
      >
         {label}
      </button>
   );
}

function TeamProjectAttachEmpty({
   projects,
   teamName,
   onAssign,
}: {
   projects: TaskaraProject[];
   teamName: string;
   onAssign: (projectId: string) => void;
}) {
   return (
      <div className="p-5">
         <LinearPanel title={fa.project.unassignedProjects}>
            <div className="divide-y divide-white/6">
               {projects.map((project) => (
                  <div
                     key={project.id}
                     className="grid min-h-14 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2"
                  >
                     <FolderKanban className="size-4 text-pink-400" />
                     <div className="min-w-0">
                        <div className="flex items-center gap-2">
                           <span className="truncate text-sm font-semibold text-zinc-200">{project.name}</span>
                           <span className="ltr rounded bg-white/6 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500">
                              {project.keyPrefix}
                           </span>
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                           {(project._count?.tasks || 0).toLocaleString('fa-IR')} {fa.project.issueCount}
                        </div>
                     </div>
                     <Button
                        size="xs"
                        variant="secondary"
                        className="h-7 rounded-full border border-white/8 bg-white/5 text-zinc-300 hover:bg-white/10"
                        onClick={() => onAssign(project.id)}
                     >
                        <Plus className="size-3.5" />
                        {fa.project.addToTeam} {teamName}
                     </Button>
                  </div>
               ))}
            </div>
         </LinearPanel>
      </div>
   );
}

function ListGroup({
   group,
   collapsed,
   displayProperties,
   selectedTaskId,
   highlightedIndex,
   labelOptions,
   projects,
   onAdd,
   onDelete,
   onSelect,
   onOpen,
   onStatusChange,
   onPriorityChange,
   onProjectChange,
   onAssigneeChange,
   onDueAtChange,
   onLabelsChange,
   onToggleCollapse,
   users,
}: {
   group: GroupDescriptor;
   collapsed: boolean;
   displayProperties: TaskViewDisplayProperty[];
   selectedTaskId: string | null;
   highlightedIndex: number | null;
   labelOptions: Array<{ id: string; name: string }>;
   projects: TaskaraProject[];
   onAdd: () => void;
   onDelete: (task: TaskaraTask) => void;
   onSelect: (task: TaskaraTask, absoluteIndex: number) => void;
   onOpen: (task: TaskaraTask) => void;
   onStatusChange: (task: TaskaraTask, status: string) => void;
   onPriorityChange: (task: TaskaraTask, priority: string) => void;
   onProjectChange: (task: TaskaraTask, projectId: string) => void;
   onAssigneeChange: (task: TaskaraTask, assigneeId: string | null) => void;
   onDueAtChange: (task: TaskaraTask, dueAt: string | null) => void;
   onLabelsChange: (task: TaskaraTask, labels: string[]) => void;
   onToggleCollapse: () => void;
   users: TaskaraUser[];
}) {
   return (
      <section>
         <div className="sticky top-0 z-20 h-8 bg-[#151516]">
            <div aria-hidden="true" className={cn('absolute inset-0', group.toneClassName)} style={group.toneStyle} />
            <div className="relative flex h-full items-center justify-between px-5">
               <button
                  aria-expanded={!collapsed}
                  className="group flex min-w-0 items-center gap-2 rounded-md text-sm font-semibold text-zinc-300 outline-none hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-indigo-400/50"
                  title={collapsed ? 'باز کردن گروه' : 'بستن گروه'}
                  type="button"
                  onClick={onToggleCollapse}
               >
                  <ChevronRight className={cn('size-3.5 text-zinc-600 transition group-hover:text-zinc-300', !collapsed && 'rotate-90')} />
                  {group.icon}
                  <span className="truncate">{group.label}</span>
                  <span className="text-zinc-500">{group.tasks.length.toLocaleString('fa-IR')}</span>
               </button>
               <button
                  aria-label={fa.issue.newIssue}
                  className="rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                  type="button"
                  onClick={onAdd}
               >
                  <Plus className="size-4" />
               </button>
            </div>
         </div>

         {collapsed ? null : group.tasks.length === 0 ? (
            <div className="px-5 py-3">
               <LinearEmptyState className="py-5">{fa.issue.noIssuesInGroup}</LinearEmptyState>
            </div>
         ) : (
            <div>
               {group.tasks.map((task, index) => (
                  <IssueRow
                     key={task.id}
                     highlighted={group.offset + index === highlightedIndex}
                     displayProperties={displayProperties}
                     selected={selectedTaskId === task.id}
                     task={task}
                     onClick={() => {
                        onSelect(task, group.offset + index);
                        onOpen(task);
                     }}
                     onPriorityChange={(priority) => onPriorityChange(task, priority)}
                     onProjectChange={(projectId) => onProjectChange(task, projectId)}
                     onStatusChange={(status) => onStatusChange(task, status)}
                     onAssigneeChange={(assigneeId) => onAssigneeChange(task, assigneeId)}
                     onDueAtChange={(dueAt) => onDueAtChange(task, dueAt)}
                     onLabelsChange={(labels) => onLabelsChange(task, labels)}
                     onDelete={() => onDelete(task)}
                     labelOptions={labelOptions}
                     projects={projects}
                     users={users}
                  />
               ))}
            </div>
         )}
      </section>
   );
}

function BoardGroup({
   group,
   collapsed,
   displayProperties,
   selectedTaskId,
   highlightedIndex,
   labelOptions,
   projects,
   onAdd,
   onDelete,
   onSelect,
   onOpen,
   onStatusChange,
   onPriorityChange,
   onProjectChange,
   onAssigneeChange,
   onDueAtChange,
   onLabelsChange,
   onToggleCollapse,
   users,
}: {
   group: GroupDescriptor;
   collapsed: boolean;
   displayProperties: TaskViewDisplayProperty[];
   selectedTaskId: string | null;
   highlightedIndex: number | null;
   labelOptions: Array<{ id: string; name: string }>;
   projects: TaskaraProject[];
   onAdd: () => void;
   onDelete: (task: TaskaraTask) => void;
   onSelect: (task: TaskaraTask, absoluteIndex: number) => void;
   onOpen: (task: TaskaraTask) => void;
   onStatusChange: (task: TaskaraTask, status: string) => void;
   onPriorityChange: (task: TaskaraTask, priority: string) => void;
   onProjectChange: (task: TaskaraTask, projectId: string) => void;
   onAssigneeChange: (task: TaskaraTask, assigneeId: string | null) => void;
   onDueAtChange: (task: TaskaraTask, dueAt: string | null) => void;
   onLabelsChange: (task: TaskaraTask, labels: string[]) => void;
   onToggleCollapse: () => void;
   users: TaskaraUser[];
}) {
   return (
      <section className={cn('flex h-full shrink-0 flex-col overflow-hidden rounded-lg border border-white/8 bg-[#171719]', collapsed ? 'w-[48px]' : 'w-[320px]')}>
         <div className="relative h-10 bg-[#171719]">
            <div aria-hidden="true" className={cn('absolute inset-0', group.toneClassName)} style={group.toneStyle} />
            <div className="relative flex h-full items-center justify-between px-4">
               <button
                  aria-expanded={!collapsed}
                  className="group flex min-w-0 items-center gap-2 rounded-md text-sm font-semibold text-zinc-300 outline-none hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-indigo-400/50"
                  type="button"
                  onClick={onToggleCollapse}
               >
                  <ChevronRight className={cn('size-3.5 text-zinc-600 transition group-hover:text-zinc-300', !collapsed && 'rotate-90')} />
                  {group.icon}
                  {!collapsed ? (
                     <>
                        <span className="truncate">{group.label}</span>
                        <span className="text-zinc-500">{group.tasks.length.toLocaleString('fa-IR')}</span>
                     </>
                  ) : null}
               </button>
               {!collapsed ? (
               <button
                  aria-label={fa.issue.newIssue}
                  className="rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                  type="button"
                  onClick={onAdd}
               >
                  <Plus className="size-4" />
               </button>
               ) : null}
            </div>
         </div>
         {collapsed ? null : <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {group.tasks.length === 0 ? (
               <LinearEmptyState className="py-6">{fa.issue.noIssuesInGroup}</LinearEmptyState>
            ) : (
               group.tasks.map((task, index) => (
                  <IssueCard
                     key={task.id}
                     highlighted={group.offset + index === highlightedIndex}
                     displayProperties={displayProperties}
                     selected={selectedTaskId === task.id}
                     task={task}
                     onClick={() => {
                        onSelect(task, group.offset + index);
                        onOpen(task);
                     }}
                     onPriorityChange={(priority) => onPriorityChange(task, priority)}
                     onProjectChange={(projectId) => onProjectChange(task, projectId)}
                     onStatusChange={(status) => onStatusChange(task, status)}
                     onAssigneeChange={(assigneeId) => onAssigneeChange(task, assigneeId)}
                     onDueAtChange={(dueAt) => onDueAtChange(task, dueAt)}
                     onLabelsChange={(labels) => onLabelsChange(task, labels)}
                     onDelete={() => onDelete(task)}
                     labelOptions={labelOptions}
                     projects={projects}
                     users={users}
                  />
               ))
            )}
         </div>}
      </section>
   );
}

function IssueRow({
   task,
   selected,
   highlighted,
   displayProperties,
   onClick,
   onStatusChange,
   onPriorityChange,
   onProjectChange,
   onAssigneeChange,
   onDueAtChange,
   onLabelsChange,
   onDelete,
   labelOptions,
   projects,
   users,
}: {
   task: TaskaraTask;
   selected: boolean;
   highlighted: boolean;
   displayProperties: TaskViewDisplayProperty[];
   onClick: () => void;
   onStatusChange: (status: string) => void;
   onPriorityChange: (priority: string) => void;
   onProjectChange: (projectId: string) => void;
   onAssigneeChange: (assigneeId: string | null) => void;
   onDueAtChange: (dueAt: string | null) => void;
   onLabelsChange: (labels: string[]) => void;
   onDelete: () => void;
   labelOptions: Array<{ id: string; name: string }>;
   projects: TaskaraProject[];
   users: TaskaraUser[];
}) {
   const stopRowPropagation = (event: { stopPropagation: () => void }) => event.stopPropagation();
   const shows = (property: TaskViewDisplayProperty) => displayProperties.includes(property);

   return (
      <ContextMenu dir="rtl">
         <ContextMenuTrigger asChild>
            <div
               className={cn(
                  'group cursor-pointer',
                  'grid min-h-9 w-full grid-cols-[26px_72px_24px_minmax(0,1fr)_auto] items-center gap-2 border-b border-white/5 px-4 text-start text-sm transition hover:bg-white/[0.035]',
                  selected && 'bg-indigo-400/8',
                  highlighted && 'ring-1 ring-inset ring-indigo-400/35'
               )}
               role="button"
               tabIndex={0}
               onClick={onClick}
               onKeyDown={(event) => {
                  if (event.currentTarget !== event.target) return;
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onClick();
               }}
            >
               <span className="flex justify-center" onClick={stopRowPropagation} onDoubleClick={stopRowPropagation}>
                  {selected ? <Check className="size-4 text-indigo-300" /> : shows('priority') ? (
                     <TaskPriorityControl priority={task.priority} iconOnly onChange={onPriorityChange} />
                  ) : null}
               </span>
               <span className="ltr truncate text-xs font-medium text-zinc-500">
                  {shows('id') ? (
                     <span className="inline-flex max-w-full items-center gap-1">
                        <span className="truncate">{task.key}</span>
                        {task.syncState === 'pending' ? (
                           <Repeat2 className="size-3 shrink-0 text-amber-300/80" aria-label={fa.issue.pendingSync} />
                        ) : null}
                     </span>
                  ) : null}
               </span>
               <span onClick={stopRowPropagation} onDoubleClick={stopRowPropagation}>
                  {shows('status') ? <TaskStatusControl status={task.status} iconOnly onChange={onStatusChange} /> : null}
               </span>
               <span className="min-w-0">
                  <span className="block truncate font-normal text-zinc-200">{task.title}</span>
               </span>
               <span className="grid min-w-0 grid-cols-[28px] items-center justify-end gap-2 justify-self-end md:w-[196px] md:grid-cols-[160px_28px] lg:w-[348px] lg:grid-cols-[144px_160px_28px] xl:w-[500px] xl:grid-cols-[144px_144px_160px_28px]">
                  <span className="hidden min-w-0 xl:block">
                     {shows('labels') ? <TaskLabelSummary labels={task.labels || []} /> : null}
                  </span>
                  <span className="hidden w-36 truncate text-xs text-zinc-500 lg:block">
                     {shows('project') ? task.project?.name || fa.app.unknown : null}
                  </span>
                  <span className="hidden md:block" onClick={stopRowPropagation} onDoubleClick={stopRowPropagation}>
                     {shows('dueAt') ? <TaskDueDateControl dueAt={task.dueAt} onChange={onDueAtChange} /> : null}
                  </span>
                  <span className="flex items-center justify-center" onClick={stopRowPropagation} onDoubleClick={stopRowPropagation}>
                     {shows('assignee') ? (
                        <TaskAssigneeControl assignee={task.assignee} users={users} onChange={onAssigneeChange} />
                     ) : null}
                  </span>
               </span>
            </div>
         </ContextMenuTrigger>
         <TaskIssueContextMenu
            labelOptions={labelOptions}
            projects={projects}
            task={task}
            users={users}
            onAssigneeChange={onAssigneeChange}
            onDelete={onDelete}
            onDueAtChange={onDueAtChange}
            onLabelsChange={onLabelsChange}
            onOpen={onClick}
            onPriorityChange={onPriorityChange}
            onProjectChange={onProjectChange}
            onStatusChange={onStatusChange}
         />
      </ContextMenu>
   );
}

function IssueCard({
   task,
   selected,
   highlighted,
   displayProperties,
   onClick,
   onStatusChange,
   onPriorityChange,
   onProjectChange,
   onAssigneeChange,
   onDueAtChange,
   onLabelsChange,
   onDelete,
   labelOptions,
   projects,
   users,
}: {
   task: TaskaraTask;
   selected: boolean;
   highlighted: boolean;
   displayProperties: TaskViewDisplayProperty[];
   onClick: () => void;
   onStatusChange: (status: string) => void;
   onPriorityChange: (priority: string) => void;
   onProjectChange: (projectId: string) => void;
   onAssigneeChange: (assigneeId: string | null) => void;
   onDueAtChange: (dueAt: string | null) => void;
   onLabelsChange: (labels: string[]) => void;
   onDelete: () => void;
   labelOptions: Array<{ id: string; name: string }>;
   projects: TaskaraProject[];
   users: TaskaraUser[];
}) {
   const shows = (property: TaskViewDisplayProperty) => displayProperties.includes(property);

   return (
      <ContextMenu dir="rtl">
         <ContextMenuTrigger asChild>
            <div
               className={cn(
                  'w-full cursor-pointer rounded-lg border border-white/8 bg-[#202024] p-2.5 text-start transition hover:bg-[#252529]',
                  selected && 'border-indigo-400/40 bg-indigo-400/8',
                  highlighted && 'ring-1 ring-inset ring-indigo-400/35'
               )}
               role="button"
               tabIndex={0}
               onClick={onClick}
               onKeyDown={(event) => {
                  if (event.currentTarget !== event.target) return;
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onClick();
               }}
            >
               <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                     <div className="flex items-center gap-2">
                        {shows('id') ? (
                           <span className="ltr inline-flex min-w-0 items-center gap-1 text-xs text-zinc-500">
                              <span className="truncate">{task.key}</span>
                              {task.syncState === 'pending' ? (
                                 <Repeat2 className="size-3 shrink-0 text-amber-300/80" aria-label={fa.issue.pendingSync} />
                              ) : null}
                           </span>
                        ) : null}
                        {shows('status') ? <StatusIcon status={task.status} className="size-3.5" /> : null}
                     </div>
                     <div className="mt-1 line-clamp-2 text-sm font-normal text-zinc-100">{task.title}</div>
                  </div>
                  {shows('priority') ? <PriorityIcon priority={task.priority} /> : null}
               </div>
               <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-zinc-500">
                     {shows('project') ? task.project?.name || fa.app.unknown : null}
                  </span>
                  {shows('assignee') ? (
                     task.assignee ? (
                        <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-5" />
                     ) : (
                        <NoAssigneeIcon className="size-5 text-zinc-500" />
                     )
                  ) : null}
               </div>
               <div className="mt-3 flex items-center gap-2">
                  {shows('priority') ? <TaskPriorityControl priority={task.priority} onChange={onPriorityChange} /> : null}
                  {shows('status') ? <TaskStatusControl status={task.status} onChange={onStatusChange} /> : null}
               </div>
            </div>
         </ContextMenuTrigger>
         <TaskIssueContextMenu
            labelOptions={labelOptions}
            projects={projects}
            task={task}
            users={users}
            onAssigneeChange={onAssigneeChange}
            onDelete={onDelete}
            onDueAtChange={onDueAtChange}
            onLabelsChange={onLabelsChange}
            onOpen={onClick}
            onPriorityChange={onPriorityChange}
            onProjectChange={onProjectChange}
            onStatusChange={onStatusChange}
         />
      </ContextMenu>
   );
}

function TaskStatusControl({
   status,
   iconOnly = false,
   onChange,
}: {
   status: string;
   iconOnly?: boolean;
   onChange: (status: string) => void;
}) {
   return (
      <Popover>
         <PopoverTrigger asChild>
            <button
               aria-label={fa.issue.status}
               className={cn(
                  'inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 text-xs text-zinc-400 transition hover:border-white/8 hover:bg-white/5 hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-indigo-400/50 focus-visible:outline-none',
                  iconOnly && 'w-7 px-0'
               )}
               type="button"
               onClick={(event) => event.stopPropagation()}
               onDoubleClick={(event) => event.stopPropagation()}
            >
               <StatusIcon status={status} className="size-4" />
               {!iconOnly ? <span>{linearStatusMeta[status]?.label || status}</span> : null}
            </button>
         </PopoverTrigger>
         <PopoverContent align="start" className="w-72 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl">
            <LinearMenuSearch title={fa.issue.status} shortcut="S" />
            {taskStatuses.map((item, index) => (
               <LinearMenuOption
                  key={item}
                  active={status === item}
                  icon={<StatusIcon status={item} />}
                  label={linearStatusMeta[item]?.label || item}
                  shortcut={String(index + 1)}
                  onClick={() => onChange(item)}
               />
            ))}
         </PopoverContent>
      </Popover>
   );
}

function TaskPriorityControl({
   priority,
   iconOnly = false,
   onChange,
}: {
   priority: string;
   iconOnly?: boolean;
   onChange: (priority: string) => void;
}) {
   return (
      <Popover>
         <PopoverTrigger asChild>
            <button
               aria-label={fa.issue.priority}
               className={cn(
                  'inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 text-xs text-zinc-400 transition hover:border-white/8 hover:bg-white/5 hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-indigo-400/50 focus-visible:outline-none',
                  iconOnly && 'w-7 px-0'
               )}
               type="button"
               onClick={(event) => event.stopPropagation()}
               onDoubleClick={(event) => event.stopPropagation()}
            >
               <PriorityIcon priority={priority} className="size-4" />
               {!iconOnly ? <span>{linearPriorityMeta[priority]?.label || priority}</span> : null}
            </button>
         </PopoverTrigger>
         <PopoverContent align="start" className="w-72 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl">
            <LinearMenuSearch title={fa.issue.priority} shortcut="P" />
            {taskPriorities.map((item, index) => (
               <LinearMenuOption
                  key={item}
                  active={priority === item}
                  icon={<PriorityIcon priority={item} />}
                  label={linearPriorityMeta[item]?.label || item}
                  shortcut={String(index)}
                  onClick={() => onChange(item)}
               />
            ))}
         </PopoverContent>
      </Popover>
   );
}

function TaskAssigneeControl({
   assignee,
   users,
   onChange,
}: {
   assignee: TaskaraTask['assignee'];
   users: TaskaraUser[];
   onChange: (assigneeId: string | null) => void;
}) {
   const { session } = useAuthSession();
   const currentUserId = session?.user.id || null;
   const [query, setQuery] = useState('');
   const filteredUsers = useMemo(() => filterAssigneeUsers(users, query), [users, query]);

   return (
      <Popover>
         <PopoverTrigger asChild>
            <button
               aria-label={fa.issue.assignee}
               className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent align-middle transition hover:border-white/8 hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-indigo-400/50 focus-visible:outline-none"
               type="button"
               onClick={(event) => event.stopPropagation()}
               onDoubleClick={(event) => event.stopPropagation()}
            >
               {assignee ? (
                  <LinearAvatar name={assignee.name} src={assignee.avatarUrl} className="size-5" />
               ) : (
                  <NoAssigneeIcon className="size-5 text-zinc-500" />
               )}
            </button>
         </PopoverTrigger>
         <PopoverContent align="start" className="w-80 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl">
            <AssigneeSearchField value={query} onChange={setQuery} />
            <div className="max-h-72 overflow-y-auto overscroll-contain pe-1">
               <LinearMenuOption
                  active={!assignee?.id}
                  icon={<NoAssigneeIcon className="size-4 text-zinc-500" />}
                  label={fa.issue.noAssignee}
                  shortcut="0"
                  onClick={() => onChange(null)}
               />
               {filteredUsers.length ? (
                  filteredUsers.map((user, index) => (
                     <LinearMenuOption
                        key={user.id}
                        active={assignee?.id === user.id}
                        className={
                           user.id === currentUserId
                              ? 'rounded-none border-b-2 border-indigo-400/70'
                              : undefined
                        }
                        icon={<LinearAvatar name={user.name} src={user.avatarUrl} className="size-5" />}
                        label={assigneeLabel(user, currentUserId)}
                        shortcut={String(index + 1)}
                        onClick={() => onChange(user.id)}
                     />
                  ))
               ) : (
                  <div className="px-3 py-2 text-xs text-zinc-500">{noAssigneeSearchResult}</div>
               )}
            </div>
         </PopoverContent>
      </Popover>
   );
}

function TaskDueDateControl({
   dueAt,
   onChange,
}: {
   dueAt?: string | null;
   onChange: (dueAt: string | null) => void;
}) {
   return (
      <Popover>
         <PopoverTrigger asChild>
            <button
               aria-label={fa.issue.dueAt}
               className={cn(
                  'inline-flex h-7 w-40 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs transition hover:border-white/8 hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-indigo-400/50 focus-visible:outline-none',
                  dueAt ? 'text-zinc-400' : 'text-zinc-600'
               )}
               type="button"
               onClick={(event) => event.stopPropagation()}
               onDoubleClick={(event) => event.stopPropagation()}
            >
               <CalendarClock className="size-3.5" />
               <span className="min-w-0 flex-1 truncate text-end">{dueAt ? formatJalaliDate(dueAt) : fa.issue.dueAt}</span>
            </button>
         </PopoverTrigger>
         <PopoverContent align="start" className="w-80 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100 shadow-2xl">
            <LinearMenuSearch title={fa.issue.dueAt} shortcut="⇧D" />
            <LinearMenuOption
               active={false}
               icon={<CalendarClock className="size-4 text-zinc-400" />}
               label="فردا"
               shortcut="۱"
               meta="۱۸:۰۰"
               onClick={() => onChange(makeDueDate(1))}
            />
            <LinearMenuOption
               active={false}
               icon={<CalendarClock className="size-4 text-zinc-400" />}
               label="پایان این هفته"
               shortcut="۲"
               meta={formatJalaliDate(makeEndOfIranWorkWeek())}
               onClick={() => onChange(makeEndOfIranWorkWeek())}
            />
            <LinearMenuOption
               active={false}
               icon={<CalendarClock className="size-4 text-zinc-400" />}
               label="یک هفته دیگر"
               shortcut="۳"
               meta={formatJalaliDate(makeDueDate(7))}
               onClick={() => onChange(makeDueDate(7))}
            />
            {dueAt ? (
               <LinearMenuOption
                  active={false}
                  icon={<XCircle className="size-4 text-zinc-500" />}
                  label={fa.issue.clearDueAt}
                  onClick={() => onChange(null)}
               />
            ) : null}
            <div className="border-t border-white/8 p-3">
               <div className="mb-2 text-xs font-medium text-zinc-500">{fa.issue.dueAt}</div>
               <LazyJalaliDatePicker ariaLabel={fa.issue.dueAt} value={dueAt} onChange={onChange} />
            </div>
         </PopoverContent>
      </Popover>
   );
}

function TaskLabelSummary({ labels }: { labels: NonNullable<TaskaraTask['labels']> }) {
   if (!labels.length) return null;
   const first = labels[0]?.label;
   return (
      <span className="inline-flex w-full max-w-full items-center gap-1.5 truncate rounded-full border border-white/8 bg-white/[0.03] px-2 py-1 text-xs text-zinc-500">
         <span
            aria-hidden="true"
            className="size-2 rounded-full"
            style={{ backgroundColor: first?.color || '#a78bfa' }}
         />
         <span className="truncate">{first?.name}</span>
         {labels.length > 1 ? <span className="text-zinc-600">+{(labels.length - 1).toLocaleString('fa-IR')}</span> : null}
      </span>
   );
}

function TaskIssueContextMenu({
   task,
   users,
   projects,
   labelOptions,
   onOpen,
   onStatusChange,
   onPriorityChange,
   onProjectChange,
   onAssigneeChange,
   onDueAtChange,
   onLabelsChange,
   onDelete,
}: {
   task: TaskaraTask;
   users: TaskaraUser[];
   projects: TaskaraProject[];
   labelOptions: Array<{ id: string; name: string }>;
   onOpen: () => void;
   onStatusChange: (status: string) => void;
   onPriorityChange: (priority: string) => void;
   onProjectChange: (projectId: string) => void;
   onAssigneeChange: (assigneeId: string | null) => void;
   onDueAtChange: (dueAt: string | null) => void;
   onLabelsChange: (labels: string[]) => void;
   onDelete: () => void;
}) {
   const { session } = useAuthSession();
   const currentUserId = session?.user.id || null;
   const [assigneeQuery, setAssigneeQuery] = useState('');
   const filteredUsers = useMemo(() => filterAssigneeUsers(users, assigneeQuery), [users, assigneeQuery]);
   const taskLabelNames = labelNames(task);
   const allLabelOptions = [
      ...labelOptions,
      ...taskLabelNames
         .filter((name) => !labelOptions.some((item) => item.name === name))
         .map((name) => ({ id: name, name })),
   ];

   const toggleLabel = (label: string) => {
      const nextLabels = taskLabelNames.includes(label)
         ? taskLabelNames.filter((item) => item !== label)
         : [...taskLabelNames, label];
      onLabelsChange(nextLabels);
   };

   const copyValue = (value: string, message: string) => {
      void navigator.clipboard?.writeText(value);
      toast.success(message);
   };

   useEffect(() => {
      setAssigneeQuery('');
   }, [task.id]);

   return (
      <ContextMenuContent dir="rtl" className="w-72 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-200 shadow-2xl">
         <ContextMenuSub>
            <LinearContextSubTrigger icon={<StatusIcon status={task.status} />} label={fa.issue.status} shortcut="S" />
            <ContextMenuSubContent dir="rtl" className="w-64 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100">
               {taskStatuses.map((item, index) => (
                  <LinearContextItem
                     key={item}
                     active={task.status === item}
                     icon={<StatusIcon status={item} />}
                     label={linearStatusMeta[item]?.label || item}
                     shortcut={String(index + 1)}
                     onSelect={() => onStatusChange(item)}
                  />
               ))}
            </ContextMenuSubContent>
         </ContextMenuSub>

         <ContextMenuSub>
            <LinearContextSubTrigger icon={<PriorityIcon priority={task.priority} />} label={fa.issue.priority} shortcut="P" />
            <ContextMenuSubContent dir="rtl" className="w-64 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100">
               {taskPriorities.map((item, index) => (
                  <LinearContextItem
                     key={item}
                     active={task.priority === item}
                     icon={<PriorityIcon priority={item} />}
                     label={linearPriorityMeta[item]?.label || item}
                     shortcut={String(index)}
                     onSelect={() => onPriorityChange(item)}
                  />
               ))}
            </ContextMenuSubContent>
         </ContextMenuSub>

         <ContextMenuSub>
            <LinearContextSubTrigger
               icon={task.assignee ? <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-4" /> : <NoAssigneeIcon className="size-4 text-zinc-500" />}
               label={fa.issue.assignee}
               shortcut="A"
            />
            <ContextMenuSubContent dir="rtl" className="w-72 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100">
               <AssigneeSearchField value={assigneeQuery} onChange={setAssigneeQuery} />
               <div className="max-h-72 overflow-y-auto overscroll-contain pe-1">
                  <LinearContextItem
                     active={!task.assignee?.id}
                     icon={<NoAssigneeIcon className="size-4 text-zinc-500" />}
                     label={fa.issue.noAssignee}
                     shortcut="0"
                     onSelect={() => onAssigneeChange(null)}
                  />
                  {filteredUsers.length ? (
                     filteredUsers.map((user, index) => (
                        <LinearContextItem
                           key={user.id}
                           active={task.assignee?.id === user.id}
                           className={
                              user.id === currentUserId
                                 ? 'rounded-none border-b-2 border-indigo-400/70'
                                 : undefined
                           }
                           icon={<LinearAvatar name={user.name} src={user.avatarUrl} className="size-5" />}
                           label={assigneeLabel(user, currentUserId)}
                           shortcut={String(index + 1)}
                           onSelect={() => onAssigneeChange(user.id)}
                        />
                     ))
                  ) : (
                     <div className="px-3 py-2 text-xs text-zinc-500">{noAssigneeSearchResult}</div>
                  )}
               </div>
            </ContextMenuSubContent>
         </ContextMenuSub>

         <ContextMenuSub>
            <LinearContextSubTrigger icon={<CalendarClock className="size-4 text-zinc-400" />} label={fa.issue.dueAt} shortcut="⇧D" />
            <ContextMenuSubContent dir="rtl" className="w-72 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100">
               <LinearContextItem icon={<CalendarClock className="size-4 text-zinc-400" />} label="فردا" shortcut="۱" onSelect={() => onDueAtChange(makeDueDate(1))} />
               <LinearContextItem icon={<CalendarClock className="size-4 text-zinc-400" />} label="پایان این هفته" shortcut="۲" onSelect={() => onDueAtChange(makeEndOfIranWorkWeek())} />
               <LinearContextItem icon={<CalendarClock className="size-4 text-zinc-400" />} label="یک هفته دیگر" shortcut="۳" onSelect={() => onDueAtChange(makeDueDate(7))} />
               {task.dueAt ? <LinearContextItem icon={<XCircle className="size-4 text-zinc-500" />} label={fa.issue.clearDueAt} onSelect={() => onDueAtChange(null)} /> : null}
            </ContextMenuSubContent>
         </ContextMenuSub>

         <ContextMenuSub>
            <LinearContextSubTrigger icon={<Tag className="size-4 text-zinc-400" />} label={fa.issue.labels} shortcut="L" />
            <ContextMenuSubContent dir="rtl" className="w-72 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100">
               {allLabelOptions.length ? (
                  allLabelOptions.map((label) => (
                     <LinearContextItem
                        key={label.id}
                        active={taskLabelNames.includes(label.name)}
                        icon={<span className="size-2.5 rounded-full bg-violet-400" />}
                        label={label.name}
                        onSelect={() => toggleLabel(label.name)}
                     />
                  ))
               ) : (
                  <ContextMenuItem disabled className="text-zinc-500">
                     {fa.issue.labels}
                  </ContextMenuItem>
               )}
            </ContextMenuSubContent>
         </ContextMenuSub>

         <ContextMenuSub>
            <LinearContextSubTrigger icon={<FolderKanban className="size-4 text-pink-400" />} label={fa.issue.project} shortcut="⇧P" />
            <ContextMenuSubContent dir="rtl" className="w-64 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100">
               <LinearMenuSearch title={fa.issue.project} />
               {projects.length ? (
                  projects.map((project) => (
                     <LinearContextItem
                        key={project.id}
                        active={task.project?.id === project.id}
                        icon={<FolderKanban className="size-4 text-pink-400" />}
                        label={project.name}
                        onSelect={() => onProjectChange(project.id)}
                     />
                  ))
               ) : (
                  <ContextMenuItem disabled className="text-zinc-500">
                     {fa.issue.projectRequired}
                  </ContextMenuItem>
               )}
            </ContextMenuSubContent>
         </ContextMenuSub>

         <ContextMenuSeparator className="bg-white/8" />
         <LinearContextItem icon={<PanelRight className="size-4 text-zinc-400" />} label={fa.issue.details} onSelect={onOpen} />
         <LinearContextItem icon={<LinkIcon className="size-4 text-zinc-400" />} label="کپی لینک کار" onSelect={() => copyValue(task.key, 'لینک کار کپی شد.')} />
         <LinearContextItem icon={<Repeat2 className="size-4 text-zinc-400" />} label="ایجاد کار مرتبط" />
         <ContextMenuSub>
            <LinearContextSubTrigger icon={<Check className="size-4 text-zinc-400" />} label="علامت‌گذاری" />
            <ContextMenuSubContent dir="rtl" className="w-56 rounded-xl border-white/10 bg-[#202023] p-1 text-zinc-100">
               <LinearContextItem icon={<Check className="size-4 text-indigo-300" />} label={fa.status.DONE} onSelect={() => onStatusChange('DONE')} />
               <LinearContextItem icon={<XCircle className="size-4 text-zinc-500" />} label={fa.status.CANCELED} onSelect={() => onStatusChange('CANCELED')} />
            </ContextMenuSubContent>
         </ContextMenuSub>
         <ContextMenuSeparator className="bg-white/8" />
         <LinearContextItem icon={<Copy className="size-4 text-zinc-400" />} label="کپی شناسه" onSelect={() => copyValue(task.key, 'شناسه کپی شد.')} />
         <LinearContextItem icon={<Copy className="size-4 text-zinc-400" />} label="کپی عنوان" onSelect={() => copyValue(task.title, 'عنوان کپی شد.')} />
         <LinearContextItem icon={<Star className="size-4 text-zinc-400" />} label="علاقه‌مندی" shortcut="F" onSelect={() => toast.success('به علاقه‌مندی‌ها اضافه شد.')} />
         <ContextMenuSeparator className="bg-white/8" />
         <LinearContextItem destructive icon={<Trash2 className="size-4" />} label="حذف..." shortcut="⌘⌫" onSelect={onDelete} />
      </ContextMenuContent>
   );
}

function LinearMenuSearch({ title, shortcut }: { title: string; shortcut?: string }) {
   return (
      <div className="flex h-9 items-center gap-2 border-b border-white/8 px-2.5 text-sm text-zinc-500">
         <span className="min-w-0 flex-1 truncate">{title}...</span>
         {shortcut ? <ShortcutKey>{shortcut}</ShortcutKey> : null}
      </div>
   );
}

function AssigneeSearchField({
   value,
   onChange,
}: {
   value: string;
   onChange: (value: string) => void;
}) {
   return (
      <div className="border-b border-white/8 p-2">
         <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
               value={value}
               onChange={(event) => onChange(event.target.value)}
               placeholder={assigneeSearchPlaceholder}
               className="h-8 rounded-md border-white/10 bg-[#1b1b1d] pr-3 pl-8 text-xs text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-indigo-400/40"
               onPointerDown={(event) => event.stopPropagation()}
               onClick={(event) => event.stopPropagation()}
               onKeyDown={(event) => event.stopPropagation()}
            />
         </label>
      </div>
   );
}

function LinearMenuOption({
   active = false,
   icon,
   label,
   meta,
   shortcut,
   className,
   onClick,
}: {
   active?: boolean;
   icon: ReactNode;
   label: string;
   meta?: string;
   shortcut?: string;
   className?: string;
   onClick: () => void;
}) {
   return (
      <button
         className={cn(
            'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-zinc-300 outline-none transition hover:bg-white/[0.06] focus:bg-white/[0.08]',
            className
         )}
         type="button"
         onClick={onClick}
      >
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className="min-w-0 flex-1 truncate text-start">{label}</span>
         {meta ? <span className="shrink-0 text-xs text-zinc-500">{meta}</span> : null}
         {active ? <Check className="size-4 shrink-0 text-zinc-400" /> : shortcut ? <span className="shrink-0 text-xs text-zinc-500">{shortcut}</span> : null}
      </button>
   );
}

function LinearContextSubTrigger({ icon, label }: { icon: ReactNode; label: string; shortcut?: string }) {
   return (
      <ContextMenuSubTrigger className="h-9 rounded-lg px-3 text-zinc-300 focus:bg-white/[0.07] data-[state=open]:bg-white/[0.07]">
         <span className="flex size-5 items-center justify-center">{icon}</span>
         <span className="flex-1 truncate text-start">{label}</span>
      </ContextMenuSubTrigger>
   );
}

function LinearContextItem({
   active = false,
   destructive = false,
   icon,
   label,
   className,
   onSelect,
}: {
   active?: boolean;
   destructive?: boolean;
   icon: ReactNode;
   label: string;
   shortcut?: string;
   className?: string;
   onSelect?: () => void;
}) {
   return (
      <ContextMenuItem
         variant={destructive ? 'destructive' : 'default'}
         className={cn(
            'h-9 rounded-lg px-3 text-zinc-300 focus:bg-white/[0.07]',
            destructive && 'text-red-300 focus:text-red-200',
            className
         )}
         onSelect={onSelect}
      >
         <span className="flex size-5 items-center justify-center">{icon}</span>
         <span className="min-w-0 flex-1 truncate text-start">{label}</span>
         {active ? <Check className="size-4 text-zinc-400" /> : null}
      </ContextMenuItem>
   );
}
