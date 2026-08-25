import type { ReactNode } from 'react';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { taskaraRequest } from '@/lib/taskara-client';
import { dispatchWorkspaceRefresh, workspaceRefreshEvent } from '@/lib/live-refresh';
import type { NotificationSyncResponse, NotificationsResponse, TaskaraNotification } from '@/lib/taskara-types';
import { workspaceUserCacheKey, type WorkspaceCachePersistence } from '@/lib/workspace-cache';

type InboxSnapshot = {
   cursor: string | null;
   items: TaskaraNotification[];
   savedAt: string;
   unreadCount: number;
};

type InboxSyncState = {
   cursor: string | null;
   items: TaskaraNotification[];
   loading: boolean;
   error: string;
   unreadCount: number;
};

const inboxCachePrefix = 'taskara.inbox.v1:';
const inboxSyncIntervalMs = 60000;

export type InboxSyncController = ReturnType<typeof useInboxSync>;

const InboxSyncContext = createContext<InboxSyncController | null>(null);

export function WorkspaceInboxSyncProvider({
   children,
   persistence = 'local',
   userId,
   workspaceSlug,
}: {
   children: ReactNode;
   persistence?: WorkspaceCachePersistence;
   userId: string;
   workspaceSlug: string;
}) {
   const controller = useInboxSync(workspaceSlug, userId, persistence);
   return createElement(InboxSyncContext.Provider, { value: controller }, children);
}

export function useWorkspaceInboxSync(): InboxSyncController {
   const sync = useContext(InboxSyncContext);
   if (!sync) throw new Error('useWorkspaceInboxSync must be used inside WorkspaceInboxSyncProvider.');
   return sync;
}

