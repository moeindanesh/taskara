'use client';

import { Check, ChevronsUpDown, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
   CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import type { TaskaraUser } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

export function UserMultiSelectCombobox({
   ariaLabel,
   emptyLabel = 'کاربری پیدا نشد.',
   onChange,
   placeholder,
   selectedIds,
   users,
}: {
   ariaLabel: string;
   emptyLabel?: string;
   onChange: (selectedIds: string[]) => void;
   placeholder: string;
   selectedIds: string[];
   users: TaskaraUser[];
}) {
   const selectedSet = new Set(selectedIds);
   const selectedUsers = users.filter((user) => selectedSet.has(user.id));

   function toggleUser(userId: string) {
      onChange(selectedSet.has(userId) ? selectedIds.filter((id) => id !== userId) : [...selectedIds, userId]);
   }

   return (
      <Popover>
         <PopoverTrigger asChild>
            <Button
               aria-label={ariaLabel}
               className={cn(
                  'h-auto min-h-9 w-full justify-between gap-2 rounded-md border border-white/8 bg-white/[0.03] px-3 py-2 text-start text-sm font-normal hover:bg-white/[0.06]',
                  selectedUsers.length ? 'text-zinc-200' : 'text-zinc-500'
               )}
               type="button"
               variant="ghost"
            >
               <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  {selectedUsers.length ? (
                     selectedUsers.slice(0, 4).map((user) => (
                        <span
                           key={user.id}
                           className="inline-flex max-w-[150px] items-center gap-1.5 rounded-full bg-white/[0.07] px-2 py-0.5 text-xs text-zinc-200"
                        >
                           <LinearAvatar name={user.name} src={user.avatarUrl} className="size-4" />
                           <span className="truncate">{user.name}</span>
                        </span>
                     ))
                  ) : (
                     <span className="inline-flex items-center gap-1.5">
                        <Users className="size-4 text-zinc-500" />
                        {placeholder}
                     </span>
                  )}
                  {selectedUsers.length > 4 ? (
                     <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-xs text-zinc-400">
                        +{(selectedUsers.length - 4).toLocaleString('fa-IR')}
                     </span>
                  ) : null}
               </span>
               <ChevronsUpDown className="size-4 shrink-0 text-zinc-500" />
            </Button>
         </PopoverTrigger>
         <PopoverContent
            align="start"
            className="w-[min(420px,calc(100vw-32px))] rounded-xl border-white/10 bg-[#202023] p-0 text-zinc-100 shadow-2xl"
            sideOffset={8}
         >
            <Command className="bg-transparent">
               <CommandInput
                  className="text-zinc-200 placeholder:text-zinc-600"
                  placeholder={placeholder}
               />
               <CommandList>
                  <CommandEmpty className="py-5 text-center text-sm text-zinc-500">{emptyLabel}</CommandEmpty>
                  <CommandGroup>
                     <CommandItem
                        className="cursor-pointer rounded-lg px-2.5 py-2 text-sm text-zinc-300 data-[selected=true]:bg-white/[0.07]"
                        onSelect={() => onChange(users.map((user) => user.id))}
                     >
                        <Users className="size-4 text-zinc-500" />
                        انتخاب همه
                     </CommandItem>
                     <CommandItem
                        className="cursor-pointer rounded-lg px-2.5 py-2 text-sm text-zinc-300 data-[selected=true]:bg-white/[0.07]"
                        onSelect={() => onChange([])}
                     >
                        <X className="size-4 text-zinc-500" />
                        حذف انتخاب‌ها
                     </CommandItem>
                  </CommandGroup>
                  <CommandSeparator className="bg-white/8" />
                  <CommandGroup>
                     {users.map((user) => {
                        const selected = selectedSet.has(user.id);
                        return (
                           <CommandItem
                              key={user.id}
                              className="cursor-pointer rounded-lg px-2.5 py-2 text-sm text-zinc-300 data-[selected=true]:bg-white/[0.07]"
                              value={`${user.name} ${user.email}`}
                              onSelect={() => toggleUser(user.id)}
                           >
                              <Check className={cn('size-4', selected ? 'text-indigo-300 opacity-100' : 'opacity-0')} />
                              <LinearAvatar name={user.name} src={user.avatarUrl} className="size-6" />
                              <span className="min-w-0 flex-1 truncate">{user.name}</span>
                              <span className="hidden shrink-0 text-xs text-zinc-600 sm:inline">{user.email}</span>
                           </CommandItem>
                        );
                     })}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
