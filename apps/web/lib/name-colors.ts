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
      accent: `hsl(${hue} 84% 74%)`,
      foreground: `hsl(${hue} 92% 88%)`,
      background: `hsl(${hue} 78% 64% / 0.16)`,
      backgroundStrong: `hsl(${hue} 78% 64% / 0.26)`,
      border: `hsl(${hue} 86% 78% / 0.32)`,
      groupBackground: `hsl(${hue} 78% 58% / 0.12)`,
   };
}

export function getUserColorsFromName(name?: string | null): NameColorSet {
   return getColorsFromName(name, userFallbackNameKey);
}

export function getProjectColorsFromName(name?: string | null): NameColorSet {
   return getColorsFromName(name, projectFallbackNameKey);
}