function useInboxSync(
   workspaceSlug: string,
   userId: string,
   persistence: WorkspaceCachePersistence
) {
   const cacheKey = useMemo(
      () => workspaceUserCacheKey(inboxCachePrefix, workspaceSlug, userId, persistence),
      [persistence, userId, workspaceSlug]
   );
   const localReadMarkersRef = useRef(new Map<string, string>());
   const [state, setState] = useState<InboxSyncState>({
      cursor: null,
      items: [],
      loading: true,
      error: '',
      unreadCount: 0,
   });

   const saveSnapshot = useCallback(
      (snapshot: Omit<InboxSnapshot, 'savedAt'>) => {
         if (typeof window === 'undefined' || !cacheKey) return;
         try {
            window.localStorage.setItem(
               cacheKey,
               JSON.stringify({
                  ...snapshot,
                  savedAt: new Date().toISOString(),
               } satisfies InboxSnapshot)
            );
         } catch {
            // Cache writes are best effort. Network remains authoritative.
         }
      },
      [cacheKey]
   );

   const applySnapshot = useCallback(
      (snapshot: Omit<InboxSnapshot, 'savedAt'>, loading = false) => {
         const localSnapshot = applyLocalReadMarkers(snapshot, localReadMarkersRef.current);
         setState({
            cursor: localSnapshot.cursor,
            items: localSnapshot.items,
            loading,
            error: '',
            unreadCount: localSnapshot.unreadCount,
         });
         saveSnapshot(localSnapshot);
      },
      [saveSnapshot]
   );

   const refresh = useCallback(async () => {
      setState((current) => ({ ...current, loading: current.items.length === 0, error: '' }));
      try {
         const result = await taskaraRequest<NotificationsResponse>('/notifications?limit=100');
         applySnapshot({
            cursor: cursorFromNotifications(result.items),
            items: result.items,
            unreadCount: result.unreadCount,
         });
      } catch (err) {
         setState((current) => ({
            ...current,
            loading: false,
            error: err instanceof Error ? err.message : 'Inbox sync failed.',
         }));
      }
   }, [applySnapshot]);

   const sync = useCallback(async () => {
      const cursor = state.cursor;
      if (!cursor) {
         await refresh();
         return;
      }

      try {
         const params = new URLSearchParams({ after: cursor, limit: '100' });
         const result = await taskaraRequest<NotificationSyncResponse>(`/notifications/sync?${params.toString()}`);
         setState((current) => {
            const items = mergeInboxNotifications(current.items, result.items);
            const next = applyLocalReadMarkers({
               cursor: result.nextCursor || current.cursor,
               items,
               unreadCount: result.unreadCount,
            }, localReadMarkersRef.current);
            saveSnapshot(next);
            return { ...next, loading: false, error: '' };
         });
      } catch (err) {
         setState((current) => ({
            ...current,
            loading: false,
            error: err instanceof Error ? err.message : 'Inbox sync failed.',
         }));
      }
   }, [refresh, saveSnapshot, state.cursor]);

   useEffect(() => {
      localReadMarkersRef.current.clear();
      let restored = false;
      try {
         const raw = typeof window === 'undefined' || !cacheKey ? null : window.localStorage.getItem(cacheKey);
         const snapshot = raw ? JSON.parse(raw) : null;
         if (isInboxSnapshot(snapshot)) {
            restored = true;
            setState({
               cursor: snapshot.cursor,
               items: snapshot.items,
               loading: false,
               error: '',
               unreadCount: snapshot.unreadCount,
            });
         }
      } catch {
         // Ignore corrupted cache and rehydrate from the API.
      }

      if (!restored) {
         setState({ cursor: null, items: [], loading: true, error: '', unreadCount: 0 });
      }
      void refresh();
   }, [cacheKey, refresh]);

   useEffect(() => {
      const handleWake = () => {
         if (document.visibilityState === 'hidden') return;
         void sync();
      };
      const handlePageShow = (event: PageTransitionEvent) => {
         if (event.persisted) void sync();
      };
      const handleAuthChanged = () => void refresh();
      const interval = window.setInterval(handleWake, inboxSyncIntervalMs);

      window.addEventListener('online', handleWake);
      window.addEventListener('pageshow', handlePageShow);
      window.addEventListener('taskara:auth-changed', handleAuthChanged);
      window.addEventListener(workspaceRefreshEvent, handleWake);
      return () => {
         window.clearInterval(interval);
         window.removeEventListener('online', handleWake);
         window.removeEventListener('pageshow', handlePageShow);
         window.removeEventListener('taskara:auth-changed', handleAuthChanged);
         window.removeEventListener(workspaceRefreshEvent, handleWake);
      };
   }, [refresh, sync]);

   const markRead = useCallback(
      async (notification: TaskaraNotification) => {
         if (notification.readAt) return;
         const readAt = new Date().toISOString();
         const threadKey = notificationThreadKey(notification);
         localReadMarkersRef.current.set(threadKey, readAt);

         setState((current) => {
            const threadWasUnread = current.items.some(
               (item) => notificationThreadKey(item) === threadKey && !item.readAt
            );
            const nextItems = current.items.map((item) =>
               notificationThreadKey(item) === threadKey ? { ...item, readAt: item.readAt || readAt } : item
            );
            const next = {
               cursor: current.cursor,
               items: nextItems,
               unreadCount: threadWasUnread ? Math.max(0, current.unreadCount - 1) : current.unreadCount,
            };
            saveSnapshot(next);
            return { ...current, ...next };
         });

         try {
            await taskaraRequest(`/notifications/${notification.id}/read`, { method: 'PATCH' });
            dispatchWorkspaceRefresh({ source: 'notifications:read' });
         } catch (err) {
            if (localReadMarkersRef.current.get(threadKey) === readAt) {
               localReadMarkersRef.current.delete(threadKey);
            }
            setState((current) => {
               const nextItems = current.items.map((item) =>
                  notificationThreadKey(item) === threadKey && item.readAt === readAt ? { ...item, readAt: null } : item
               );
               const threadIsCurrentlyUnread = current.items.some(
                  (item) => notificationThreadKey(item) === threadKey && !item.readAt
               );
               const restoredThreadIsUnread = nextItems.some(
                  (item) => notificationThreadKey(item) === threadKey && !item.readAt
               );
               const nextUnreadCount =
                  restoredThreadIsUnread && !threadIsCurrentlyUnread
                     ? current.unreadCount + 1
                     : current.unreadCount;
               const next = {
                  cursor: current.cursor,
                  items: nextItems,
                  unreadCount: nextUnreadCount,
               };
               saveSnapshot(next);
               return {
                  ...current,
                  ...next,
                  error: err instanceof Error ? err.message : 'Failed to mark notification as read.',
               };
            });
         }
      },
      [saveSnapshot]
   );

   const markAllRead = useCallback(async () => {
      const readAt = new Date().toISOString();
      const markedThreads = new Map<string, string>();
      setState((current) => {
         for (const item of current.items) {
            const threadKey = notificationThreadKey(item);
            markedThreads.set(threadKey, readAt);
            localReadMarkersRef.current.set(threadKey, readAt);
         }
         const nextItems = current.items.map((item) => ({ ...item, readAt: item.readAt || readAt }));
         const next = { cursor: current.cursor, items: nextItems, unreadCount: 0 };
         saveSnapshot(next);
         return { ...current, ...next };
      });

      try {
         await taskaraRequest('/notifications/read-all', { method: 'POST', body: JSON.stringify({}) });
         dispatchWorkspaceRefresh({ source: 'notifications:read-all' });
      } catch (err) {
         for (const [threadKey, marker] of markedThreads) {
            if (localReadMarkersRef.current.get(threadKey) === marker) localReadMarkersRef.current.delete(threadKey);
         }
         await refresh();
         setState((current) => {
            const next = {
               ...current,
               error: err instanceof Error ? err.message : 'Failed to mark notifications as read.',
            };
            saveSnapshot({ cursor: next.cursor, items: next.items, unreadCount: next.unreadCount });
            return next;
         });
      }
   }, [refresh, saveSnapshot]);

   return {
      error: state.error,
      loading: state.loading,
      markAllRead,
      markRead,
      notifications: state.items,
      refresh,
      sync,
      unreadCount: state.unreadCount,
   };
}

