'use client';

import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function IssueTitleTooltip({
   children,
   className,
   side = 'top',
   title,
}: {
   children: ReactElement;
   className?: string;
   side?: 'top' | 'right' | 'bottom' | 'left';
   title: string;
}) {
   const normalizedTitle = title.trim();
   if (!normalizedTitle) return children;

   return (
      <Tooltip delayDuration={250}>
         <TooltipTrigger asChild>{children}</TooltipTrigger>
         <TooltipContent
            side={side}
            className={cn(
               'max-w-[min(520px,calc(100vw-32px))] whitespace-normal break-words border-white/10 bg-[#202023] px-3 py-2 text-start text-xs leading-5 text-zinc-200 shadow-2xl [direction:rtl] [unicode-bidi:plaintext]',
               className
            )}
         >
            <span className="block max-w-full whitespace-normal break-words" dir="auto">
               {normalizedTitle}
            </span>
         </TooltipContent>
      </Tooltip>
   );
}
