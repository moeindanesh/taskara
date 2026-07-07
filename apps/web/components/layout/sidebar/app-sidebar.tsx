'use client';

import * as React from 'react';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuGroup,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuShortcut,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
   Sidebar,
   SidebarContent,
   SidebarFooter,
   SidebarGroup,
   SidebarGroupLabel,
   SidebarHeader,
   SidebarMenu,
   SidebarMenuBadge,
   SidebarMenuButton,
   SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useTheme } from 'next-themes';
import {
   LinearAvatar,
   SidebarInboxIcon,
   SidebarIssueIcon,
   SidebarMyIssuesIcon,
   SidebarProjectIcon,
   SidebarTeamIcon,
} from '@/components/taskara/linear-ui';
import { TaskaraLogo } from '@/components/taskara/brand-logo';
import { useLiveRefresh, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { fa } from '@/lib/fa-copy';
import { clearAuthSession, getAuthSession, setAuthSession } from '@/store/auth-store';
import type { NotificationsResponse, PaginatedResponse, TaskaraMe, TaskaraTask, TaskaraTeam } from '@/lib/taskara-types';
import type { AnnouncementsResponse, TaskaraMeeting, TaskaraWorkspaceMembership } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { selectSidebarCounts } from '@/lib/workspace-data/selectors';
import {
   Activity,
   ChevronDown,
   GitPullRequest,
   Laptop,
   ListChecks,
   Megaphone,
   Moon,
   Plus,
   ScanEye,
   Search,
   SlidersHorizontal,
   Sun,
   Users,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

const primarySidebarVisibleCount = 6;
const primarySidebarOrderStorageKey = 'taskara.sidebar.primaryOrder.v1';
const expandedTeamsStoragePrefix = 'taskara.sidebar.expandedTeams.v1.';
const sidebarItemDragMimeType = 'application/x-taskara-sidebar-item-id';
const sidebarItemClassName =
   'h-8 rounded-lg text-[13px] data-[active=true]:bg-zinc-200 data-[active=true]:text-zinc-950 data-[active=true]:hover:bg-zinc-200 data-[active=true]:hover:text-zinc-950 dark:data-[active=true]:bg-white/8 dark:data-[active=true]:text-zinc-100 dark:data-[active=true]:hover:bg-white/10 dark:data-[active=true]:hover:text-zinc-100';

type PrimarySidebarItemId =
   | 'inbox'
   | 'cockpit'
   | 'queues'
   | 'reviews'
   | 'people'
   | 'capacity'
   | 'team-health'
   | 'communications'
   | 'all-tasks'
   | 'my-issues';

type PrimarySidebarItem = {
   id: PrimarySidebarItemId;
   title: string;
   href: string;
   icon: React.ComponentType<{ className?: string }>;
   count?: number;
};

function readStoredPrimaryOrder() {
   if (typeof window === 'undefined') return [];

   try {
      const raw = window.localStorage.getItem(primarySidebarOrderStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
         ? parsed.filter((item): item is PrimarySidebarItemId => typeof item === 'string')
         : [];
   } catch {
      return [];
   }
}

function writeStoredPrimaryOrder(order: PrimarySidebarItemId[]) {
   try {
      window.localStorage.setItem(primarySidebarOrderStorageKey, JSON.stringify(order));
   } catch {
      // Local storage is a preference cache; failures should not block navigation.
   }
}

function expandedTeamsStorageKey(orgId: string) {
   return `${expandedTeamsStoragePrefix}${orgId}`;
}

function readStoredExpandedTeams(orgId: string) {
   if (typeof window === 'undefined') return {};

   try {
      const raw = window.localStorage.getItem(expandedTeamsStorageKey(orgId));
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

      return Object.fromEntries(
         Object.entries(parsed).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
         )
      );
   } catch {
      return {};
   }
}

function writeStoredExpandedTeams(orgId: string, expandedTeams: Record<string, boolean>) {
   try {
      window.localStorage.setItem(expandedTeamsStorageKey(orgId), JSON.stringify(expandedTeams));
   } catch {
      // Local storage is best effort.
   }
}

function orderPrimarySidebarItems(items: PrimarySidebarItem[], storedOrder: PrimarySidebarItemId[]) {
   const itemById = new Map(items.map((item) => [item.id, item]));
   const orderedIds = [
      ...storedOrder.filter((id, index) => itemById.has(id) && storedOrder.indexOf(id) === index),
      ...items.map((item) => item.id).filter((id) => !storedOrder.includes(id)),
   ];

   return orderedIds.map((id) => itemById.get(id)).filter((item): item is PrimarySidebarItem => Boolean(item));
}

function movePrimarySidebarItem(
   items: PrimarySidebarItem[],
   storedOrder: PrimarySidebarItemId[],
   draggedId: PrimarySidebarItemId,
   targetId: PrimarySidebarItemId
) {
   if (draggedId === targetId) return storedOrder;

   const nextOrder = orderPrimarySidebarItems(items, storedOrder).map((item) => item.id);
   const fromIndex = nextOrder.indexOf(draggedId);
   const toIndex = nextOrder.indexOf(targetId);
   if (fromIndex < 0 || toIndex < 0) return nextOrder;

   const [draggedItem] = nextOrder.splice(fromIndex, 1);
   if (!draggedItem) return nextOrder;

   nextOrder.splice(toIndex, 0, draggedItem);
   return nextOrder;
}

function sidebarRefreshSourceMatches(detail: WorkspaceRefreshDetail) {
   return (
      workspaceRefreshSourceMatches(detail, 'announcement') ||
      workspaceRefreshSourceMatches(detail, 'meeting') ||
      workspaceRefreshSourceMatches(detail, 'notifications') ||
      workspaceRefreshSourceMatches(detail, 'project') ||
      workspaceRefreshSourceMatches(detail, 'task') ||
      workspaceRefreshSourceMatches(detail, 'task-sync-mutation') ||
      workspaceRefreshSourceMatches(detail, 'team') ||
      workspaceRefreshSourceMatches(detail, 'workspace')
   );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
   const location = useLocation();
   const navigate = useNavigate();
   const { theme, setTheme } = useTheme();
   const pathname = location.pathname;
   const orgId = pathname.split('/').filter(Boolean)[0] || 'taskara';
   const taskSync = useWorkspaceTaskSync();
   const [me, setMe] = React.useState<TaskaraMe | null>(null);
   const [teams, setTeams] = React.useState<TaskaraTeam[]>([]);
   const [workspaces, setWorkspaces] = React.useState<TaskaraWorkspaceMembership[]>([]);
   const [unreadCount, setUnreadCount] = React.useState(0);
   const [announcementUnreadCount, setAnnouncementUnreadCount] = React.useState(0);
   const [allIssueCount, setAllIssueCount] = React.useState(0);
   const [myIssueCount, setMyIssueCount] = React.useState(0);
   const [meetingCount, setMeetingCount] = React.useState(0);
   const [loadingTeams, setLoadingTeams] = React.useState(true);
   const [expandedTeams, setExpandedTeams] = React.useState<Record<string, boolean>>(() => readStoredExpandedTeams(orgId));
   const [primaryItemOrder, setPrimaryItemOrder] = React.useState<PrimarySidebarItemId[]>(readStoredPrimaryOrder);
   const [showAllPrimaryItems, setShowAllPrimaryItems] = React.useState(false);
   const [draggingPrimaryItemId, setDraggingPrimaryItemId] = React.useState<PrimarySidebarItemId | null>(null);
   const [primaryDropTargetId, setPrimaryDropTargetId] = React.useState<PrimarySidebarItemId | null>(null);
   const cancelledRef = React.useRef(false);
   const initialLoadRef = React.useRef(true);

   const pathParts = pathname.split('/').filter(Boolean);
   const currentUserId = me?.user.id || getAuthSession()?.user.id || null;
   const workspaceCounts = React.useMemo(
      () => selectSidebarCounts(taskSync.workspaceData, currentUserId),
      [currentUserId, taskSync.workspaceData]
   );
   const liveTaskCountsReady = taskSync.hasBootstrapped;
   const displayedMyIssueCount = liveTaskCountsReady ? workspaceCounts.myActiveTaskCount : myIssueCount;
   const displayedReviewCount = liveTaskCountsReady ? workspaceCounts.reviewCount : undefined;
   const isPrimaryItemActive = (item: PrimarySidebarItem) => {
      if (item.id === 'communications') {
         return pathParts[1] === 'communications' || pathParts[1] === 'announcements' || pathParts[1] === 'meetings';
      }
      return pathname === item.href;
   };

   const logout = React.useCallback(() => {
      void taskaraRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
      clearAuthSession();
      navigate('/login', { replace: true });
   }, [navigate]);

   const loadSidebarData = React.useCallback(async (isCancelled: () => boolean, showLoading = false) => {
      if (showLoading) setLoadingTeams(true);

      const [meResult, teamsResult, workspacesResult, notificationsResult, announcementsResult, allTasksResult, myTasksResult, meetingsResult] = await Promise.allSettled([
         taskaraRequest<TaskaraMe>('/me'),
         taskaraRequest<TaskaraTeam[]>('/teams'),
         taskaraRequest<{ items: TaskaraWorkspaceMembership[]; total: number }>('/workspaces'),
         taskaraRequest<NotificationsResponse>('/notifications?limit=1'),
         taskaraRequest<AnnouncementsResponse>('/announcements?limit=1'),
         taskaraRequest<PaginatedResponse<TaskaraTask>>('/tasks?limit=1'),
         taskaraRequest<PaginatedResponse<TaskaraTask>>('/tasks?mine=true&limit=1'),
         taskaraRequest<PaginatedResponse<TaskaraMeeting>>('/meetings?mine=true&limit=1'),
      ]);

      if (isCancelled()) return;

      if (meResult.status === 'fulfilled') {
         setMe(meResult.value);
         const session = getAuthSession();
         if (session) {
            setAuthSession({
               ...session,
               user: meResult.value.user,
               workspace: meResult.value.workspace,
               role: meResult.value.role,
            });
         }
      } else {
         setMe(null);
      }
      setTeams(teamsResult.status === 'fulfilled' ? teamsResult.value : []);
      setWorkspaces(workspacesResult.status === 'fulfilled' ? workspacesResult.value.items : []);
      const notificationData =
         notificationsResult.status === 'fulfilled' ? (notificationsResult.value as NotificationsResponse) : null;
      setUnreadCount(notificationData?.unreadCount ?? 0);
      setAnnouncementUnreadCount(announcementsResult.status === 'fulfilled' ? announcementsResult.value.unreadCount : 0);
      setAllIssueCount(allTasksResult.status === 'fulfilled' ? allTasksResult.value.total : 0);
      setMyIssueCount(myTasksResult.status === 'fulfilled' ? myTasksResult.value.total : 0);
      setMeetingCount(meetingsResult.status === 'fulfilled' ? meetingsResult.value.total : 0);
      setLoadingTeams(false);
   }, []);

   const refreshSidebarData = React.useCallback(() => {
      const showLoading = initialLoadRef.current;
      initialLoadRef.current = false;
      void loadSidebarData(() => cancelledRef.current, showLoading);
   }, [loadSidebarData]);

   React.useEffect(() => {
      cancelledRef.current = false;
      refreshSidebarData();
      window.addEventListener('taskara:teams-updated', refreshSidebarData);

      return () => {
         cancelledRef.current = true;
         window.removeEventListener('taskara:teams-updated', refreshSidebarData);
      };
   }, [refreshSidebarData]);

   useLiveRefresh(refreshSidebarData, {
      fireOnMount: false,
      workspaceEventFilter: sidebarRefreshSourceMatches,
   });

   React.useEffect(() => {
      setExpandedTeams(readStoredExpandedTeams(orgId));
   }, [orgId]);

   React.useEffect(() => {
      if (!teams.length) return;

      setExpandedTeams((current) => {
         const next = { ...current };

         for (const team of teams) {
            next[team.id] = next[team.id] ?? true;
         }

         writeStoredExpandedTeams(orgId, next);
         return next;
      });
   }, [orgId, teams]);

   const workspaceName = me?.workspace.name || fa.app.fallbackWorkspace;
   const workspaceItems = workspaces.length
      ? workspaces
      : me
         ? [
              {
                 membershipId: me.workspace.id,
                 role: me.role || 'MEMBER',
                 joinedAt: '',
                 workspace: me.workspace,
              },
           ]
         : [];

   const openCreateIssue = () => {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('taskara:create-issue')), 0);
   };

   const primaryItems = React.useMemo<PrimarySidebarItem[]>(
      () => [
         { id: 'cockpit', title: fa.nav.cockpit, href: `/${orgId}/cockpit`, icon: ScanEye },
         { id: 'queues', title: fa.nav.decisionQueues, href: `/${orgId}/queues`, icon: ListChecks },
         { id: 'reviews', title: fa.nav.reviews, href: `/${orgId}/reviews`, icon: GitPullRequest, count: displayedReviewCount },
         { id: 'team-health', title: fa.nav.teamHealth, href: `/${orgId}/team-health`, icon: Activity },
         { id: 'people', title: fa.nav.peopleWorkload, href: `/${orgId}/people`, icon: Users },
         { id: 'my-issues', title: fa.nav.myIssues, href: `/${orgId}/team/all/all`, icon: SidebarMyIssuesIcon, count: displayedMyIssueCount },
         { id: 'capacity', title: fa.nav.capacitySettings, href: `/${orgId}/capacity`, icon: SlidersHorizontal },
         { id: 'all-tasks', title: fa.nav.allTasks, href: `/${orgId}/tasks`, icon: SidebarIssueIcon, count: allIssueCount },
         { id: 'inbox', title: fa.nav.inbox, href: `/${orgId}/inbox`, icon: SidebarInboxIcon, count: unreadCount },
         { id: 'communications', title: fa.nav.communications, href: `/${orgId}/communications`, icon: Megaphone, count: announcementUnreadCount + meetingCount },
      ],
      [allIssueCount, announcementUnreadCount, displayedMyIssueCount, displayedReviewCount, meetingCount, orgId, unreadCount]
   );
   const orderedPrimaryItems = React.useMemo(
      () => orderPrimarySidebarItems(primaryItems, primaryItemOrder),
      [primaryItemOrder, primaryItems]
   );
   const visiblePrimaryItems = showAllPrimaryItems
      ? orderedPrimaryItems
      : orderedPrimaryItems.slice(0, primarySidebarVisibleCount);
   const hiddenPrimaryItemCount = Math.max(orderedPrimaryItems.length - primarySidebarVisibleCount, 0);
   const teamItems = (team: TaskaraTeam) => [
      { title: fa.nav.issues, href: `/${orgId}/team/${team.slug}/all`, icon: SidebarIssueIcon },
      { title: fa.nav.projects, href: `/${orgId}/team/${team.slug}/projects`, icon: SidebarProjectIcon },
   ];
   const currentTheme = theme || 'system';
   const themeOptions = [
      { value: 'light', label: 'روشن', icon: Sun },
      { value: 'dark', label: 'تیره', icon: Moon },
      { value: 'system', label: 'سیستم', icon: Laptop },
   ];
   const currentThemeLabel =
      themeOptions.find((item) => item.value === currentTheme)?.label || 'سیستم';

   const handlePrimaryItemDrop = React.useCallback(
      (event: React.DragEvent<HTMLElement>, targetId: PrimarySidebarItemId) => {
         event.preventDefault();
         const draggedId =
            (event.dataTransfer.getData(sidebarItemDragMimeType) ||
               event.dataTransfer.getData('text/plain')) as PrimarySidebarItemId;
         setDraggingPrimaryItemId(null);
         setPrimaryDropTargetId(null);
         if (!draggedId) return;

         setPrimaryItemOrder((current) => {
            const next = movePrimarySidebarItem(primaryItems, current, draggedId, targetId);
            writeStoredPrimaryOrder(next);
            return next;
         });
      },
      [primaryItems]
   );

   const toggleTeamOpen = React.useCallback(
      (teamId: string) => {
         setExpandedTeams((current) => {
            const next = {
               ...current,
               [teamId]: !(current[teamId] ?? true),
            };
            writeStoredExpandedTeams(orgId, next);
            return next;
         });
      },
      [orgId]
   );

   return (
      <Sidebar side="right" collapsible="offcanvas" className="border-l border-white/6 bg-[#070708]" {...props}>
         <SidebarHeader className="gap-3 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <button
                        className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-start text-sm font-semibold text-zinc-200 hover:bg-white/5"
                        type="button"
                     >
                        <TaskaraLogo className="size-7 rounded-lg border border-white/10" />
                        <span className="truncate">{workspaceName}</span>
                        <ChevronDown className="size-4 text-zinc-500" />
                     </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                     align="start"
                     className="w-[260px] overflow-hidden rounded-lg border-white/10 bg-[#1b1b1d] p-1.5 text-zinc-200 shadow-2xl [direction:rtl]"
                     sideOffset={8}
                  >
                     <DropdownMenuGroup>
                        <DropdownMenuItem
                           className="h-8 rounded-md px-3 text-sm"
                           onSelect={() => navigate(`/${orgId}/settings/profile`)}
                        >
                           <span className="min-w-0 flex-1 truncate">تنظیمات</span>
                           <DropdownMenuShortcut className="ms-3 tracking-normal">G سپس S</DropdownMenuShortcut>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                           className="h-8 rounded-md px-3 text-sm"
                           onSelect={() => navigate(`/${orgId}/members`)}
                        >
                           دعوت و مدیریت اعضا
                        </DropdownMenuItem>
                     </DropdownMenuGroup>
                     <DropdownMenuSeparator className="-mx-2 my-2 bg-white/8" />
                     <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="h-8 rounded-md px-3 text-sm">
                           <span className="min-w-0 flex-1 truncate">جابجایی فضای کاری</span>
                           <DropdownMenuShortcut className="ms-3 tracking-normal">O سپس W</DropdownMenuShortcut>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-60 rounded-lg border-white/10 bg-[#1b1b1d] text-zinc-200">
                           <DropdownMenuLabel>فضاهای کاری شما</DropdownMenuLabel>
                           <DropdownMenuSeparator className="bg-white/8" />
                           {workspaceItems.map((item) => {
                              const isActive = item.workspace.slug === orgId;
                              return (
                                 <DropdownMenuItem
                                    key={item.membershipId}
                                    className="rounded-lg px-3 py-2"
                                    onSelect={() => navigate(item.role === 'OWNER' || item.role === 'ADMIN' ? `/${item.workspace.slug}/cockpit` : `/${item.workspace.slug}/team/all/all`)}
                                 >
                                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                       <span className="truncate text-sm">{item.workspace.name}</span>
                                       <span className="truncate text-xs text-zinc-500">{item.workspace.slug}</span>
                                    </div>
                                    {isActive ? <span className="text-xs text-lime-400">فعال</span> : null}
                                 </DropdownMenuItem>
                              );
                           })}
                        </DropdownMenuSubContent>
                     </DropdownMenuSub>
                     <DropdownMenuSeparator className="-mx-2 my-2 bg-white/8" />
                     <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="h-8 rounded-md px-3 text-sm">
                           <span className="min-w-0 flex-1 truncate">پوسته</span>
                           <DropdownMenuShortcut className="ms-3 tracking-normal">{currentThemeLabel}</DropdownMenuShortcut>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-44 rounded-lg border-white/10 bg-[#1b1b1d] text-zinc-200">
                           {themeOptions.map((item) => {
                              const Icon = item.icon;
                              const isActive = currentTheme === item.value;

                              return (
                                 <DropdownMenuItem
                                    key={item.value}
                                    className="h-8 rounded-md px-3 text-sm"
                                    onSelect={() => setTheme(item.value)}
                                 >
                                    <Icon className="size-4 text-zinc-500" />
                                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                                    {isActive ? <span className="text-xs text-lime-400">فعال</span> : null}
                                 </DropdownMenuItem>
                              );
                           })}
                        </DropdownMenuSubContent>
                     </DropdownMenuSub>
                     <DropdownMenuSeparator className="-mx-2 my-2 bg-white/8" />
                     <DropdownMenuItem className="h-8 rounded-md px-3 text-sm" onSelect={logout}>
                        <span className="min-w-0 flex-1 truncate">خروج</span>
                        <DropdownMenuShortcut className="ms-3 tracking-normal">⌥ ⇧ Q</DropdownMenuShortcut>
                     </DropdownMenuItem>
                  </DropdownMenuContent>
               </DropdownMenu>
               <div className="flex items-center gap-1">
                  <button
                     aria-label={fa.app.search}
                     className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-white/6 hover:text-zinc-200"
                     type="button"
                     onClick={() => window.dispatchEvent(new CustomEvent('taskara:command-menu'))}
                  >
                     <Search className="size-4" />
                  </button>
                  <button
                     aria-label={fa.nav.createIssue}
                     className="inline-flex size-8 items-center justify-center rounded-full bg-white/10 text-zinc-200 hover:bg-white/15"
                     type="button"
                     onClick={openCreateIssue}
                  >
                     <Plus className="size-4" />
                  </button>
               </div>
            </div>
         </SidebarHeader>
         <SidebarContent className="gap-4 px-2">
            <SidebarGroup className="p-0">
               <SidebarMenu>
                  {visiblePrimaryItems.map((item) => (
                     <SidebarMenuItem
                        key={item.id}
                        className={cn(
                           'cursor-grab active:cursor-grabbing',
                           draggingPrimaryItemId === item.id && 'opacity-50'
                        )}
                        draggable
                        onDragStart={(event) => {
                           event.dataTransfer.effectAllowed = 'move';
                           event.dataTransfer.setData(sidebarItemDragMimeType, item.id);
                           event.dataTransfer.setData('text/plain', item.id);
                           setDraggingPrimaryItemId(item.id);
                        }}
                        onDragEnd={() => {
                           setDraggingPrimaryItemId(null);
                           setPrimaryDropTargetId(null);
                        }}
                        onDragOver={(event) => {
                           event.preventDefault();
                           event.dataTransfer.dropEffect = 'move';
                           setPrimaryDropTargetId(item.id);
                        }}
                        onDragLeave={() =>
                           setPrimaryDropTargetId((current) => (current === item.id ? null : current))
                        }
                        onDrop={(event) => handlePrimaryItemDrop(event, item.id)}
                     >
                        <SidebarMenuButton
                           asChild
                           isActive={isPrimaryItemActive(item)}
                           className={cn(
                              sidebarItemClassName,
                              primaryDropTargetId === item.id &&
                                 draggingPrimaryItemId !== item.id &&
                                 'bg-white/7 ring-1 ring-indigo-400/35'
                           )}
                        >
                           <Link to={item.href} draggable={false}>
                              <item.icon />
                              <span>{item.title}</span>
                           </Link>
                        </SidebarMenuButton>
                        {typeof item.count === 'number' && item.count > 0 ? (
                           <SidebarMenuBadge className="left-2 right-auto text-zinc-500">
                              {item.count.toLocaleString('fa-IR')}
                           </SidebarMenuBadge>
                        ) : null}
                     </SidebarMenuItem>
                  ))}
                  {hiddenPrimaryItemCount > 0 ? (
                     <SidebarMenuItem>
                        <SidebarMenuButton
                           aria-expanded={showAllPrimaryItems}
                           className="h-8 rounded-lg text-[13px] text-zinc-500"
                           type="button"
                           onClick={() => setShowAllPrimaryItems((current) => !current)}
                        >
                           <ChevronDown
                              className={cn(
                                 'size-4 transition-transform',
                                 showAllPrimaryItems && 'rotate-180'
                              )}
                           />
                           <span>{showAllPrimaryItems ? 'نمایش کمتر' : 'نمایش بیشتر'}</span>
                        </SidebarMenuButton>
                     </SidebarMenuItem>
                  ) : null}
               </SidebarMenu>
            </SidebarGroup>
            <SidebarGroup className="p-0">
               <SidebarGroupLabel className="h-7 px-2 text-[12px]">{fa.nav.teams}</SidebarGroupLabel>
               <SidebarMenu>
                  {loadingTeams ? (
                     <SidebarMenuItem>
                        <div className="px-2 py-2 text-[13px] text-zinc-600">{fa.app.loading}</div>
                     </SidebarMenuItem>
                  ) : teams.length === 0 ? (
                     <SidebarMenuItem>
                        <SidebarMenuButton asChild className="h-8 rounded-lg text-[13px] text-zinc-500">
                           <Link to={`/${orgId}/teams`}>
                              <SidebarTeamIcon />
                              <span>{fa.nav.teams}</span>
                           </Link>
                        </SidebarMenuButton>
                     </SidebarMenuItem>
                  ) : (
                     teams.map((team) => {
                        const isOpen = expandedTeams[team.id] ?? true;

                        return (
                           <SidebarMenuItem key={team.id}>
                              <div className="flex items-center gap-1">
                                 <SidebarMenuButton
                                    className="h-8 min-w-0 flex-1 rounded-lg text-[13px] hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground"
                                    type="button"
                                    onClick={() => toggleTeamOpen(team.id)}
                                 >
                                    <SidebarTeamIcon className="size-4 shrink-0 text-pink-500" />
                                    <span className="min-w-0 truncate text-right">{team.name}</span>
                                    <ChevronDown
                                       className={cn(
                                          'size-4 shrink-0 text-zinc-500 transition-transform',
                                          !isOpen && 'rotate-90'
                                       )}
                                    />
                                 </SidebarMenuButton>
                              </div>
                              {isOpen ? (
                                 <div className="mb-2 mt-1 space-y-1 pe-5">
                                    {teamItems(team).map((item) => (
                                       <div key={`${team.id}-${item.title}`} className="relative">
                                          <SidebarMenuButton
                                             asChild
                                             isActive={pathname === item.href}
                                             className={sidebarItemClassName}
                                          >
                                             <Link to={item.href}>
                                                <item.icon />
                                                <span>{item.title}</span>
                                             </Link>
                                          </SidebarMenuButton>
                                       </div>
                                    ))}
                                 </div>
                              ) : null}
                           </SidebarMenuItem>
                        );
                     })
                  )}
               </SidebarMenu>
            </SidebarGroup>
         </SidebarContent>
         <SidebarFooter className="p-3">
            <Link
               to={`/${orgId}/settings/profile`}
               className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-start transition hover:bg-white/[0.04]"
            >
               <LinearAvatar
                  name={me?.user.name || workspaceName}
                  src={me?.user.avatarUrl}
                  className="size-8 shrink-0"
               />
               <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
                  {me?.user.name || fa.settings.currentUser}
               </span>
            </Link>
         </SidebarFooter>
      </Sidebar>
   );
}
