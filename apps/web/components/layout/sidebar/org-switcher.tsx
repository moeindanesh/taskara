'use client';

import * as React from 'react';
import { ChevronsUpDown, Settings } from 'lucide-react';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuGroup,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuPortal,
   DropdownMenuSeparator,
   DropdownMenuShortcut,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { ThemeToggle } from '../theme-toggle';
import { Link, useLocation } from 'react-router-dom';
import { TaskaraLogo } from '@/components/taskara/brand-logo';

export function OrgSwitcher() {
   const location = useLocation();
   const pathname = location.pathname;
   const orgId = pathname.split('/').filter(Boolean)[0] || 'taskara';

   return (
      <SidebarMenu>
         <SidebarMenuItem>
            <DropdownMenu>
               <div className="w-full flex gap-1 items-center pt-2">
                  <DropdownMenuTrigger asChild>
                     <SidebarMenuButton
                        size="lg"
                        className="h-8 p-1 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                     >
                        <TaskaraLogo className="size-6 rounded-md border border-white/10" />
                        <div className="grid flex-1 text-right text-sm leading-tight">
                           <span className="truncate font-semibold">Taskara</span>
                           <span className="truncate text-[11px] text-muted-foreground">
                              {orgId}
                           </span>
                        </div>
                        <ChevronsUpDown className="ms-auto" />
                     </SidebarMenuButton>
                  </DropdownMenuTrigger>

                  <ThemeToggle />
               </div>
               <DropdownMenuContent
                  className="w-[--radix-dropdown-menu-trigger-width] min-w-60 rounded-lg"
                  side="bottom"
                  align="end"
                  sideOffset={4}
               >
                  <DropdownMenuGroup>
                     <DropdownMenuItem asChild>
                        <Link to={`/${orgId}/settings/profile`}>
                           <Settings className="size-4" />
                           <span>تنظیمات Workspace</span>
                        </Link>
                     </DropdownMenuItem>
                     <DropdownMenuItem asChild>
                        <Link to={`/${orgId}/members`}>
                           <span>مدیریت اعضا</span>
                        </Link>
                     </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                     <DropdownMenuItem>تاریخ‌ها با تقویم جلالی نمایش داده می‌شوند.</DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                     <DropdownMenuSubTrigger>Workspace فعال</DropdownMenuSubTrigger>
                     <DropdownMenuPortal>
                        <DropdownMenuSubContent>
                           <DropdownMenuLabel>{orgId}</DropdownMenuLabel>
                           <DropdownMenuSeparator />
                           <DropdownMenuItem>
                              <TaskaraLogo className="size-6 rounded-md border border-white/10" />
                              Taskara
                           </DropdownMenuItem>
                        </DropdownMenuSubContent>
                     </DropdownMenuPortal>
                  </DropdownMenuSub>
               </DropdownMenuContent>
            </DropdownMenu>
         </SidebarMenuItem>
      </SidebarMenu>
   );
}
