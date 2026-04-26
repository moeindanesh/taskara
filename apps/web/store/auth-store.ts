import { useEffect, useState } from 'react';
import type { TaskaraAuthSession } from '@/lib/taskara-types';

const authStorageKey = 'taskara.auth.session.v1';
const authChangedEvent = 'taskara:auth-changed';

function canUseStorage() {
   return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getAuthSession(): TaskaraAuthSession | null {
   if (!canUseStorage()) return null;

   try {
      const raw = window.localStorage.getItem(authStorageKey);
      if (!raw) return null;

      const session = JSON.parse(raw) as TaskaraAuthSession;
      if (!session.token || !session.expiresAt || new Date(session.expiresAt).getTime() <= Date.now()) {
         clearAuthSession();
         return null;
      }

      return session;
   } catch {
      clearAuthSession();
      return null;
   }
}

export function getAuthToken(): string | null {
   return getAuthSession()?.token || null;
}

export function setAuthSession(session: TaskaraAuthSession): void {
   if (!canUseStorage()) return;
   window.localStorage.setItem(authStorageKey, JSON.stringify(session));
   window.dispatchEvent(new CustomEvent(authChangedEvent));
}

export function clearAuthSession(): void {
   if (!canUseStorage()) return;
   window.localStorage.removeItem(authStorageKey);
   window.dispatchEvent(new CustomEvent(authChangedEvent));
}

export function useAuthSession() {
   const [session, setSessionState] = useState<TaskaraAuthSession | null>(() => getAuthSession());

   useEffect(() => {
      const update = () => setSessionState(getAuthSession());
      window.addEventListener(authChangedEvent, update);
      window.addEventListener('storage', update);
      return () => {
         window.removeEventListener(authChangedEvent, update);
         window.removeEventListener('storage', update);
      };
   }, []);

   return {
      session,
      setSession: setAuthSession,
      clearSession: clearAuthSession,
   };
}
