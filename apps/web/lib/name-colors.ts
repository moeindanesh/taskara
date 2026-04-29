export type NameColorSet = {
   hue: number;
   accent: string;
   foreground: string;
   background: string;
   backgroundStrong: string;
   border: string;
   groupBackground: string;
};

const fallbackNameKey = 'taskara-user';

function normalizeName(name?: string | null) {
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

export function getUserColorsFromName(name?: string | null): NameColorSet {
   const hue = hashName(normalizeName(name)) % 360;

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
