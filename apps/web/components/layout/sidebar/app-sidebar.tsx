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
import {
   LinearAvatar,
   SidebarInboxIcon,
   SidebarIssueIcon,
   SidebarMyIssuesIcon,
   SidebarProjectIcon,
   SidebarTeamIcon,
} from '@/components/taskara/linear-ui';
import { TaskaraLogo } from '@/components/taskara/brand-logo';
import { taskaraRequest } from '@/lib/taskara-client';
import { fa } from '@/lib/fa-copy';
import { clearAuthSession } from '@/store/auth-store';
import type { NotificationsResponse, PaginatedResponse, TaskaraMe, TaskaraTask, TaskaraTeam } from '@/lib/taskara-types';
import type { TaskaraWorkspaceMembership } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import {
   Activity,
   ChevronDown,
   Plus,
   Search,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
   const location = useLocation();
   const navigate = useNavigate();
   const pathname = location.pathname;
   const orgId = pathname.split('/').filter(Boolean)[0] || 'taskara';
   const [me, setMe] = React.useState<TaskaraMe | null>(null);
   const [teams, setTeams] = React.useState<TaskaraTeam[]>([]);
   const [workspaces, setWorkspaces] = React.useState<TaskaraWorkspaceMembership[]>([]);
   const [unreadCount, setUnreadCount] = React.useState(0);
   const [allIssueCount, setAllIssueCount] = React.useState(0);
   const [myIssueCount, setMyIssueCount] = React.useState(0);
   const [loadingTeams, setLoadingTeams] = React.useState(true);
   const [expandedTeams, setExpandedTeams] = React.useState<Record<string, boolean>>({});

   const pathParts = pathname.split('/').filter(Boolean);
   const activeTeamSlug = pathParts[1] === 'team' ? pathParts[2] : null;
   const isIssueListRoute = pathParts[1] === 'tasks' || (pathParts[1] === 'team' && pathParts[3] === 'all');

   const logout = React.useCallback(() => {
      void taskaraRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
      clearAuthSession();
      navigate('/login', { replace: true });
   }, [navigate]);

   const loadSidebarData = React.useCallback(async (isCancelled: () => boolean) => {
      setLoadingTeams(true);

      const [meResult, teamsResult, workspacesResult, notificationsResult, allTasksResult, myTasksResult] = await Promise.allSettled([
         taskaraRequest<TaskaraMe>('/me'),
         taskaraRequest<TaskaraTeam[]>('/teams'),
         taskaraRequest<{ items: TaskaraWorkspaceMembership[]; total: number }>('/workspaces'),
         taskaraRequest<NotificationsResponse>('/notifications?limit=1'),
         taskaraRequest<PaginatedResponse<TaskaraTask>>('/tasks?limit=1'),
         taskaraRequest<PaginatedResponse<TaskaraTask>>('/tasks?mine=true&limit=1'),
      ]);

      if (isCancelled()) return;

      setMe(meResult.status === 'fulfilled' ? meResult.value : null);
      setTeams(teamsResult.status === 'fulfilled' ? teamsResult.value : []);
      setWorkspaces(workspacesResult.status === 'fulfilled' ? workspacesResult.value.items : []);
      const notificationData =
         notificationsResult.status === 'fulfilled' ? (notificationsResult.value as NotificationsResponse) : null;
      setUnreadCount(notificationData?.unreadCount ?? 0);
      setAllIssueCount(allTasksResult.status === 'fulfilled' ? allTasksResult.value.total : 0);
      setMyIssueCount(myTasksResult.status === 'fulfilled' ? myTasksResult.value.total : 0);
      setLoadingTeams(false);
   }, []);

   React.useEffect(() => {
      let cancelled = false;

      const refreshSidebarData = () => {
         void loadSidebarData(() => cancelled);
      };

      refreshSidebarData();
      window.addEventListener('taskara:teams-updated', refreshSidebarData);

      return () => {
         cancelled = true;
         window.removeEventListener('taskara:teams-updated', refreshSidebarData);
      };
   }, [loadSidebarData]);

   React.useEffect(() => {
      if (!teams.length) return;

      setExpandedTeams((current) => {
         const next = { ...current };

         for (const team of teams) {
            next[team.id] = next[team.id] ?? true;
            if (team.slug === activeTeamSlug) next[team.id] = true;
         }

         return next;
      });
   }, [activeTeamSlug, teams]);

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
      if (!isIssueListRoute) {
         navigate(`/${orgId}/team/${activeTeamSlug || 'all'}/all`);
      }
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('taskara:create-issue')), 0);
   };

   const primaryItems = [
      { title: fa.nav.inbox, href: `/${orgId}/inbox`, icon: SidebarInboxIcon, count: unreadCount },
      { title: fa.nav.allTasks, href: `/${orgId}/tasks`, icon: SidebarIssueIcon, count: allIssueCount },
      { title: fa.nav.myIssues, href: `/${orgId}/team/all/all`, icon: SidebarMyIssuesIcon, count: myIssueCount },
      { title: fa.nav.heartbeat, href: `/${orgId}/heartbeat`, icon: Activity },
   ];
   const teamItems = (team: TaskaraTeam) => [
      { title: fa.nav.issues, href: `/${orgId}/team/${team.slug}/all`, icon: SidebarIssueIcon },
      { title: fa.nav.projects, href: `/${orgId}/team/${team.slug}/projects`, icon: SidebarProjectIcon },
   ];

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
                                    onSelect={() => navigate(`/${item.workspace.slug}/team/all/all`)}
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
                  {primaryItems.map((item) => (
                        <SidebarMenuItem key={item.href}>
                           <SidebarMenuButton
                              asChild
                              isActive={pathname === item.href}
                              className="h-8 rounded-lg text-[13px]"
                           >
                           <Link to={item.href}>
                              <item.icon />
                              <span>{item.title}</span>
                           </Link>
                        </SidebarMenuButton>
                        {typeof item.count === 'number' ? (
                           <SidebarMenuBadge className="left-2 right-auto text-zinc-500">
                              {item.count.toLocaleString('fa-IR')}
                           </SidebarMenuBadge>
                        ) : null}
                     </SidebarMenuItem>
                  ))}
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
                                    onClick={() =>
                                       setExpandedTeams((current) => ({
                                          ...current,
                                          [team.id]: !isOpen,
                                       }))
                                    }
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
                                             className="h-8 rounded-lg text-[13px]"
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
