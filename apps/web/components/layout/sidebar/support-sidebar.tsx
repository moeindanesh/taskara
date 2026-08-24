'use client';

import * as React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from 'next-themes';
import { ChevronDown, Laptop, Moon, Plus, Search, Sun } from 'lucide-react';
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
import { TaskaraLogo } from '@/components/taskara/brand-logo';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { workspaceNavigationIcons } from '@/components/layout/workspace-navigation-icon';
import { fa } from '@/lib/fa-copy';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraWorkspaceMembership } from '@/lib/taskara-types';
import {
   workspaceCreateAction,
   workspaceHomeForMembership,
   workspaceRouteForPath,
   workspaceSupportSidebarGroups,
   type WorkspaceSidebarGroup,
   type WorkspaceSidebarGroupId,
} from '@/lib/workspace-navigation';
import { useWorkspaceNavigationRuntime, useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import type { SupportQueueKind } from '@/lib/support-types';
import { clearAuthSession } from '@/store/auth-store';

const sidebarItemClassName =
   'h-8 rounded-lg text-[13px] data-[active=true]:bg-zinc-200 data-[active=true]:text-zinc-950 data-[active=true]:hover:bg-zinc-200 data-[active=true]:hover:text-zinc-950 dark:data-[active=true]:bg-white/8 dark:data-[active=true]:text-zinc-100 dark:data-[active=true]:hover:bg-white/10 dark:data-[active=true]:hover:text-zinc-100';

export function SupportSidebar(props: React.ComponentProps<typeof Sidebar>) {
   const navigate = useNavigate();
   const location = useLocation();
   const { theme, setTheme } = useTheme();
   const runtime = useWorkspaceRuntime();
   const navigationRuntime = useWorkspaceNavigationRuntime();
   const support = useSupportWorkspace();
   const [workspaces, setWorkspaces] = React.useState<TaskaraWorkspaceMembership[]>([]);
   const sidebarGroups = workspaceSupportSidebarGroups(navigationRuntime);
   const activeRoute = workspaceRouteForPath(location.pathname, runtime.workspaceSlug);
   const createAction = workspaceCreateAction(navigationRuntime);

   React.useEffect(() => {
      let cancelled = false;
      void taskaraRequest<{ items: TaskaraWorkspaceMembership[]; total: number }>('/workspaces')
         .then((result) => {
            if (!cancelled) setWorkspaces(result.items);
         })
         .catch(() => {
            if (!cancelled) setWorkspaces([]);
         });
      return () => {
         cancelled = true;
      };
   }, [runtime.workspaceSlug]);

   const workspaceItems = workspaces.length
      ? workspaces
      : [{
           membershipId: runtime.me.workspace.id,
           role: runtime.role || 'MEMBER',
           joinedAt: '',
           workspace: runtime.me.workspace,
        }];

   const logout = () => {
      void taskaraRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
      clearAuthSession();
      navigate('/login', { replace: true });
   };

   const currentTheme = theme || 'system';
   const themeOptions = [
      { value: 'light', label: 'روشن', icon: Sun },
      { value: 'dark', label: 'تیره', icon: Moon },
      { value: 'system', label: 'سیستم', icon: Laptop },
   ];

   return (
      <Sidebar side="right" collapsible="offcanvas" className="border-l border-white/6 bg-[#070708]" {...props}>
         <SidebarHeader className="gap-3 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <button className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-start text-sm font-semibold text-zinc-200 hover:bg-white/5" type="button">
                        <TaskaraLogo className="size-7 rounded-lg border border-white/10" />
                        <span className="truncate">{runtime.me.workspace.name}</span>
                        <ChevronDown className="size-4 text-zinc-500" />
                     </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[260px] rounded-lg border-white/10 bg-[#1b1b1d] p-1.5 text-zinc-200 [direction:rtl]" sideOffset={8}>
                     <DropdownMenuGroup>
                        <DropdownMenuItem className="h-8 rounded-md px-3 text-sm" onSelect={() => navigate(`/${runtime.workspaceSlug}/settings/profile`)}>
                           تنظیمات
                        </DropdownMenuItem>
                        {navigationRuntime.capabilities.has('common.members') ? (
                           <DropdownMenuItem className="h-8 rounded-md px-3 text-sm" onSelect={() => navigate(`/${runtime.workspaceSlug}/members`)}>
                              دعوت و مدیریت اعضا
                           </DropdownMenuItem>
                        ) : null}
                     </DropdownMenuGroup>
                     <DropdownMenuSeparator className="-mx-2 my-2 bg-white/8" />
                     <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="h-8 rounded-md px-3 text-sm">جابجایی فضای کاری</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-60 rounded-lg border-white/10 bg-[#1b1b1d] text-zinc-200">
                           <DropdownMenuLabel>فضاهای کاری شما</DropdownMenuLabel>
                           <DropdownMenuSeparator className="bg-white/8" />
                           {workspaceItems.map((item) => (
                              <DropdownMenuItem
                                 key={item.membershipId}
                                 className="rounded-lg px-3 py-2"
                                 onSelect={() => navigate(workspaceHomeForMembership(item.workspace, item.role))}
                              >
                                 <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="truncate text-sm">{item.workspace.name}</span>
                                    <span className="truncate text-xs text-zinc-500">{item.workspace.slug}</span>
                                 </div>
                                 {item.workspace.slug === runtime.workspaceSlug ? <span className="text-xs text-lime-400">فعال</span> : null}
                              </DropdownMenuItem>
                           ))}
                        </DropdownMenuSubContent>
                     </DropdownMenuSub>
                     <DropdownMenuSeparator className="-mx-2 my-2 bg-white/8" />
                     <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="h-8 rounded-md px-3 text-sm">
                           <span className="min-w-0 flex-1 truncate">پوسته</span>
                           <DropdownMenuShortcut>{themeOptions.find((item) => item.value === currentTheme)?.label || 'سیستم'}</DropdownMenuShortcut>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-44 rounded-lg border-white/10 bg-[#1b1b1d] text-zinc-200">
                           {themeOptions.map((item) => {
                              const Icon = item.icon;
                              return (
                                 <DropdownMenuItem key={item.value} className="h-8 rounded-md px-3 text-sm" onSelect={() => setTheme(item.value)}>
                                    <Icon className="size-4 text-zinc-500" />
                                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                                    {currentTheme === item.value ? <span className="text-xs text-lime-400">فعال</span> : null}
                                 </DropdownMenuItem>
                              );
                           })}
                        </DropdownMenuSubContent>
                     </DropdownMenuSub>
                     <DropdownMenuSeparator className="-mx-2 my-2 bg-white/8" />
                     <DropdownMenuItem className="h-8 rounded-md px-3 text-sm" onSelect={logout}>خروج</DropdownMenuItem>
                  </DropdownMenuContent>
               </DropdownMenu>
               <div className="flex items-center gap-1">
                  <button aria-label={fa.app.search} className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-white/6 hover:text-zinc-200" type="button" onClick={() => window.dispatchEvent(new CustomEvent('taskara:command-menu'))}>
                     <Search className="size-4" />
                  </button>
                  {createAction ? (
                     <button aria-label={createAction.label} className="inline-flex size-8 items-center justify-center rounded-full bg-white/10 text-zinc-200 hover:bg-white/15" type="button" onClick={() => window.dispatchEvent(new CustomEvent(createAction.eventName))}>
                        <Plus className="size-4" />
                     </button>
                  ) : null}
               </div>
            </div>
         </SidebarHeader>
         <SidebarContent className="gap-4 px-2">
            {sidebarGroups.map((group) => (
               <SupportNavigationGroup
                  key={group.id}
                  groupId={group.id}
                  label={fa.support.navGroups[group.id]}
                  routes={group.routes}
                  activeRouteId={activeRoute?.id}
                  runtime={navigationRuntime}
                  workspaceSlug={runtime.workspaceSlug}
                  counts={group.id === 'work' ? support.queueCounts : undefined}
                  collapsible={group.id === 'manage'}
               />
            ))}
         </SidebarContent>
         <SidebarFooter className="p-3">
            <Link to={`/${runtime.workspaceSlug}/settings/profile`} className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-start transition hover:bg-white/[0.04]">
               <LinearAvatar name={runtime.me.user.name} src={runtime.me.user.avatarUrl} className="size-8 shrink-0" />
               <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{runtime.me.user.name}</span>
            </Link>
         </SidebarFooter>
      </Sidebar>
   );
}

function SupportNavigationGroup({
   activeRouteId,
   collapsible = false,
   groupId,
   label,
   routes,
   runtime,
   workspaceSlug,
   counts,
}: {
   activeRouteId?: string;
   collapsible?: boolean;
   groupId: WorkspaceSidebarGroupId;
   label: string;
   routes: WorkspaceSidebarGroup['routes'];
   runtime: ReturnType<typeof useWorkspaceNavigationRuntime>;
   workspaceSlug: string;
   counts?: Readonly<Partial<Record<SupportQueueKind, number>>>;
}) {
   const regionId = React.useId();
   const containsActiveRoute = routes.some((route) => route.id === activeRouteId);
   const [open, setOpen] = React.useState(!collapsible || containsActiveRoute);

   React.useEffect(() => {
      if (containsActiveRoute) setOpen(true);
   }, [containsActiveRoute]);

   return (
      <SidebarGroup className="p-0" data-testid={`support-sidebar-group-${groupId}`}>
         {collapsible ? (
            <SidebarGroupLabel className="h-8 p-0 text-[12px]">
               <button
                  type="button"
                  aria-controls={regionId}
                  aria-expanded={open}
                  className="flex h-8 w-full items-center justify-between rounded-md px-2 text-start outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-sky-400/70"
                  onClick={() => setOpen((current) => !current)}
               >
                  <span>{label}</span>
                  <ChevronDown
                     aria-hidden="true"
                     className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
                  />
               </button>
            </SidebarGroupLabel>
         ) : (
            <SidebarGroupLabel className="h-7 px-2 text-[12px]">{label}</SidebarGroupLabel>
         )}
         <SidebarMenu id={regionId} hidden={!open}>
            {routes.map((route) => {
               const Icon = workspaceNavigationIcons[route.icon];
               const queue = supportQueueByRoute[route.id];
               const count = queue ? counts?.[queue] : undefined;
               return (
                  <SidebarMenuItem key={route.id}>
                     <SidebarMenuButton asChild isActive={activeRouteId === route.id} className={sidebarItemClassName}>
                        <Link to={route.path(workspaceSlug, runtime)}>
                           <Icon className="size-4" />
                           <span>{route.label}</span>
                        </Link>
                     </SidebarMenuButton>
                     {typeof count === 'number' && count > 0 ? (
                        <SidebarMenuBadge className="font-mono text-[10px] text-zinc-500">
                           {count > 999 ? '۹۹۹+' : count.toLocaleString('fa-IR')}
                        </SidebarMenuBadge>
                     ) : null}
                  </SidebarMenuItem>
               );
            })}
         </SidebarMenu>
      </SidebarGroup>
   );
}

const supportQueueByRoute: Record<string, SupportQueueKind | undefined> = {
   'support-triage': 'TRIAGE',
   'support-department-inbox': 'DEPARTMENT_INBOX',
   'support-my-cases': 'MY_CASES',
   'support-attention': 'NEEDS_ATTENTION',
};
