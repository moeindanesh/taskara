'use client';

import * as React from 'react';
import { ThemeProvider as NextThemesProvider, useTheme, type ThemeProviderProps } from 'next-themes';

const THEME_SURFACES = {
   light: '#ffffff',
   dark: '#0d1117',
} as const;

const CODE_THEMES = {
   light: 'codex',
   dark: 'github',
} as const;

function ThemeDocumentSync() {
   const { resolvedTheme } = useTheme();

   React.useEffect(() => {
      if (resolvedTheme !== 'dark' && resolvedTheme !== 'light') return;
      const variant = resolvedTheme === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.codeTheme = CODE_THEMES[variant];
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
         meta.content = THEME_SURFACES[variant];
      }
   }, [resolvedTheme]);

   return null;
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
   return (
      <NextThemesProvider {...props} enableSystem enableColorScheme disableTransitionOnChange>
         <ThemeDocumentSync />
         {children}
      </NextThemesProvider>
   );
}
