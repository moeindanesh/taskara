import { useEffect, useState } from 'react';
import type { TaskaraAuthSession } from '@/lib/taskara-types';

export const authStorageKey = 'taskara.auth.session.v1';
export const authChangedEvent = 'taskara:auth-changed';

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
   const current = getAuthSession();
   if (current && authSessionsEqual(current, session)) return;
   window.localStorage.setItem(authStorageKey, JSON.stringify(session));
   window.dispatchEvent(new CustomEvent(authChangedEvent));
}

export function clearAuthSession(): void {
   if (!canUseStorage()) return;
   if (!window.localStorage.getItem(authStorageKey)) return;
   window.localStorage.removeItem(authStorageKey);
   window.dispatchEvent(new CustomEvent(authChangedEvent));
}

export function authSessionsEqual(left: TaskaraAuthSession, right: TaskaraAuthSession): boolean {
   return (
      left.token === right.token &&
      left.expiresAt === right.expiresAt &&
      (left.role || null) === (right.role || null) &&
      (left.supportAccessEpoch ?? null) === (right.supportAccessEpoch ?? null) &&
      supportSummariesEqual(left.support, right.support) &&
      stringSetsEqual(left.capabilities, right.capabilities) &&
      stringSetsEqual(left.permissions, right.permissions) &&
      authUsersEqual(left.user, right.user) &&
      authWorkspacesEqual(left.workspace || null, right.workspace || null)
   );
}

function supportSummariesEqual(
   left: TaskaraAuthSession['support'],
   right: TaskaraAuthSession['support']
): boolean {
   return (
      (left?.needsSetup ?? null) === (right?.needsSetup ?? null) &&
      (left?.unassignedCount ?? null) === (right?.unassignedCount ?? null) &&
      (left?.departmentInboxCount ?? null) === (right?.departmentInboxCount ?? null) &&
      (left?.myCaseCount ?? null) === (right?.myCaseCount ?? null) &&
      (left?.needsAttentionCount ?? null) === (right?.needsAttentionCount ?? null)
   );
}

function authUsersEqual(
   left: TaskaraAuthSession['user'],
   right: TaskaraAuthSession['user']
): boolean {
   return (
      left.id === right.id &&
      left.name === right.name &&
      left.email === right.email &&
      (left.aiModel || null) === (right.aiModel || null) &&
      (left.phone || null) === (right.phone || null) &&
      (left.mattermostUsername || null) === (right.mattermostUsername || null) &&
      (left.avatarUrl || null) === (right.avatarUrl || null)
   );
}

function authWorkspacesEqual(
   left: NonNullable<TaskaraAuthSession['workspace']> | null,
   right: NonNullable<TaskaraAuthSession['workspace']> | null
): boolean {
   if (!left || !right) return left === right;
   return (
      left.id === right.id &&
      left.name === right.name &&
      left.slug === right.slug &&
      (left.mode || 'TEAM') === (right.mode || 'TEAM') &&
      (left.description || null) === (right.description || null)
   );
}

function stringSetsEqual(
   left: readonly string[] | null | undefined,
   right: readonly string[] | null | undefined
): boolean {
   const leftSet = new Set(left || []);
   const rightSet = new Set(right || []);
   if (leftSet.size !== rightSet.size) return false;
   for (const value of leftSet) {
      if (!rightSet.has(value)) return false;
   }
   return true;
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
