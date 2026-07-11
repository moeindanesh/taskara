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
   SidebarMenuButton,
   SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useTheme } from 'next-themes';
import {
   LinearAvatar,
   SidebarIssueIcon,
   SidebarTeamIcon,
} from '@/components/taskara/linear-ui';
import { TaskaraLogo } from '@/components/taskara/brand-logo';
import { useLiveRefresh, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { selectSidebarCounts } from '@/lib/workspace-data/selectors';
import { fa } from '@/lib/fa-copy';
import { clearAuthSession, getAuthSession, setAuthSession } from '@/store/auth-store';
import type { TaskaraMe, TaskaraWorkspaceMembership } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import {
   ChevronDown,
   Diamond,
   Laptop,
   Moon,
   Plus,
   ScanEye,
   Search,
   Sun,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

const sidebarItemClassName =
   'h-8 rounded-lg text-[13px] data-[active=true]:bg-zinc-200 data-[active=true]:text-zinc-950 data-[active=true]:hover:bg-zinc-200 data-[active=true]:hover:text-zinc-950 dark:data-[active=true]:bg-white/8 dark:data-[active=true]:text-zinc-100 dark:data-[active=true]:hover:bg-white/10 dark:data-[active=true]:hover:text-zinc-100';

function sidebarRefreshSourceMatches(detail: WorkspaceRefreshDetail) {
   return workspaceRefreshSourceMatches(detail, 'workspace');
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
   const location = useLocation();
   const navigate = useNavigate();
   const { theme, setTheme } = useTheme();
   const pathname = location.pathname;
   const orgId = pathname.split('/').filter(Boolean)[0] || 'taskara';
   const taskSync = useWorkspaceTaskSync();
   const [me, setMe] = React.useState<TaskaraMe | null>(null);
   const [workspaces, setWorkspaces] = React.useState<TaskaraWorkspaceMembership[]>([]);
   const [showTeams, setShowTeams] = React.useState(false);
   const loadRequestRef = React.useRef(0);
   const teams = taskSync.workspaceData.teams;
   const loadingTeams = !taskSync.hasBootstrapped;
   const sidebarCounts = React.useMemo(
      () => selectSidebarCounts(taskSync.workspaceData, me?.user.id),
      [me?.user.id, taskSync.workspaceData]
   );

   const currentRole = me?.role || getAuthSession()?.role;
   const isManager = currentRole === 'OWNER';
   const cockpitHref = `/${orgId}/cockpit`;
   const myIssuesHref = `/${orgId}/team/all/all`;

   const logout = React.useCallback(() => {
      void taskaraRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
      clearAuthSession();
      navigate('/login', { replace: true });
   }, [navigate]);

   const loadSidebarData = React.useCallback(async () => {
      const requestId = ++loadRequestRef.current;
      const [meResult, workspacesResult] = await Promise.allSettled([
         taskaraRequest<TaskaraMe>('/me'),
         taskaraRequest<{ items: TaskaraWorkspaceMembership[]; total: number }>('/workspaces'),
      ]);

      if (requestId !== loadRequestRef.current) return;

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
      setWorkspaces(workspacesResult.status === 'fulfilled' ? workspacesResult.value.items : []);
   }, []);

   const refreshSidebarData = React.useCallback(() => {
      void loadSidebarData();
   }, [loadSidebarData]);

   React.useEffect(() => {
      refreshSidebarData();
      const refreshTeams = () => void taskSync.refresh({ preserveVisibleState: true });
      window.addEventListener('taskara:teams-updated', refreshTeams);

      return () => {
         loadRequestRef.current += 1;
         window.removeEventListener('taskara:teams-updated', refreshTeams);
      };
   }, [orgId, refreshSidebarData, taskSync.refresh]);

   useLiveRefresh(refreshSidebarData, {
      fireOnMount: false,
      workspaceEventFilter: sidebarRefreshSourceMatches,
   });

   React.useEffect(() => setShowTeams(false), [orgId]);

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

   const currentTheme = theme || 'system';
   const themeOptions = [
      { value: 'light', label: 'روشن', icon: Sun },
      { value: 'dark', label: 'تیره', icon: Moon },
      { value: 'system', label: 'سیستم', icon: Laptop },
   ];
   const currentThemeLabel =
      themeOptions.find((item) => item.value === currentTheme)?.label || 'سیستم';

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
               <SidebarGroupLabel className="h-7 px-2 text-[12px]">
                  {isManager ? fa.nav.managerLoop : fa.nav.workspace}
               </SidebarGroupLabel>
               <SidebarMenu>
                  {isManager ? (
                     <SidebarMenuItem>
                        <SidebarMenuButton
                           asChild
                           isActive={pathname === cockpitHref}
                           className={sidebarItemClassName}
                        >
                           <Link to={cockpitHref}>
                              <ScanEye />
                              <span>{fa.nav.cockpit}</span>
                           </Link>
                        </SidebarMenuButton>
                     </SidebarMenuItem>
                  ) : null}
                  <SidebarMenuItem>
                     <SidebarMenuButton
                        asChild
                        isActive={pathname === myIssuesHref}
                        className={sidebarItemClassName}
                     >
                        <Link to={myIssuesHref}>
                           <SidebarIssueIcon />
                           <span>{fa.nav.myIssues}</span>
                        </Link>
                     </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                     <SidebarMenuButton
                        asChild
                        isActive={pathname === `/${orgId}/milestones` || pathname.startsWith(`/${orgId}/milestones/`)}
                        className={sidebarItemClassName}
                     >
                        <Link to={`/${orgId}/milestones`}>
                           <Diamond className="text-indigo-400" />
                           <span className="min-w-0 flex-1 truncate">{fa.nav.milestones}</span>
                           {sidebarCounts.myOverdueMilestoneCount > 0 ? (
                              <span
                                 aria-label={`${sidebarCounts.myOverdueMilestoneCount.toLocaleString('fa-IR')} مایلستون عقب‌افتاده متعلق به شما`}
                                 className="inline-flex min-w-5 items-center justify-center rounded-full bg-rose-400/12 px-1.5 text-[10px] tabular-nums text-rose-300"
                                 title={`${sidebarCounts.myOverdueMilestoneCount.toLocaleString('fa-IR')} مایلستون عقب‌افتاده`}
                              >
                                 {sidebarCounts.myOverdueMilestoneCount.toLocaleString('fa-IR')}
                              </span>
                           ) : null}
                        </Link>
                     </SidebarMenuButton>
                  </SidebarMenuItem>
               </SidebarMenu>
            </SidebarGroup>
            <SidebarGroup className="p-0">
               <SidebarMenu>
                  <SidebarMenuItem>
                     <SidebarMenuButton
                        aria-expanded={showTeams}
                        className="h-8 rounded-lg text-[13px] text-zinc-500"
                        type="button"
                        onClick={() => setShowTeams((current) => !current)}
                     >
                        <SidebarTeamIcon className="size-4 text-pink-500" />
                        <span className="min-w-0 flex-1 truncate text-right">{fa.nav.teams}</span>
                        {!loadingTeams && teams.length ? (
                           <span className="text-[11px] text-zinc-600">{teams.length.toLocaleString('fa-IR')}</span>
                        ) : null}
                        <ChevronDown className={cn('size-4 transition-transform', !showTeams && 'rotate-90')} />
                     </SidebarMenuButton>
                     {showTeams ? (
                        <div className="mb-1 mt-1 space-y-1 pe-5">
                           {loadingTeams ? (
                              <div className="px-2 py-2 text-[13px] text-zinc-600">{fa.app.loading}</div>
                           ) : teams.length ? (
                              teams.map((team) => {
                                 const href = `/${orgId}/team/${team.slug}/all`;
                                 const activePrefix = `/${orgId}/team/${team.slug}/`;
                                 return (
                                    <SidebarMenuButton
                                       asChild
                                       className={sidebarItemClassName}
                                       isActive={pathname.startsWith(activePrefix)}
                                       key={team.id}
                                    >
                                       <Link to={href}>
                                          <SidebarIssueIcon />
                                          <span className="truncate">{team.name}</span>
                                       </Link>
                                    </SidebarMenuButton>
                                 );
                              })
                           ) : (
                              <SidebarMenuButton asChild className={sidebarItemClassName}>
                                 <Link to={`/${orgId}/teams`}>
                                    <SidebarTeamIcon />
                                    <span>{fa.nav.teams}</span>
                                 </Link>
                              </SidebarMenuButton>
                           )}
                        </div>
                     ) : null}
                  </SidebarMenuItem>
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