function mergeInboxNotifications(current: TaskaraNotification[], incoming: TaskaraNotification[]): TaskaraNotification[] {
   if (incoming.length === 0) return current;

   const byThread = new Map<string, TaskaraNotification>();
   for (const item of current) byThread.set(notificationThreadKey(item), item);

   for (const item of incoming) {
      const key = notificationThreadKey(item);
      const existing = byThread.get(key);
      if (!existing || compareNotificationsByRecency(item, existing) < 0) {
         byThread.set(key, item);
      } else if (!item.readAt && existing.readAt) {
         byThread.set(key, { ...existing, readAt: null });
      }
   }

   return [...byThread.values()].sort(compareNotificationsByRecency).slice(0, 100);
}

function applyLocalReadMarkers(
   snapshot: Omit<InboxSnapshot, 'savedAt'>,
   localReadMarkers: Map<string, string>
): Omit<InboxSnapshot, 'savedAt'> {
   if (localReadMarkers.size === 0) return snapshot;

   let unreadCount = snapshot.unreadCount;
   let changed = false;
   const locallyReadUnreadThreads = new Set<string>();
   const items = snapshot.items.map((item) => {
      const threadKey = notificationThreadKey(item);
      const readAt = localReadMarkers.get(threadKey);
      if (!readAt || !localReadAppliesToNotification(item, readAt)) return item;

      if (!item.readAt && !locallyReadUnreadThreads.has(threadKey)) {
         unreadCount = Math.max(0, unreadCount - 1);
         locallyReadUnreadThreads.add(threadKey);
      }

      if (item.readAt) return item;
      changed = true;
      return { ...item, readAt };
   });

   return changed || unreadCount !== snapshot.unreadCount ? { ...snapshot, items, unreadCount } : snapshot;
}

function localReadAppliesToNotification(notification: TaskaraNotification, readAt: string): boolean {
   const notificationTime = Date.parse(notification.createdAt);
   const readTime = Date.parse(readAt);
   if (!Number.isFinite(notificationTime) || !Number.isFinite(readTime)) return true;
   return notificationTime <= readTime;
}

function cursorFromNotifications(items: TaskaraNotification[]): string | null {
   const latest = [...items].sort(compareNotificationsByRecency)[0];
   return latest ? `${latest.createdAt}|${latest.id}` : null;
}

function compareNotificationsByRecency(left: TaskaraNotification, right: TaskaraNotification): number {
   const leftTime = Date.parse(left.createdAt) || 0;
   const rightTime = Date.parse(right.createdAt) || 0;
   if (leftTime !== rightTime) return rightTime - leftTime;
   return right.id.localeCompare(left.id);
}

function sameNotificationThread(left: TaskaraNotification, right: TaskaraNotification): boolean {
   return notificationThreadKey(left) === notificationThreadKey(right);
}

function notificationThreadKey(notification: TaskaraNotification): string {
   if (notification.task?.id) return `task:${notification.task.id}`;
   if (notification.announcement?.id) return `announcement:${notification.announcement.id}`;
   if (notification.meeting?.id) return `meeting:${notification.meeting.id}`;
   if (notification.knowledgePage?.id) return `knowledge:${notification.knowledgePage.id}`;
   return `notification:${notification.id}`;
}

function isInboxSnapshot(value: unknown): value is InboxSnapshot {
   if (!value || typeof value !== 'object') return false;
   const snapshot = value as Partial<InboxSnapshot>;
   return (
      (snapshot.cursor === null || typeof snapshot.cursor === 'string') &&
      typeof snapshot.savedAt === 'string' &&
      Array.isArray(snapshot.items) &&
      typeof snapshot.unreadCount === 'number'
   );
}
