'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';
import { Bell, Filter, PanelLeft, SlidersHorizontal, Trophy } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

interface PageHeaderProps {
   title: string;
   description?: string;
   count?: number;
   action?: React.ReactNode;
   compact?: boolean;
}

export function PageHeader({ title, description, count, action, compact = false }: PageHeaderProps) {
   const navigate = useNavigate();
   const location = useLocation();
   const [openMenu, setOpenMenu] = useState<'display' | 'filters' | null>(null);
   const pathParts = location.pathname.split('/').filter(Boolean);
   const orgId = pathParts[0] || 'taskara';
   const isLeaderboardRoute = pathParts[1] === 'leaderboard';

   useEffect(() => {
      const handleMenuState = (event: Event) => {
         const detail = (event as CustomEvent<{ displayOpen?: boolean; filterOpen?: boolean }>).detail || {};
         setOpenMenu(detail.filterOpen ? 'filters' : detail.displayOpen ? 'display' : null);
      };

      window.addEventListener('taskara:menu-state', handleMenuState);
      return () => window.removeEventListener('taskara:menu-state', handleMenuState);
   }, []);

   const getAnchor = (event: MouseEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return {
         bottom: rect.bottom,
         height: rect.height,
         left: rect.left,
         right: rect.right,
         top: rect.top,
         width: rect.width,
      };
   };

   const openFilters = (event: MouseEvent<HTMLButtonElement>) => {
      setOpenMenu('filters');
      window.dispatchEvent(new CustomEvent('taskara:open-filters', { detail: { anchor: getAnchor(event) } }));
   };

   const openDisplay = (event: MouseEvent<HTMLButtonElement>) => {
      setOpenMenu('display');
      window.dispatchEvent(new CustomEvent('taskara:open-display', { detail: { anchor: getAnchor(event) } }));
   };

   return (
      <div
         className={cn(
            'w-full border-b border-white/6 bg-[#101011] px-4',
            compact ? 'py-2.5' : 'py-3'
         )}
      >
         <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
               <Tooltip>
                  <TooltipTrigger asChild>
                     <SidebarTrigger className="text-zinc-500 hover:text-zinc-100" />
                  </TooltipTrigger>
                  <TooltipContent>منوی کناری</TooltipContent>
               </Tooltip>
               <div className="flex items-center gap-2">
                  <h1 className="text-sm font-semibold text-zinc-200 lg:text-base">{title}</h1>
                  {typeof count === 'number' ? (
                     <Badge variant="secondary" className="bg-white/6 text-zinc-400">
                        {count.toLocaleString('fa-IR')}
                     </Badge>
                  ) : null}
               </div>
            </div>
            <div className="flex items-center gap-1.5">
               {action}
               <Tooltip>
                  <TooltipTrigger asChild>
                     <Button
                        aria-label={fa.issue.filters}
                        size="icon"
                        variant="ghost"
                        className={cn(
                           'size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100',
                           openMenu === 'filters' && 'bg-white/[0.08] text-zinc-100'
                        )}
                        onClick={openFilters}
                     >
                        <Filter className="size-4" />
                     </Button>
                  </TooltipTrigger>
                  <TooltipContent>{fa.issue.filters}</TooltipContent>
               </Tooltip>
               <Tooltip>
                  <TooltipTrigger asChild>
                     <Button
                        aria-label={fa.issue.display}
                        size="icon"
                        variant="ghost"
                        className={cn(
                           'size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100',
                           openMenu === 'display' && 'bg-white/[0.08] text-zinc-100'
                        )}
                        onClick={openDisplay}
                     >
                        <SlidersHorizontal className="size-4" />
                     </Button>
                  </TooltipTrigger>
                  <TooltipContent>{fa.issue.display}</TooltipContent>
               </Tooltip>
               <Tooltip>
                  <TooltipTrigger asChild>
                     <Button
                        aria-label={fa.nav.leaderboard}
                        size="icon"
                        variant="ghost"
                        className={cn(
                           'size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100',
                           isLeaderboardRoute && 'bg-white/[0.08] text-zinc-100'
                        )}
                        onClick={() => navigate(`/${orgId}/leaderboard`)}
                     >
                        <Trophy className="size-4" />
                     </Button>
                  </TooltipTrigger>
                  <TooltipContent>{fa.nav.leaderboard}</TooltipContent>
               </Tooltip>
               <div className="ms-auto flex items-center gap-1.5">
                  <Tooltip>
                     <TooltipTrigger asChild>
                        <Button
                           aria-label={fa.shortcuts.title}
                           size="icon"
                           variant="ghost"
                           className="size-8 rounded-full text-zinc-500 hover:text-zinc-100"
                           onClick={() => window.dispatchEvent(new CustomEvent('taskara:keyboard-shortcuts'))}
                        >
                           <PanelLeft className="size-4" />
                        </Button>
                     </TooltipTrigger>
                     <TooltipContent>{fa.shortcuts.title}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                     <TooltipTrigger asChild>
                        <Button
                           aria-label={fa.nav.inbox}
                           size="icon"
                           variant="ghost"
                           className="size-8 rounded-full text-zinc-500 hover:text-zinc-100"
                           onClick={() => navigate(`/${orgId}/inbox`)}
                        >
                           <Bell className="size-4" />
                        </Button>
                     </TooltipTrigger>
                     <TooltipContent>{fa.nav.inbox}</TooltipContent>
                  </Tooltip>
               </div>
            </div>
         </div>
         {description ? <p className={cn('text-sm text-muted-foreground', compact ? 'sr-only' : 'mt-2')}>{description}</p> : null}
      </div>
   );
}
