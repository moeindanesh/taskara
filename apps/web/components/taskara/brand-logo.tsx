import { cn } from '@/lib/utils';

export const taskaraLogoSrc = '/brand/taskara-logo.png';

export function TaskaraLogo({
   alt = 'Taskara',
   className,
   imageClassName,
}: {
   alt?: string;
   className?: string;
   imageClassName?: string;
}) {
   return (
      <span
         className={cn(
            'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white',
            className
         )}
      >
         <img alt={alt} className={cn('h-full w-full object-cover', imageClassName)} src={taskaraLogoSrc} />
      </span>
   );
}
