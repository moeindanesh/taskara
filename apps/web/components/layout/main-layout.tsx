import React from 'react';
import { AppSidebar } from '@/components/layout/sidebar/app-sidebar';
import {
   CommandDialog,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
   CommandSeparator,
   CommandShortcut,
} from '@/components/ui/command';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { SidebarProvider } from '@/components/ui/sidebar';
import { IssueTitleTooltip } from '@/components/taskara/issue-title-tooltip';
import { LinearAvatar, ProjectGlyph, ShortcutKey, StatusIcon } from '@/components/taskara/linear-ui';
import { WorkspaceTaskComposer } from '@/components/taskara/workspace-task-composer';
import { fa } from '@/lib/fa-copy';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import type { PaginatedResponse, TaskaraKnowledgePage, TaskaraTask, TaskaraView } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { selectCommandSearchItems, selectTasksAssignedToUser } from '@/lib/workspace-data/selectors';
import { Activity, Bell, BookOpen, CalendarCheck2, FileText, FolderKanban, GitPullRequest, LayoutTemplate, ListChecks, ListTodo, Megaphone, Plus, ScanEye, Search, Settings, SlidersHorizontal, Users, UsersRound } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

interface MainLayoutProps {
   children: React.ReactNode;
   header?: React.ReactNode;
   headersNumber?: 1 | 2;
   showSidebar?: boolean;
}

const isEmptyHeader = (header: React.ReactNode | undefined): boolean => {
   if (!header) return true;

   if (React.isValidElement(header) && header.type === React.Fragment) {
      const props = header.props as { children?: React.ReactNode };

      if (!props.children) return true;

      if (Array.isArray(props.children) && props.children.length === 0) {
         return true;
      }
   }

   return false;
};

type CommandAction = {
   id: string;
   label: string;
   description: string;
   icon: React.ComponentType<{ className?: string }>;
   shortcut?: string;
   run: () => void;
};

const COMMAND_RESULT_LIMIT = 6;

function normalizeCommandSearchValue(value: string | null | undefined) {
   return (value || '').toLocaleLowerCase('fa').trim().replace(/\s+/g, ' ');
}

function scoreCommandMatch(query: string, values: Array<string | null | undefined>) {
   if (!query) return 0;

   let bestScore = 0;
   for (const value of values) {
      const normalized = normalizeCommandSearchValue(value);
      if (!normalized) continue;
      if (normalized === query) return 250;
      if (normalized.startsWith(query)) bestScore = Math.max(bestScore, 180);

      const index = normalized.indexOf(query);
      if (index >= 0) {
         bestScore = Math.max(bestScore, Math.max(80, 150 - index));
      }

      for (const word of normalized.split(' ')) {
         if (word.startsWith(query)) {
            bestScore = Math.max(bestScore, 120);
         }
      }
   }

   return bestScore;
}

