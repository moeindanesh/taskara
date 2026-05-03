export type AppearanceFontFamily = 'iranyekan' | 'peyda' | 'system' | 'mono';

export interface AppearanceSettings {
   fontFamily: AppearanceFontFamily;
   bodyFontScale: number;
   titleFontScale: number;
}

export const APPEARANCE_STORAGE_KEY = 'taskara:appearance:font:v1';

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
   fontFamily: 'iranyekan',
   bodyFontScale: 1,
   titleFontScale: 1,
};

export function loadAppearanceSettings(): AppearanceSettings {
   if (typeof window === 'undefined') return DEFAULT_APPEARANCE_SETTINGS;

   const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
   if (!raw) return DEFAULT_APPEARANCE_SETTINGS;

   try {
      return mergeAppearanceSettings(JSON.parse(raw) as Partial<AppearanceSettings>);
   } catch {
      return DEFAULT_APPEARANCE_SETTINGS;
   }
}

export function saveAppearanceSettings(settings: AppearanceSettings) {
   if (typeof window === 'undefined') return;
   window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(settings));
}

export function mergeAppearanceSettings(input?: Partial<AppearanceSettings>): AppearanceSettings {
   return {
      fontFamily: isFontFamily(input?.fontFamily) ? input.fontFamily : DEFAULT_APPEARANCE_SETTINGS.fontFamily,
      bodyFontScale: clamp(input?.bodyFontScale, 0.85, 1.3, DEFAULT_APPEARANCE_SETTINGS.bodyFontScale),
      titleFontScale: clamp(input?.titleFontScale, 0.85, 1.45, DEFAULT_APPEARANCE_SETTINGS.titleFontScale),
   };
}

export function applyAppearanceSettingsToDocument(settings: AppearanceSettings) {
   if (typeof document === 'undefined') return;
   const root = document.documentElement;

   root.style.setProperty('--app-font-family', getFontFamilyValue(settings.fontFamily));
   root.style.setProperty('--app-font-scale-body', String(settings.bodyFontScale));
   root.style.setProperty('--app-font-scale-title', String(settings.titleFontScale));
}

function getFontFamilyValue(fontFamily: AppearanceFontFamily): string {
   if (fontFamily === 'peyda') {
      return '"PeydaWebFaNum", "IRANYekanXFaNum", "Vazirmatn", sans-serif';
   }
   if (fontFamily === 'system') {
      return '-apple-system, BlinkMacSystemFont, "Segoe UI", Tahoma, Arial, sans-serif';
   }
   if (fontFamily === 'mono') {
      return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
   }
   return '"IRANYekanXFaNum", "Vazirmatn", sans-serif';
}

function clamp(value: number | undefined, min: number, max: number, fallback: number) {
   if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
   return Math.min(max, Math.max(min, value));
}

function isFontFamily(value: unknown): value is AppearanceFontFamily {
   return value === 'iranyekan' || value === 'peyda' || value === 'system' || value === 'mono';
}
