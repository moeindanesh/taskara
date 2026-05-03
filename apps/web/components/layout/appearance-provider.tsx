'use client';

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import {
   applyAppearanceSettingsToDocument,
   DEFAULT_APPEARANCE_SETTINGS,
   loadAppearanceSettings,
   mergeAppearanceSettings,
   saveAppearanceSettings,
   type AppearanceSettings,
} from '@/lib/appearance';

interface AppearanceContextValue {
   settings: AppearanceSettings;
   setSettings: (next: Partial<AppearanceSettings>) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
   const [settings, setSettingsState] = useState<AppearanceSettings>(() =>
      typeof window === 'undefined' ? DEFAULT_APPEARANCE_SETTINGS : loadAppearanceSettings()
   );

   useEffect(() => {
      const loaded = loadAppearanceSettings();
      setSettingsState(loaded);
      applyAppearanceSettingsToDocument(loaded);
   }, []);

   useEffect(() => {
      applyAppearanceSettingsToDocument(settings);
   }, [settings]);

   const value = useMemo<AppearanceContextValue>(
      () => ({
         settings,
         setSettings: (next) => {
            setSettingsState((current) => {
               const merged = mergeAppearanceSettings({ ...current, ...next });
               saveAppearanceSettings(merged);
               return merged;
            });
         },
      }),
      [settings]
   );

   return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
   const context = useContext(AppearanceContext);
   if (!context) throw new Error('useAppearance must be used within AppearanceProvider');
   return context;
}