function takeTopMatches<T>(items: T[], scorer: (item: T) => number, limit = COMMAND_RESULT_LIMIT) {
   return items
      .map((item) => ({ item, score: scorer(item) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.item);
}

function formatViewTarget(view: TaskaraView, teams: Array<{ id: string; slug: string }>, fallback = 'all') {
   if (!view.state.teamId || view.state.teamId === fallback) return fallback;
   return teams.find((team) => team.id === view.state.teamId)?.slug || fallback;
}

export default function MainLayout({ children, header, headersNumber = 2, showSidebar = true }: MainLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const taskSync = useWorkspaceTaskSync();
  const { tasks, projects, teams, users, views } = React.useMemo(
     () => selectCommandSearchItems(taskSync.workspaceData),
     [taskSync.workspaceData]
  );
   const [commandOpen, setCommandOpen] = React.useState(false);
   const [commandQuery, setCommandQuery] = React.useState('');
   const [knowledgeResults, setKnowledgeResults] = React.useState<TaskaraKnowledgePage[]>([]);
   const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
   const pathParts = location.pathname.split('/').filter(Boolean);
   const orgId = pathParts[0] || 'taskara';
   const routeKey = pathParts[1] || 'team';
   const activeTeamSlug = pathParts[1] === 'team' && pathParts[2] !== 'all' ? pathParts[2] : null;
   const isProjectsRoute =
      location.pathname.endsWith('/projects') || (pathParts[1] === 'team' && pathParts[3] === 'projects');

   const pageOwnsScroll = ['announcements', 'capacity', 'cockpit', 'communications', 'heartbeat', 'inbox', 'issue', 'meetings', 'people', 'projects', 'queues', 'reviews', 'settings', 'tasks', 'team', 'today', 'wiki'].includes(routeKey);
   const height = {
      1: 'h-[calc(100dvh-40px)] lg:h-[calc(100dvh-48px)]',
      2: 'h-[calc(100dvh-80px)] lg:h-[calc(100dvh-88px)]',
   };

   const isEditableTarget = React.useCallback((target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
   }, []);

   const openCreateIssue = React.useCallback(() => {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('taskara:create-issue')), 0);
   }, []);

   const openCreateProject = React.useCallback(() => {
      if (!isProjectsRoute) {
         navigate(activeTeamSlug ? `/${orgId}/team/${activeTeamSlug}/projects` : `/${orgId}/projects`);
      }
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('taskara:create-project')), 0);
   }, [activeTeamSlug, isProjectsRoute, navigate, orgId]);

   React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
         if (event.defaultPrevented) return;

         if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            setCommandOpen(true);
            return;
         }

         const key = event.key.toLocaleLowerCase('fa');
         const hasSystemModifier = event.metaKey || event.ctrlKey || event.altKey;
         if (!hasSystemModifier && !event.shiftKey && !isEditableTarget(event.target) && (key === 'c' || key === 'ز')) {
            event.preventDefault();
            openCreateIssue();
            return;
         }

         if (event.key === '?' && !isEditableTarget(event.target)) {
            event.preventDefault();
            setShortcutsOpen(true);
         }
      };

      const openCommands = () => setCommandOpen(true);
      const openShortcuts = () => setShortcutsOpen(true);

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('taskara:command-menu', openCommands);
      window.addEventListener('taskara:keyboard-shortcuts', openShortcuts);

      return () => {
         window.removeEventListener('keydown', handleKeyDown);
         window.removeEventListener('taskara:command-menu', openCommands);
         window.removeEventListener('taskara:keyboard-shortcuts', openShortcuts);
      };
   }, [isEditableTarget, openCreateIssue]);

   React.useEffect(() => {
      if (!commandOpen) {
         setCommandQuery('');
      }
   }, [commandOpen]);

   const runCommand = React.useCallback((run: () => void) => {
      setCommandOpen(false);
      setCommandQuery('');
      run();
   }, []);

   const commandActions = React.useMemo<CommandAction[]>(
      () => [
         {
            id: 'create-issue',
            label: fa.command.createIssue,
            description: fa.command.createIssueDescription,
            icon: Plus,
            shortcut: 'C / ز',
            run: openCreateIssue,
         },
         {
            id: 'create-project',
            label: fa.command.createProject,
            description: fa.command.createProjectDescription,
            icon: FolderKanban,
            run: openCreateProject,
         },
         {
            id: 'go-cockpit',
            label: fa.command.goCockpit,
            description: fa.pages.cockpitDescription,
            icon: ScanEye,
            run: () => navigate(`/${orgId}/cockpit`),
         },
         {
            id: 'go-decision-queues',
            label: fa.command.goDecisionQueues,
            description: fa.pages.decisionQueuesDescription,
            icon: ListChecks,
            run: () => navigate(`/${orgId}/queues`),
         },
         {
            id: 'go-reviews',
            label: fa.command.goReviews,
            description: fa.pages.reviewsDescription,
            icon: GitPullRequest,
            run: () => navigate(`/${orgId}/reviews`),
         },
         {
            id: 'go-people-workload',
            label: fa.command.goPeopleWorkload,
            description: fa.pages.peopleWorkloadDescription,
            icon: Users,
            run: () => navigate(`/${orgId}/people`),
         },
         {
            id: 'go-capacity-settings',
            label: fa.command.goCapacitySettings,
            description: fa.pages.capacitySettingsDescription,
            icon: SlidersHorizontal,
            run: () => navigate(`/${orgId}/capacity`),
         },
         {
            id: 'go-issues',
            label: fa.command.goIssues,
            description: fa.pages.issuesDescription,
            icon: ListTodo,
            run: () => navigate(`/${orgId}/team/all/all`),
         },
         {
            id: 'go-all-tasks',
            label: fa.command.goAllTasks,
            description: fa.pages.allTasksDescription,
            icon: ListTodo,
            run: () => navigate(`/${orgId}/tasks`),
         },
         {
            id: 'go-inbox',
            label: fa.command.goInbox,
            description: fa.pages.inboxDescription,
            icon: Bell,
            run: () => navigate(`/${orgId}/inbox`),
         },
         {
            id: 'go-communications',
            label: fa.nav.communications,
            description: fa.pages.communicationsDescription,
            icon: Megaphone,
            run: () => navigate(`/${orgId}/communications`),
         },
         {
            id: 'go-wiki',
            label: fa.command.goWiki,
            description: fa.pages.wikiDescription,
            icon: BookOpen,
            run: () => navigate(`/${orgId}/wiki`),
         },
         {
            id: 'go-projects',
            label: fa.command.goProjects,
            description: fa.pages.projectsDescription,
            icon: FolderKanban,
            run: () => navigate(`/${orgId}/projects`),
         },
         {
            id: 'go-team-health',
            label: fa.command.goTeamHealth,
            description: fa.pages.teamHealthDescription,
            icon: Activity,
            run: () => navigate(`/${orgId}/team-health`),
         },
         {
            id: 'go-heartbeat',
            label: fa.command.goHeartbeat,
            description: fa.pages.heartbeatDescription,
            icon: Activity,
            run: () => navigate(`/${orgId}/heartbeat`),
         },
         {
            id: 'go-today-plan',
            label: fa.command.goTodayPlan,
            description: fa.pages.todayPlanDescription,
            icon: CalendarCheck2,
            run: () => navigate(`/${orgId}/heartbeat`),
         },
         {
            id: 'go-members',
            label: fa.command.goMembers,
            description: fa.pages.membersDescription,
            icon: Users,
            run: () => navigate(`/${orgId}/members`),
         },
         {
            id: 'go-teams',
            label: fa.command.goTeams,
            description: fa.pages.teamsDescription,
            icon: UsersRound,
            run: () => navigate(`/${orgId}/teams`),
         },
         {
            id: 'go-settings',
            label: fa.command.goSettings,
            description: fa.pages.settingsDescription,
            icon: Settings,
            run: () => navigate(`/${orgId}/settings/profile`),
         },
      ],
      [navigate, openCreateIssue, openCreateProject, orgId]
   );

   const normalizedCommandQuery = React.useMemo(
      () => normalizeCommandSearchValue(commandQuery).slice(0, 120),
      [commandQuery]
   );
   const hasCommandQuery = Boolean(normalizedCommandQuery);

   React.useEffect(() => {
      if (!commandOpen || !hasCommandQuery) {
         setKnowledgeResults([]);
         return;
      }

      let cancelled = false;
      const timer = window.setTimeout(() => {
         const params = new URLSearchParams({ q: normalizedCommandQuery, limit: '5' });
         void taskaraRequest<PaginatedResponse<TaskaraKnowledgePage>>(`/knowledge/search?${params.toString()}`)
            .then((result) => {
               if (!cancelled) setKnowledgeResults(result.items);
            })
            .catch(() => {
               if (!cancelled) setKnowledgeResults([]);
            });
      }, 200);

      return () => {
         cancelled = true;
         window.clearTimeout(timer);
      };
   }, [commandOpen, hasCommandQuery, normalizedCommandQuery]);

   const visibleCommandActions = React.useMemo(() => {
      if (!hasCommandQuery) return commandActions;
      return takeTopMatches(
         commandActions,
         (item) =>
            scoreCommandMatch(normalizedCommandQuery, [
               item.label,
               item.description,
               item.shortcut,
            ]),
         8
      );
   }, [commandActions, hasCommandQuery, normalizedCommandQuery]);

   const issueResults = React.useMemo<TaskaraTask[]>(() => {
      if (!hasCommandQuery) return [];
      return takeTopMatches(tasks, (task) =>
         scoreCommandMatch(normalizedCommandQuery, [
            task.key,
            task.title,
            task.description,
            task.project?.name,
            task.project?.keyPrefix,
            task.assignee?.name,
         ])
      );
   }, [hasCommandQuery, normalizedCommandQuery, tasks]);

   const projectResults = React.useMemo(() => {
      if (!hasCommandQuery) return [];
      return takeTopMatches(projects, (project) =>
         scoreCommandMatch(normalizedCommandQuery, [
            project.name,
            project.keyPrefix,
            project.description,
            project.team?.name,
            project.team?.slug,
         ])
      );
   }, [hasCommandQuery, normalizedCommandQuery, projects]);

   const viewResults = React.useMemo<TaskaraView[]>(() => {
      if (!hasCommandQuery) return [];
      return takeTopMatches(views, (view) => {
         const teamName =
            teams.find((team) => team.id === view.state.teamId)?.name || '';
         return scoreCommandMatch(normalizedCommandQuery, [
            view.name,
            teamName,
            view.state.teamId,
         ]);
      });
   }, [hasCommandQuery, normalizedCommandQuery, teams, views]);

   const teamResults = React.useMemo(() => {
      if (!hasCommandQuery) return [];
      return takeTopMatches(teams, (team) =>
         scoreCommandMatch(normalizedCommandQuery, [team.name, team.slug, team.description])
      );
   }, [hasCommandQuery, normalizedCommandQuery, teams]);

   const memberResults = React.useMemo(() => {
      if (!hasCommandQuery) return [];
      return takeTopMatches(users, (user) =>
         scoreCommandMatch(normalizedCommandQuery, [
            user.name,
            user.email,
            user.phone,
            user.mattermostUsername,
         ])
      );
   }, [hasCommandQuery, normalizedCommandQuery, users]);

   const focusedMember = React.useMemo(() => {
      if (!hasCommandQuery || memberResults.length === 0) return null;
      return memberResults[0];
   }, [hasCommandQuery, memberResults]);

   const focusedMemberAssignedIssues = React.useMemo(() => {
      if (!focusedMember) return [];
      return selectTasksAssignedToUser(taskSync.workspaceData, focusedMember.id).slice(0, COMMAND_RESULT_LIMIT);
   }, [focusedMember, taskSync.workspaceData]);

   const genericIssueResults = React.useMemo(() => {
      if (!focusedMember) return issueResults;
      return issueResults.filter((task) => task.assignee?.id !== focusedMember.id);
   }, [focusedMember, issueResults]);

   const hasEntityMatches =
      genericIssueResults.length > 0 ||
      knowledgeResults.length > 0 ||
      projectResults.length > 0 ||
      viewResults.length > 0 ||
      teamResults.length > 0 ||
      memberResults.length > 0 ||
      focusedMemberAssignedIssues.length > 0;
   const hasAnyCommandItem =
      visibleCommandActions.length > 0 || hasEntityMatches || hasCommandQuery;

   return (
      <SidebarProvider>
         {showSidebar ? <AppSidebar /> : null}
         <div className="h-dvh w-full overflow-hidden bg-[#050506] lg:p-2">
            <div className="flex h-full w-full flex-col items-center justify-start overflow-hidden bg-container lg:rounded-xl lg:border lg:border-white/8">
               {header}
               <div
                  className={cn(
                     'min-h-0 w-full',
                     pageOwnsScroll ? 'overflow-hidden' : 'overflow-auto',
                     isEmptyHeader(header) ? 'h-full' : height[headersNumber as keyof typeof height]
                  )}
               >
                  {children}
               </div>
            </div>
         </div>
         <WorkspaceTaskComposer />
         <CommandDialog
            description={fa.command.description}
            contentClassName="max-w-[760px] sm:max-w-[760px]"
            commandClassName="[&_[data-slot=command-input-wrapper]]:h-14 [&_[data-slot=command-input-wrapper]]:border-b-0 [&_[data-slot=command-input-wrapper]]:px-4 [&_[data-slot=command-input]]:h-12 [&_[data-slot=command-input]]:text-base [&_[data-slot=command-input]]:font-normal [&_[data-slot=command-input]]:placeholder:font-normal [&_[data-slot=command-input]]:placeholder:text-zinc-600"
            open={commandOpen}
            title={fa.command.title}
            onOpenChange={setCommandOpen}
         >
            <CommandInput
               value={commandQuery}
               onValueChange={setCommandQuery}
               placeholder="دستور اجرا کن یا در کارها، دانش‌نامه، پروژه‌ها و اعضا جستجو کن..."
            />
            <CommandList className="max-h-[520px] p-1.5" data-testid="command-menu">
               {!hasAnyCommandItem ? (
                  <CommandEmpty>
                     {hasCommandQuery ? 'نتیجه‌ای پیدا نشد.' : 'فرمانی برای نمایش وجود ندارد.'}
                  </CommandEmpty>
               ) : null}
               {visibleCommandActions.length > 0 ? (
                  <CommandGroup heading={hasCommandQuery ? 'دستورها' : 'میانبرها'}>
                     {visibleCommandActions.map((item) => {
                        const Icon = item.icon;
                        return (
                           <CommandItem
                              key={item.id}
                              value={`action-${item.id}`}
                              keywords={[item.label, item.description, item.shortcut || '']}
                              className="group rounded-md px-2 py-2.5"
                              onSelect={() => runCommand(item.run)}
                           >
                              <span className="flex min-w-0 flex-1 items-center gap-3">
                                 <span className="inline-flex size-7 items-center justify-center rounded-md bg-white/6 text-zinc-400 group-data-[selected=true]:text-zinc-100">
                                    <Icon className="size-4" />
                                 </span>
                                 <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-zinc-200">{item.label}</span>
                                    <span className="block truncate text-xs text-zinc-500">{item.description}</span>
                                 </span>
                              </span>
                              {item.shortcut ? <CommandShortcut className="ms-auto">{item.shortcut}</CommandShortcut> : null}
                           </CommandItem>
                        );
                     })}
                  </CommandGroup>
               ) : null}
               {hasCommandQuery ? <CommandSeparator /> : null}
               {focusedMember && focusedMemberAssignedIssues.length > 0 ? (
                  <CommandGroup heading={`کارهای سپرده‌شده به ${focusedMember.name}`}>
                     {focusedMemberAssignedIssues.map((task) => (
                        <CommandItem
                           key={`assigned-${task.id}`}
                           value={`assigned-issue-${task.id}`}
                           keywords={[
                              focusedMember.name,
                              focusedMember.email,
                              task.key,
                              task.title,
                              task.project?.name || '',
                              task.project?.keyPrefix || '',
                           ]}
                           className="rounded-md px-2 py-2"
                           onSelect={() => runCommand(() => navigate(`/${orgId}/issue/${task.key}`))}
                        >
                           <StatusIcon status={task.status} />
                           <span className="min-w-0">
                              <IssueTitleTooltip title={task.title}>
                                 <span className="block truncate text-sm text-zinc-200">{task.title}</span>
                              </IssueTitleTooltip>
                              <span className="block truncate text-xs text-zinc-500">
                                 {task.key}
                                 {task.project?.name ? ` • ${task.project.name}` : ''}
                              </span>
                           </span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               ) : null}
               {genericIssueResults.length > 0 ? (
                  <CommandGroup heading="کارها">
                     {genericIssueResults.map((task) => (
                        <CommandItem
                           key={task.id}
                           value={`issue-${task.id}`}
                           keywords={[
                              task.key,
                              task.title,
                              task.project?.name || '',
                              task.project?.keyPrefix || '',
                              task.assignee?.name || '',
                           ]}
                           className="rounded-md px-2 py-2"
                           onSelect={() => runCommand(() => navigate(`/${orgId}/issue/${task.key}`))}
                        >
                           <StatusIcon status={task.status} />
                           <span className="min-w-0">
                              <IssueTitleTooltip title={task.title}>
                                 <span className="block truncate text-sm text-zinc-200">{task.title}</span>
                              </IssueTitleTooltip>
                              <span className="block truncate text-xs text-zinc-500">
                                 {task.key}
                                 {task.project?.name ? ` • ${task.project.name}` : ''}
                              </span>
                           </span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               ) : null}
               {knowledgeResults.length > 0 ? (
                  <CommandGroup heading="دانش‌نامه">
                     {knowledgeResults.map((page) => (
                        <CommandItem
                           key={page.id}
                           value={`knowledge-${page.id}`}
                           keywords={[
                              page.title,
                              page.summary || '',
                              page.contentText || '',
                              page.space?.name || '',
                              page.space?.key || '',
                           ]}
                           className="rounded-md px-2 py-2"
                           onSelect={() =>
                              runCommand(() =>
                                 navigate(`/${orgId}/wiki/${page.space?.key || page.spaceId}/${page.id}`)
                              )
                           }
                        >
                           <FileText className="size-4 text-zinc-400" />
                           <span className="min-w-0">
                              <span className="block truncate text-sm text-zinc-200">{page.title}</span>
                              <span className="block truncate text-xs text-zinc-500">
                                 {page.space?.name || fa.nav.wiki}
                                 {page.verified ? ' • تأییدشده' : ''}
                              </span>
                           </span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               ) : null}
               {projectResults.length > 0 ? (
                  <CommandGroup heading="پروژه‌ها">
                     {projectResults.map((project) => (
                        <CommandItem
                           key={project.id}
                           value={`project-${project.id}`}
                           keywords={[
                              project.name,
                              project.keyPrefix,
                              project.description || '',
                              project.team?.name || '',
                              project.team?.slug || '',
                           ]}
                           className="rounded-md px-2 py-2"
                           onSelect={() =>
                              runCommand(() =>
                                 navigate(
                                    project.team?.slug
                                       ? `/${orgId}/team/${project.team.slug}/projects`
                                       : `/${orgId}/projects`
                                 )
                              )
                           }
                        >
                           <ProjectGlyph
                              name={project.name}
                              className="size-5 rounded-md"
                              iconClassName="size-3.5"
                           />
                           <span className="min-w-0">
                              <span className="block truncate text-sm text-zinc-200">{project.name}</span>
                              <span className="block truncate text-xs text-zinc-500">
                                 {project.keyPrefix}
                                 {project.team?.name ? ` • ${project.team.name}` : ''}
                              </span>
                           </span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               ) : null}
               {viewResults.length > 0 ? (
                  <CommandGroup heading="نماها">
                     {viewResults.map((view) => (
                        <CommandItem
                           key={view.id}
                           value={`view-${view.id}`}
                           keywords={[
                              view.name,
                              view.state.teamId || '',
                              teams.find((team) => team.id === view.state.teamId)?.name || '',
                           ]}
                           className="rounded-md px-2 py-2"
                           onSelect={() =>
                              runCommand(() =>
                                 navigate(
                                    `/${orgId}/team/${formatViewTarget(view, teams)}/all?view=${encodeURIComponent(view.id)}`
                                 )
                              )
                           }
                        >
                           <LayoutTemplate className="size-4 text-zinc-400" />
                           <span className="min-w-0">
                              <span className="block truncate text-sm text-zinc-200">{view.name}</span>
                              <span className="block truncate text-xs text-zinc-500">
                                 {teams.find((team) => team.id === view.state.teamId)?.name || fa.issue.all}
                              </span>
                           </span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               ) : null}
               {teamResults.length > 0 ? (
                  <CommandGroup heading="تیم‌ها">
                     {teamResults.map((team) => (
                        <CommandItem
                           key={team.id}
                           value={`team-${team.id}`}
                           keywords={[team.name, team.slug, team.description || '']}
                           className="rounded-md px-2 py-2"
                           onSelect={() => runCommand(() => navigate(`/${orgId}/team/${team.slug}/all`))}
                        >
                           <UsersRound className="size-4 text-zinc-400" />
                           <span className="min-w-0">
                              <span className="block truncate text-sm text-zinc-200">{team.name}</span>
                              <span className="block truncate text-xs text-zinc-500">{team.slug}</span>
                           </span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               ) : null}
               {memberResults.length > 0 ? (
                  <CommandGroup heading="اعضا">
                     {memberResults.map((user) => (
                        <CommandItem
                           key={user.id}
                           value={`member-${user.id}`}
                           keywords={[user.name, user.email, user.phone || '', user.mattermostUsername || '']}
                           className="rounded-md px-2 py-2"
                           onSelect={() => runCommand(() => navigate(`/${orgId}/members`))}
                        >
                           <LinearAvatar className="size-5" name={user.name} src={user.avatarUrl} />
                           <span className="min-w-0">
                              <span className="block truncate text-sm text-zinc-200">{user.name}</span>
                              <span className="block truncate text-xs text-zinc-500">{user.email}</span>
                           </span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               ) : null}
               {hasCommandQuery ? (
                  <>
                     <CommandSeparator />
                     <CommandGroup heading="جستجوی گسترده">
                        <CommandItem
                           value="search-all-issues"
                           keywords={[normalizedCommandQuery]}
                           className="rounded-md px-2 py-2"
                           onSelect={() => runCommand(() => navigate(`/${orgId}/team/all/all`))}
                        >
                           <Search className="size-4 text-zinc-400" />
                           <span className="min-w-0">
                              <span className="block truncate text-sm text-zinc-200">
                                 جستجو در تمام کارها
                              </span>
                              <span className="block truncate text-xs text-zinc-500">{normalizedCommandQuery}</span>
                           </span>
                        </CommandItem>
                     </CommandGroup>
                  </>
               ) : null}
            </CommandList>
         </CommandDialog>
         <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
            <DialogContent aria-label={fa.shortcuts.title} className="max-w-[640px] bg-[#1d1d20]">
               <DialogHeader>
                  <DialogTitle>{fa.shortcuts.title}</DialogTitle>
                  <DialogDescription>{fa.shortcuts.description}</DialogDescription>
               </DialogHeader>
               <div className="grid gap-2 text-sm" data-testid="keyboard-shortcuts-dialog">
                  {[
                     [fa.shortcuts.openCommandMenu, '⌘/Ctrl K'],
                     [fa.shortcuts.createIssue, 'C / ز'],
                     [fa.shortcuts.createIssueFullscreen, 'V'],
                     [fa.shortcuts.toggleDetails, '⌘/Ctrl I'],
                     [fa.shortcuts.moveRow, '↑ / ↓ یا J / K'],
                     [fa.shortcuts.selectRow, 'X'],
                     [fa.shortcuts.close, 'Esc'],
                     [fa.shortcuts.openHelp, '?'],
                  ].map(([label, shortcut]) => (
                     <div key={label} className="flex items-center justify-between rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                        <span className="text-zinc-300">{label}</span>
                        <ShortcutKey>{shortcut}</ShortcutKey>
                     </div>
                  ))}
               </div>
            </DialogContent>
         </Dialog>
      </SidebarProvider>
   );
}
