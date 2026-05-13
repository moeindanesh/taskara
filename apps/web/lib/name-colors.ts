export type NameColorSet = {
   hue: number;
   accent: string;
   foreground: string;
   background: string;
   backgroundStrong: string;
   border: string;
   groupBackground: string;
};

const userFallbackNameKey = 'taskara-user';
const projectFallbackNameKey = 'taskara-project';

function normalizeName(name?: string | null, fallbackNameKey = userFallbackNameKey) {
   return (name || fallbackNameKey).trim().normalize('NFKC').toLowerCase() || fallbackNameKey;
}

function hashName(name: string) {
   let hash = 2166136261;

   for (const character of name) {
      hash ^= character.codePointAt(0) || 0;
      hash = Math.imul(hash, 16777619);
   }

   return hash >>> 0;
}

function getColorsFromName(name?: string | null, fallbackNameKey = userFallbackNameKey): NameColorSet {
   const hue = hashName(normalizeName(name, fallbackNameKey)) % 360;

   return {
      hue,
      accent: `color-mix(in srgb, hsl(${hue} 84% 48%), var(--foreground) 18%)`,
      foreground: `color-mix(in srgb, hsl(${hue} 86% 36%), var(--foreground) 48%)`,
      background: `color-mix(in srgb, hsl(${hue} 76% 54%), var(--container) 86%)`,
      backgroundStrong: `color-mix(in srgb, hsl(${hue} 76% 50%), var(--container) 78%)`,
      border: `color-mix(in srgb, hsl(${hue} 80% 44%), var(--border) 58%)`,
      groupBackground: `color-mix(in srgb, hsl(${hue} 76% 52%), var(--container) 90%)`,
   };
}

export function getUserColorsFromName(name?: string | null): NameColorSet {
   return getColorsFromName(name, userFallbackNameKey);
}

export function getProjectColorsFromName(name?: string | null): NameColorSet {
   return getColorsFromName(name, projectFallbackNameKey);
}
