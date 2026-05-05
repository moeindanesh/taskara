import React from 'react';
import { AppSidebar } from '@/components/layout/sidebar/app-sidebar';
import { Button } from '@/components/ui/button';
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
import { areDesktopNotificationsEnabled, setDesktopNotificationsEnabled as persistDesktopNotificationsEnabled } from '@/lib/notification-service-worker';
import { cn } from '@/lib/utils';
import { Bell, FolderKanban, ListTodo, Plus, Search, Settings, Trophy, Users, UsersRound , Activity } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

interface MainLayoutProps {
   children: React.ReactNode;
   header?: React.ReactNode;
   headersNumber?: 1 | 2;
   showSidebar?: boolean;
}

const NOTIFICATION_PROMPT_DISMISSED_STORAGE_KEY = 'taskara.notifications.prompt.dismissed.v1';

type BrowserNotificationHelp = {
   title: string;
   steps: string[];
};

function detectBrowserForNotificationHelp(userAgent: string): 'edge' | 'chrome' | 'firefox' | 'safari' | 'other' {
   if (/Edg\//i.test(userAgent)) return 'edge';
   if (/Firefox\//i.test(userAgent)) return 'firefox';
   if (/Safari\//i.test(userAgent) && !/Chrome\//i.test(userAgent) && !/Chromium\//i.test(userAgent)) return 'safari';
   if (/Chrome\//i.test(userAgent) || /Chromium\//i.test(userAgent)) return 'chrome';
   return 'other';
}

function getBrowserNotificationHelp(browser: 'edge' | 'chrome' | 'firefox' | 'safari' | 'other'): BrowserNotificationHelp {
   switch (browser) {
      case 'edge':
         return {
            title: 'Microsoft Edge',
            steps: [
               'روی آیکن قفل کنار نوار آدرس کلیک کن.',
               'گزینه Notifications را روی Allow قرار بده.',
               'صفحه را یک‌بار رفرش کن.',
            ],
         };
      case 'firefox':
         return {
            title: 'Mozilla Firefox',
            steps: [
               'روی آیکن قفل کنار آدرس سایت کلیک کن.',
               'در بخش Permissions، اعلان‌ها را روی Allow قرار بده.',
               'صفحه را یک‌بار رفرش کن و دوباره فعال‌سازی را بزن.',
            ],
         };
      case 'safari':
         return {
            title: 'Safari',
            steps: [
               'از منوی Safari گزینه Settings for This Website را باز کن.',
               'Notifications را روی Allow قرار بده.',
               'صفحه را یک‌بار رفرش کن.',
            ],
         };
      case 'chrome':
         return {
            title: 'Google Chrome',
            steps: [
               'روی آیکن قفل کنار نوار آدرس کلیک کن.',
               'گزینه Notifications را روی Allow قرار بده.',
               'صفحه را یک‌بار رفرش کن.',
            ],
         };
      default:
         return {
            title: 'مرورگر',
            steps: [
               'تنظیمات مجوز سایت را از کنار نوار آدرس باز کن.',
               'اعلان‌ها (Notifications) را روی Allow قرار بده.',
               'صفحه را رفرش کن و دوباره فعال‌سازی را بزن.',
            ],
         };
   }
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
   const [notificationPromptOpen, setNotificationPromptOpen] = React.useState(false);
   const [notificationPromptDontShowAgain, setNotificationPromptDontShowAgain] = React.useState(false);
   const [notificationPromptError, setNotificationPromptError] = React.useState('');
   const [notificationPermission, setNotificationPermission] = React.useState<NotificationPermission | 'unsupported'>('unsupported');
   const pathParts = location.pathname.split('/').filter(Boolean);
   const orgId = pathParts[0] || 'taskara';
   const routeKey = pathParts[1] || 'team';
   const activeTeamSlug = pathParts[1] === 'team' && pathParts[2] !== 'all' ? pathParts[2] : null;
   const isIssueListRoute = pathParts[1] === 'tasks' || (pathParts[1] === 'team' && pathParts[3] === 'all');
   const isProjectsRoute =
      location.pathname.endsWith('/projects') || (pathParts[1] === 'team' && pathParts[3] === 'projects');
   const pageOwnsScroll = ['heartbeat', 'inbox', 'issue', 'projects', 'settings', 'tasks', 'team'].includes(routeKey);
   const browserNotificationHelp = React.useMemo(() => {
      if (typeof navigator === 'undefined') return getBrowserNotificationHelp('other');
      return getBrowserNotificationHelp(detectBrowserForNotificationHelp(navigator.userAgent));
   }, []);
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

   const persistNotificationPromptDismissed = React.useCallback((dismissed: boolean) => {
      if (typeof window === 'undefined') return;

      try {
         if (dismissed) {
            window.localStorage.setItem(NOTIFICATION_PROMPT_DISMISSED_STORAGE_KEY, '1');
            return;
         }

         window.localStorage.removeItem(NOTIFICATION_PROMPT_DISMISSED_STORAGE_KEY);
      } catch {
         // Ignore localStorage failures.
      }
   }, []);

   const closeNotificationPrompt = React.useCallback(() => {
      if (notificationPromptDontShowAgain) {
         persistNotificationPromptDismissed(true);
      }
      setNotificationPromptOpen(false);
   }, [notificationPromptDontShowAgain, persistNotificationPromptDismissed]);

   const handleEnableNotifications = React.useCallback(async () => {
      if (typeof window === 'undefined') return;

      setNotificationPromptError('');

      if (!('Notification' in window)) {
         setNotificationPermission('unsupported');
         setNotificationPromptError('مرورگر شما از اعلان دسکتاپ پشتیبانی نمی‌کند.');
         return;
      }

      if (window.Notification.permission === 'denied') {
         setNotificationPermission('denied');
         persistDesktopNotificationsEnabled(true);
         setNotificationPromptError('مجوز اعلان مرورگر مسدود است. راهنمای مرورگر پایین را انجام بده و صفحه را رفرش کن.');
         return;
      }

      let permission: NotificationPermission = window.Notification.permission;
      if (permission !== 'granted') {
         permission = await window.Notification.requestPermission();
      }

      setNotificationPermission(permission);

      if (permission === 'granted') {
         persistDesktopNotificationsEnabled(true);
         closeNotificationPrompt();
         return;
      }

      setNotificationPromptError('مجوز اعلان تایید نشد. می‌توانی بعدا دوباره امتحان کنی.');
   }, [closeNotificationPrompt]);

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

   React.useEffect(() => {
      if (typeof window === 'undefined') return;

      const supported = 'Notification' in window;
      const permission = supported ? window.Notification.permission : 'unsupported';
      setNotificationPermission(permission);

      if (!supported) return;
      if (permission === 'granted') return;
      if (!areDesktopNotificationsEnabled()) return;

      let dismissed = false;
      try {
         dismissed = window.localStorage.getItem(NOTIFICATION_PROMPT_DISMISSED_STORAGE_KEY) === '1';
      } catch {
         dismissed = false;
      }
      if (dismissed) return;

      setNotificationPromptOpen(true);
   }, []);

   React.useEffect(() => {
      if (typeof window === 'undefined' || !('Notification' in window)) return;

      const refreshPermission = () => {
         const permission = window.Notification.permission;
         setNotificationPermission(permission);
         if (permission === 'granted') {
            setNotificationPromptOpen(false);
         }
      };

      window.addEventListener('focus', refreshPermission);
      document.addEventListener('visibilitychange', refreshPermission);

      return () => {
         window.removeEventListener('focus', refreshPermission);
         document.removeEventListener('visibilitychange', refreshPermission);
      };
   }, []);

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
         <Dialog
            open={notificationPromptOpen}
            onOpenChange={(open) => {
               if (!open && notificationPromptDontShowAgain) {
                  persistNotificationPromptDismissed(true);
               }
               if (open) {
                  setNotificationPromptError('');
               }
               setNotificationPromptOpen(open);
            }}
         >
            <DialogContent
               aria-label="فعال‌سازی اعلان دسکتاپ"
               className="max-w-[560px] border-white/10 bg-[#1d1d20] text-zinc-200"
            >
               <DialogHeader className="text-right">
                  <DialogTitle className="text-zinc-100">فعال‌سازی اعلان دسکتاپ</DialogTitle>
                  <DialogDescription className="leading-6 text-zinc-400">
                     برای دیدن اعلان‌های جدید حتی بیرون از تب Taskara، دسترسی اعلان را برای این سایت فعال کن.
                  </DialogDescription>
               </DialogHeader>
               <div className="space-y-3 text-sm">
                  <div className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-zinc-300">
                     وضعیت فعلی:{' '}
                     {notificationPermission === 'unsupported'
                        ? 'پشتیبانی نمی‌شود'
                        : notificationPermission === 'granted'
                           ? 'مجوز داده شده'
                           : notificationPermission === 'denied'
                              ? 'مجوز مسدود است'
                              : 'نیازمند مجوز'}
                  </div>
                  <div className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-3">
                     <div className="font-medium text-zinc-100">راهنمای مرورگر ({browserNotificationHelp.title})</div>
                     <ol className="mt-2 list-decimal space-y-1 pr-5 text-zinc-400">
                        {browserNotificationHelp.steps.map((step) => (
                           <li key={step}>{step}</li>
                        ))}
                     </ol>
                  </div>
                  {notificationPromptError ? (
                     <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">
                        {notificationPromptError}
                     </div>
                  ) : null}
                  <label className="flex cursor-pointer items-center gap-2 text-zinc-300" htmlFor="notification-prompt-dismiss">
                     <input
                        id="notification-prompt-dismiss"
                        checked={notificationPromptDontShowAgain}
                        className="size-4 rounded border border-white/20 bg-transparent accent-zinc-100"
                        type="checkbox"
                        onChange={(event) => setNotificationPromptDontShowAgain(event.target.checked)}
                     />
                     <span>
                        دیگه این پیام رو نمایش نده
                     </span>
                  </label>
                  <div className="flex items-center justify-end gap-2">
                     <Button
                        className="border-white/10 bg-transparent text-zinc-300 hover:bg-white/8 hover:text-zinc-100"
                        variant="outline"
                        onClick={closeNotificationPrompt}
                     >
                        فعلا نه
                     </Button>
                     <Button
                        className="border border-white/10 bg-zinc-100 text-zinc-950 hover:bg-white"
                        onClick={() => void handleEnableNotifications()}
                     >
                        فعال‌سازی اعلان
                     </Button>
                  </div>
               </div>
            </DialogContent>
         </Dialog>
      </SidebarProvider>
   );
}
