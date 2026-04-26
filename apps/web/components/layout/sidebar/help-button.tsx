'use client';

import * as React from 'react';
import { ExternalLink, HelpCircle, Keyboard, Search } from 'lucide-react';

import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from 'react-router-dom';
import { RiBox3Fill, RiLinkedinFill, RiThreadsFill, RiTwitterXFill } from '@remixicon/react';

const followLinks = [
   { label: 'X - Twitter', url: import.meta.env.VITE_TASKARA_HELP_X_URL, icon: RiTwitterXFill },
   { label: 'Threads', url: import.meta.env.VITE_TASKARA_HELP_THREADS_URL, icon: RiThreadsFill },
   { label: 'LinkedIn', url: import.meta.env.VITE_TASKARA_HELP_LINKEDIN_URL, icon: RiLinkedinFill },
].filter((item): item is { label: string; url: string; icon: typeof RiTwitterXFill } => Boolean(item.url));

const projectLinks = [
   { label: 'Support project', url: import.meta.env.VITE_TASKARA_SUPPORT_URL, icon: RiBox3Fill, external: true },
   { label: 'Product updates', url: import.meta.env.VITE_TASKARA_PRODUCT_URL, external: false },
   { label: 'Portfolio', url: import.meta.env.VITE_TASKARA_PORTFOLIO_URL, external: false },
   { label: 'Repository', url: import.meta.env.VITE_TASKARA_REPOSITORY_URL, external: true },
].filter((item): item is { label: string; url: string; icon?: typeof RiBox3Fill; external: boolean } => Boolean(item.url));

export function HelpButton() {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button size="icon" variant="outline">
               <HelpCircle className="size-4" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="w-60">
            <div className="p-2">
               <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input type="search" placeholder="Search for help..." className="pl-8" />
               </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Shortcuts</DropdownMenuLabel>
            <DropdownMenuItem>
               <Keyboard className="mr-2 h-4 w-4" />
               <span>Keyboard shortcuts</span>
               <span className="ml-auto text-xs text-muted-foreground">⌘/</span>
            </DropdownMenuItem>
            {followLinks.length ? (
               <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Follow</DropdownMenuLabel>
                  {followLinks.map((item) => {
                     const Icon = item.icon;
                     return (
                        <DropdownMenuItem key={item.label} asChild>
                           <Link to={item.url} target="_blank">
                              <Icon className="mr-2 h-4 w-4" />
                              <span>{item.label}</span>
                              <ExternalLink className="ml-auto h-3 w-3 text-muted-foreground" />
                           </Link>
                        </DropdownMenuItem>
                     );
                  })}
               </>
            ) : null}
            {projectLinks.length ? (
               <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Links</DropdownMenuLabel>
                  {projectLinks.map((item) => {
                     const Icon = item.icon;
                     return (
                        <DropdownMenuItem key={item.label} asChild>
                           <Link to={item.url} target="_blank" className="flex items-center">
                              {Icon ? (
                                 <Icon className="mr-2 h-4 w-4" />
                              ) : (
                                 <div className="mr-2 flex h-4 w-4 items-center justify-center">
                                    <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                                 </div>
                              )}
                              <span>{item.label}</span>
                              {item.external ? <ExternalLink className="ml-auto h-3 w-3 text-muted-foreground" /> : null}
                           </Link>
                        </DropdownMenuItem>
                     );
                  })}
               </>
            ) : null}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
