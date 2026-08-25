import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, Plus } from 'lucide-react';
import { SupportSidebar } from '@/components/layout/sidebar/support-sidebar';
import { SupportCaseCreateDialog } from '@/components/taskara/support-case-create-dialog';
import { workspaceNavigationIcons } from '@/components/layout/workspace-navigation-icon';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { SidebarProvider } from '@/components/ui/sidebar';
import { fa } from '@/lib/fa-copy';
import {
   workspaceCommandEntries,
   workspaceCommandIsDefault,
   workspaceCreateAction,
} from '@/lib/workspace-navigation';
import { useWorkspaceNavigationRuntime, useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import type { SupportCase } from '@/lib/support-types';
import { cn } from '@/lib/utils';

export function SupportMainLayout({
   children,
   header,
   showSidebar = true,
}: {
   children: ReactNode;
   header?: ReactNode;
   showSidebar?: boolean;
}) {
   const navigate = useNavigate();
   const location = useLocation();
   const runtime = useWorkspaceRuntime();
   const support = useSupportWorkspace();
   const navigationRuntime = useWorkspaceNavigationRuntime();
   const [commandOpen, setCommandOpen] = useState(false);
   const [createOpen, setCreateOpen] = useState(false);
   const [searchQuery, setSearchQuery] = useState('');
   const [searchResults, setSearchResults] = useState<SupportCase[]>([]);
   const [searching, setSearching] = useState(false);
   const createReturnFocusRef = useRef<HTMLElement | null>(null);
   const commands = useMemo(() => workspaceCommandEntries(navigationRuntime), [navigationRuntime]);
   const createAction = workspaceCreateAction(navigationRuntime);
   const routeKey = location.pathname.split('/').filter(Boolean)[1] || 'support';
   const pageOwnsScroll = ['inbox', 'settings', 'support', 'wiki'].includes(routeKey);

   const openCreate = useCallback(() => {
      if (!createAction) return;
      createReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setCreateOpen(true);
   }, [createAction]);

   const changeCreateOpen = useCallback((next: boolean) => {
      setCreateOpen(next);
      if (!next) {
         window.requestAnimationFrame(() => createReturnFocusRef.current?.focus());
      }
   }, []);

   const canSearchCases = [
      'support.triage.read',
      'support.department-inbox.read',
      'support.cases.mine.read',
      'support.recovery.read',
   ].some((permission) => runtime.permissions.has(permission));

   useEffect(() => {
      const query = searchQuery.trim();
      if (!commandOpen || !canSearchCases || query.length < 2) {
         setSearchResults([]);
         setSearching(false);
         return;
      }
      let cancelled = false;
      const timer = window.setTimeout(() => {
         setSearching(true);
         void support.search(query, 12)
            .then((result) => {
               if (!cancelled) setSearchResults(result.cases);
            })
            .catch(() => {
               if (!cancelled) setSearchResults([]);
            })
            .finally(() => {
               if (!cancelled) setSearching(false);
            });
      }, 250);
      return () => {
         cancelled = true;
         window.clearTimeout(timer);
      };
   }, [canSearchCases, commandOpen, searchQuery, support.search]);

   useEffect(() => {
      const keydown = (event: KeyboardEvent) => {
         const target = event.target;
         const editable = target instanceof HTMLElement && (
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable
         );
         if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            setCommandOpen(true);
         } else if (!editable && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && ['c', 'ز'].includes(event.key.toLocaleLowerCase('fa'))) {
            event.preventDefault();
            openCreate();
         }
      };
      const openCommands = () => setCommandOpen(true);
      window.addEventListener('keydown', keydown);
      window.addEventListener('taskara:command-menu', openCommands);
      window.addEventListener('taskara:create-support-case', openCreate);
      return () => {
         window.removeEventListener('keydown', keydown);
         window.removeEventListener('taskara:command-menu', openCommands);
         window.removeEventListener('taskara:create-support-case', openCreate);
      };
   }, [openCreate]);

   return (
      <SidebarProvider>
         {showSidebar ? <SupportSidebar /> : null}
         <div className="h-dvh w-full overflow-hidden bg-[#050506] lg:p-2">
            <div className="flex h-full w-full flex-col items-center justify-start overflow-hidden bg-container lg:rounded-xl lg:border lg:border-white/8">
               {header}
               <div className={cn('min-h-0 w-full', pageOwnsScroll ? 'overflow-hidden' : 'overflow-auto', header ? 'h-[calc(100dvh-40px)] lg:h-[calc(100dvh-48px)]' : 'h-full')}>
                  {children}
               </div>
            </div>
         </div>
         <CommandDialog description={fa.command.description} open={commandOpen} title={fa.command.title} onOpenChange={(next) => { setCommandOpen(next); if (!next) setSearchQuery(''); }}>
            <CommandInput placeholder="جستجوی پرونده یا دستور…" value={searchQuery} onValueChange={setSearchQuery} />
            <CommandList className="max-h-[520px] p-1.5" data-testid="support-command-menu">
               <CommandEmpty className="py-5 text-center text-xs text-zinc-500">
                  {searching ? <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> در حال جستجو…</span> : searchQuery.trim().length >= 2 && canSearchCases ? 'پرونده‌ای در محدوده دسترسی شما پیدا نشد.' : 'دستوری پیدا نشد.'}
               </CommandEmpty>
               {searchQuery.trim().length >= 2 && canSearchCases ? (
                  <CommandGroup heading="پرونده‌های در دسترس">
                     {searchResults.map((item) => (
                        <CommandItem
                           key={item.id}
                           value={`case-${item.key}-${item.title}`}
                           keywords={[item.key, item.title, item.contact?.name || '', item.contact?.phone || '']}
                           onSelect={() => {
                              setCommandOpen(false);
                              setSearchQuery('');
                              navigate(`/${runtime.workspaceSlug}/support/cases/${encodeURIComponent(item.key)}`);
                           }}
                        >
                           <bdi dir="ltr" className="font-mono text-xs text-zinc-500">{item.key}</bdi>
                           <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               ) : null}
               <CommandGroup heading="دستورها">
                  {createAction ? (
                     <CommandItem value="create-support-case" onSelect={() => { setCommandOpen(false); openCreate(); }}>
                        <Plus className="size-4" />
                        <span className="min-w-0 flex-1">{createAction.label}</span>
                        <CommandShortcut>C / ز</CommandShortcut>
                     </CommandItem>
                  ) : null}
                  {commands.map((entry) => {
                     const Icon = workspaceNavigationIcons[entry.icon];
                     return (
                        <CommandItem
                           key={entry.id}
                           value={`support-route-${entry.id}`}
                           keywords={[entry.label, entry.description]}
                           className={workspaceCommandIsDefault(entry.route, navigationRuntime) ? '' : 'text-zinc-400'}
                           onSelect={() => {
                              setCommandOpen(false);
                              navigate(entry.route.path(runtime.workspaceSlug, navigationRuntime));
                           }}
                        >
                           <Icon className="size-4" />
                           <span className="min-w-0 flex-1">{entry.label}</span>
                        </CommandItem>
                     );
                  })}
               </CommandGroup>
            </CommandList>
         </CommandDialog>
         <SupportCaseCreateDialog
            open={createOpen}
            onOpenChange={changeCreateOpen}
            onCreated={(item) => navigate(`/${runtime.workspaceSlug}/support/cases/${encodeURIComponent(item.key)}`)}
         />
      </SidebarProvider>
   );
}
