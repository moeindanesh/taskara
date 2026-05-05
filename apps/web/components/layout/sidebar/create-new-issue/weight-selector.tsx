'use client';

import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Box, CheckIcon, XCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { taskWeights } from '@/lib/taskara-presenters';

interface WeightSelectorProps {
   weight?: number | null;
   onChange: (weight: number | null) => void;
}

export function WeightSelector({ weight, onChange }: WeightSelectorProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const [value, setValue] = useState<string>(weight === null || weight === undefined ? '' : String(weight));

   useEffect(() => {
      setValue(weight === null || weight === undefined ? '' : String(weight));
   }, [weight]);

   const handleWeightChange = (weightValue: string) => {
      setValue(weightValue);
      setOpen(false);
      onChange(weightValue === '' ? null : Number(weightValue));
   };

   return (
      <div className="*:not-first:mt-2">
         <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
               <Button
                  id={id}
                  className="flex items-center justify-center"
                  size="xs"
                  variant="secondary"
                  role="combobox"
                  aria-expanded={open}
               >
                  <Box className="text-muted-foreground size-4" />
                  <span>{value ? `Weight ${Number(value).toLocaleString('fa-IR')}` : 'No weight'}</span>
               </Button>
            </PopoverTrigger>
            <PopoverContent
               className="border-input w-full min-w-[var(--radix-popper-anchor-width)] p-0"
               align="start"
            >
               <Command>
                  <CommandInput placeholder="Set weight..." />
                  <CommandList>
                     <CommandEmpty>No weight found.</CommandEmpty>
                     <CommandGroup>
                        <CommandItem
                           value="none"
                           onSelect={() => handleWeightChange('')}
                           className="flex items-center justify-between"
                        >
                           <div className="flex items-center gap-2">
                              <XCircle className="text-muted-foreground size-4" />
                              No weight
                           </div>
                           {value === '' ? <CheckIcon size={16} className="ml-auto" /> : null}
                        </CommandItem>
                        {taskWeights.map((item) => (
                           <CommandItem
                              key={item}
                              value={`weight-${item}`}
                              onSelect={() => handleWeightChange(String(item))}
                              className="flex items-center justify-between"
                           >
                              <div className="flex items-center gap-2">
                                 <Box className="text-muted-foreground size-4" />
                                 {item.toLocaleString('fa-IR')}
                              </div>
                              {value === String(item) ? (
                                 <CheckIcon size={16} className="ml-auto" />
                              ) : null}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  </CommandList>
               </Command>
            </PopoverContent>
         </Popover>
      </div>
   );
}
