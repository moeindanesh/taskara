import * as React from 'react';
import { TextArea as HeroTextArea } from '@heroui/react';

import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
   return (
      <HeroTextArea
         data-slot="textarea"
         className={cn(
            'support-ui border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content min-h-20 w-full rounded-lg border bg-background px-3 py-2 text-sm shadow-none transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
            className
         )}
         {...props}
      />
   );
}

export { Textarea };
