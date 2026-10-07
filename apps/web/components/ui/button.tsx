import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { Button as HeroButton } from '@heroui/react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
   "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
   {
      variants: {
         variant: {
            default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
            destructive:
               'bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
            outline:
               'border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
            secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
            ghost: 'hover:bg-accent hover:text-accent-foreground',
            link: 'text-primary underline-offset-4 hover:underline',
         },
         size: {
            default: 'h-8 px-3 py-1.5 has-[>svg]:px-2.5',
            xxs: 'h-6 rounded-md gap-1.5 px-2.5 has-[>svg]:px-2',
            xs: 'h-7 rounded-md gap-1.5 px-2.5 has-[>svg]:px-2',
            sm: 'h-7 rounded-md gap-1.5 px-2.5 has-[>svg]:px-2',
            lg: 'h-9 rounded-md px-4 has-[>svg]:px-3',
            icon: 'size-8',
         },
      },
      defaultVariants: {
         variant: 'default',
         size: 'default',
      },
   }
);

function Button({
   className,
   variant,
   size,
   asChild = false,
   disabled,
   value,
   onFocus,
   onBlur,
   onClick,
   ...props
}: React.ComponentProps<'button'> &
   VariantProps<typeof buttonVariants> & {
      asChild?: boolean;
   }) {
   if (asChild) return (
      <Slot
         data-slot="button"
         className={cn(buttonVariants({ variant, size, className }))}
         {...{ disabled, value, onFocus, onBlur, onClick, ...props }}
      />
   );
   return (
      <HeroButton
         data-slot="button"
         isDisabled={disabled}
         value={value == null ? undefined : String(value)}
         onFocus={onFocus as React.ComponentProps<typeof HeroButton>['onFocus']}
         onBlur={onBlur as React.ComponentProps<typeof HeroButton>['onBlur']}
         onClick={onClick as React.ComponentProps<typeof HeroButton>['onClick']}
         isIconOnly={size === 'icon'}
         variant={variant === 'destructive' ? 'danger' : variant === 'secondary' ? 'secondary' : variant === 'ghost' || variant === 'link' ? 'ghost' : variant === 'outline' ? 'tertiary' : 'primary'}
         className={cn('support-ui', buttonVariants({ variant, size, className }))}
         {...props}
         type={props.type ?? 'submit'}
      />
   );
}

export { Button, buttonVariants };
