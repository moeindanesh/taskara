'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
   const { theme = 'system' } = useTheme();

   return (
      <Sonner
         theme={theme as ToasterProps['theme']}
         className="toaster group font-sans"
         dir="rtl"
         position="bottom-right"
         style={{ fontFamily: 'var(--font-vazirmatn)' }}
         toastOptions={{
            classNames: {
               toast: 'group toast group-[.toaster]:rounded-xl group-[.toaster]:border-white/10 group-[.toaster]:bg-[#1e1e21] group-[.toaster]:font-sans group-[.toaster]:text-foreground group-[.toaster]:shadow-2xl',
               description: 'group-[.toast]:text-muted-foreground',
               actionButton:
                  'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground font-medium',
               cancelButton:
                  'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground font-medium',
            },
         }}
         {...props}
      />
   );
};

export { Toaster };
