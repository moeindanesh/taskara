'use client';

// Who the reader has taken off their own graph.
//
// Hiding is a view preference, not a workspace setting: it lives in this browser, so nobody
// disappears from anyone else's map. It is kept per workspace, because the people you want out of
// the way in one are not the people you want out of the way in another.

import { useCallback, useEffect, useState } from 'react';
import { suppressTaskArrivalSound } from '@/lib/ui-sound';

const storageKey = 'taskara.team-overview.hidden-people.v1';

export type HiddenPeopleByWorkspace = Record<string, string[]>;

/**
 * Reads the stored map defensively: a corrupt, foreign or half-written value means "nobody is
 * hidden", never a graph that refuses to render.
 */
export function parseHiddenPeople(raw: string | null): HiddenPeopleByWorkspace {
   if (!raw) return {};

   let parsed: unknown;
   try {
      parsed = JSON.parse(raw);
   } catch {
      return {};
   }
   if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

   const result: HiddenPeopleByWorkspace = {};
   for (const [workspaceKey, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const userIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (userIds.length) result[workspaceKey] = userIds;
   }
   return result;
}

/** Whatever the caller hid last, with the workspace's entry dropped entirely once it empties. */
export function withHiddenPeople(
   stored: HiddenPeopleByWorkspace,
   workspaceKey: string,
   hidden: ReadonlySet<string>
): HiddenPeopleByWorkspace {
   const next = { ...stored };
   if (hidden.size) next[workspaceKey] = [...hidden];
   else delete next[workspaceKey];
   return next;
}

export function readHiddenPeople(workspaceKey: string): Set<string> {
   if (typeof window === 'undefined') return new Set();
   try {
      return new Set(parseHiddenPeople(window.localStorage.getItem(storageKey))[workspaceKey] ?? []);
   } catch {
      return new Set();
   }
}

export function writeHiddenPeople(workspaceKey: string, hidden: ReadonlySet<string>): void {
   if (typeof window === 'undefined') return;
   try {
      const stored = parseHiddenPeople(window.localStorage.getItem(storageKey));
      window.localStorage.setItem(storageKey, JSON.stringify(withHiddenPeople(stored, workspaceKey, hidden)));
   } catch {
      // A browser that refuses storage still honours the choice for this session.
   }
}

export interface HiddenPeopleControls {
   hidden: Set<string>;
   hidePerson: (userId: string) => void;
   showPerson: (userId: string) => void;
   showAllPeople: () => void;
}

/**
 * Bringing someone back re-adds their whole cluster at once, which the arrival machinery would
 * otherwise read as a burst of new work and chime for. The nodes still pop — that is how you see
 * where they landed — but the sound is suppressed: nothing actually arrived.
 */
export function useHiddenPeople(workspaceKey: string): HiddenPeopleControls {
   const [hidden, setHidden] = useState<Set<string>>(() => readHiddenPeople(workspaceKey));

   // The workspace key arrives empty for the first render or two while the session loads, so the
   // set is re-read rather than assumed once it resolves.
   useEffect(() => setHidden(readHiddenPeople(workspaceKey)), [workspaceKey]);

   const apply = useCallback(
      (next: Set<string>) => {
         writeHiddenPeople(workspaceKey, next);
         setHidden(next);
      },
      [workspaceKey]
   );

   const hidePerson = useCallback(
      (userId: string) => {
         if (hidden.has(userId)) return;
         apply(new Set(hidden).add(userId));
      },
      [apply, hidden]
   );

   const showPerson = useCallback(
      (userId: string) => {
         if (!hidden.has(userId)) return;
         suppressTaskArrivalSound();
         const next = new Set(hidden);
         next.delete(userId);
         apply(next);
      },
      [apply, hidden]
   );

   const showAllPeople = useCallback(() => {
      if (!hidden.size) return;
      suppressTaskArrivalSound();
      apply(new Set());
   }, [apply, hidden]);

   return { hidden, hidePerson, showPerson, showAllPeople };
}
