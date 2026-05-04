import React from 'react';
import { AppSidebar } from '@/components/layout/sidebar/app-sidebar';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ShortcutKey } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';
import { Bell, FolderKanban, ListTodo, Plus, Search, Settings, Trophy, Users, UsersRound , Activity } from 'lucide-react';
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

export default function MainLayout({ children, header, headersNumber = 2, showSidebar = true }: MainLayoutProps) {
   const navigate = useNavigate();
   const location = useLocation();
   const [commandOpen, setCommandOpen] = React.useState(false);
   const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
   const pathParts = location.pathname.split('/').filter(Boolean);
   const orgId = pathParts[0] || 'taskara';
   const routeKey = pathParts[1] || 'team';
   const activeTeamSlug = pathParts[1] === 'team' && pathParts[2] !== 'all' ? pathParts[2] : null;
   const isIssueListRoute = pathParts[1] === 'tasks' || (pathParts[1] === 'team' && pathParts[3] === 'all');
   const isProjectsRoute =
      location.pathname.endsWith('/projects') || (pathParts[1] === 'team' && pathParts[3] === 'projects');
   const pageOwnsScroll = ['heartbeat', 'inbox', 'issue', 'projects', 'settings', 'tasks', 'team'].includes(routeKey);
   const height = {
      1: 'h-[calc(100dvh-40px)] lg:h-[calc(100dvh-48px)]',
      2: 'h-[calc(100dvh-80px)] lg:h-[calc(100dvh-88px)]',
   };

   const isEditableTarget = React.useCallback((target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
   }, []);

   const openCreateIssue = React.useCallback(() => {
      if (!isIssueListRoute) {
         navigate(`/${orgId}/team/${activeTeamSlug || 'all'}/all`);
      }
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('taskara:create-issue')), 0);
   }, [activeTeamSlug, isIssueListRoute, navigate, orgId]);

   const openCreateProject = React.useCallback(() => {
      if (!isProjectsRoute) {
         navigate(activeTeamSlug ? `/${orgId}/team/${activeTeamSlug}/projects` : `/${orgId}/projects`);
      }
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('taskara:create-project')), 0);
   }, [activeTeamSlug, isProjectsRoute, navigate, orgId]);

   React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
         if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            setCommandOpen(true);
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
   }, [isEditableTarget]);

   const commandItems = [
      {
         label: fa.command.createIssue,
         description: fa.command.createIssueDescription,
         icon: Plus,
         shortcut: 'C / ز',
         run: openCreateIssue,
      },
      {
         label: fa.command.createProject,
         description: fa.command.createProjectDescription,
         icon: FolderKanban,
         shortcut: '+',
         run: openCreateProject,
      },
      {
         label: fa.command.goIssues,
         description: fa.pages.issuesDescription,
         icon: ListTodo,
         shortcut: 'G I',
         run: () => navigate(`/${orgId}/team/all/all`),
      },
      {
         label: fa.command.goAllTasks,
         description: fa.pages.allTasksDescription,
         icon: ListTodo,
         shortcut: 'G A',
         run: () => navigate(`/${orgId}/tasks`),
      },
      {
         label: fa.command.goInbox,
         description: fa.pages.inboxDescription,
         icon: Bell,
         shortcut: 'G N',
         run: () => navigate(`/${orgId}/inbox`),
      },
      {
         label: fa.command.goProjects,
         description: fa.pages.projectsDescription,
         icon: FolderKanban,
         shortcut: 'G P',
         run: () => navigate(`/${orgId}/projects`),
      },
      {
         label: fa.command.goLeaderboard,
         description: fa.pages.leaderboardDescription,
         icon: Trophy,
         shortcut: 'G L',
         run: () => navigate(`/${orgId}/leaderboard`),
      },
     {
         label: fa.command.goHeartbeat,
         description: fa.pages.heartbeatDescription,
         icon: Activity,
         shortcut: 'G H',
         run: () => navigate(`/${orgId}/heartbeat`),
      },
      {
         label: fa.command.goMembers,
         description: fa.pages.membersDescription,
         icon: Users,
         shortcut: 'G M',
         run: () => navigate(`/${orgId}/members`),
      },
      {
         label: fa.command.goTeams,
         description: fa.pages.teamsDescription,
         icon: UsersRound,
         shortcut: 'G T',
         run: () => navigate(`/${orgId}/teams`),
      },
      {
         label: fa.command.goSettings,
         description: fa.pages.settingsDescription,
         icon: Settings,
         shortcut: 'G S',
         run: () => navigate(`/${orgId}/settings/profile`),
      },
   ];

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
         <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
            <DialogContent
               aria-label={fa.command.title}
               className="max-w-[640px] gap-0 overflow-hidden border-white/10 bg-[#1d1d20] p-0 shadow-2xl"
            >
               <DialogHeader className="border-b border-white/8 px-4 py-3">
                  <DialogTitle className="flex items-center gap-2 text-sm">
                     <Search className="size-4 text-zinc-500" />
                     {fa.command.title}
                  </DialogTitle>
                  <DialogDescription className="sr-only">
                     {fa.command.description}
                  </DialogDescription>
               </DialogHeader>
               <div className="max-h-[440px] overflow-y-auto p-2" data-testid="command-menu">
                  {commandItems.map((item) => {
                     const Icon = item.icon;
                     return (
                        <button
                           key={item.label}
                           className="group flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-start outline-none transition hover:bg-white/6 focus:bg-white/8"
                           type="button"
                           onClick={() => {
                              setCommandOpen(false);
                              item.run();
                           }}
                        >
                           <span className="flex min-w-0 items-center gap-3">
                              <span className="inline-flex size-7 items-center justify-center rounded-md bg-white/6 text-zinc-400 group-hover:text-zinc-100">
                                 <Icon className="size-4" />
                              </span>
                              <span className="min-w-0">
                                 <span className="block truncate text-sm font-medium text-zinc-200">
                                    {item.label}
                                 </span>
                                 <span className="block truncate text-xs text-zinc-500">{item.description}</span>
                              </span>
                           </span>
                           <ShortcutKey>{item.shortcut}</ShortcutKey>
                        </button>
                     );
                  })}
               </div>
            </DialogContent>
         </Dialog>
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
