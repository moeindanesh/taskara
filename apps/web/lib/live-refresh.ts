import { useCallback, useEffect, useRef } from 'react';

export const workspaceRefreshEvent = 'taskara:workspace-refresh';

type WorkspaceRefreshDetail = {
   source?: string;
};

type LiveRefreshOptions = {
   enabled?: boolean;
   fireOnMount?: boolean;
   intervalMs?: number;
   minIntervalMs?: number;
};

export function dispatchWorkspaceRefresh(detail: WorkspaceRefreshDetail = {}) {
   if (typeof window === 'undefined') return;
   window.dispatchEvent(new CustomEvent(workspaceRefreshEvent, { detail }));
}

export function useLiveRefresh(onRefresh: () => void | Promise<void>, options: LiveRefreshOptions = {}) {
   const {
      enabled = true,
      fireOnMount = true,
      intervalMs = 60000,
      minIntervalMs = 1500,
   } = options;
   const onRefreshRef = useRef(onRefresh);
   const inFlightRef = useRef(false);
   const queuedRef = useRef(false);
   const lastRunRef = useRef(0);

   useEffect(() => {
      onRefreshRef.current = onRefresh;
   }, [onRefresh]);

   const requestRefresh = useCallback(
      (force = false) => {
         if (!enabled) return;
         const now = Date.now();
         if (!force && now - lastRunRef.current < minIntervalMs) return;
         if (inFlightRef.current) {
            queuedRef.current = true;
            return;
         }

         inFlightRef.current = true;
         lastRunRef.current = now;
         void Promise.resolve(onRefreshRef.current())
            .catch(() => undefined)
            .finally(() => {
               inFlightRef.current = false;
               if (!queuedRef.current) return;
               queuedRef.current = false;
               requestRefresh(true);
            });
      },
      [enabled, minIntervalMs]
   );

   useEffect(() => {
      if (!enabled) return;

      const handleWake = () => {
         if (document.visibilityState === 'hidden') return;
         requestRefresh();
      };
      const handleWorkspaceRefresh = () => {
         if (document.visibilityState === 'hidden') return;
         requestRefresh(true);
      };
      const handlePageShow = () => requestRefresh(true);

      if (fireOnMount) requestRefresh(true);
      const interval = window.setInterval(handleWake, intervalMs);
      window.addEventListener('focus', handleWake);
      window.addEventListener('online', handleWake);
      window.addEventListener('pageshow', handlePageShow);
      window.addEventListener(workspaceRefreshEvent, handleWorkspaceRefresh);
      document.addEventListener('visibilitychange', handleWake);

      return () => {
         window.clearInterval(interval);
         window.removeEventListener('focus', handleWake);
         window.removeEventListener('online', handleWake);
         window.removeEventListener('pageshow', handlePageShow);
         window.removeEventListener(workspaceRefreshEvent, handleWorkspaceRefresh);
         document.removeEventListener('visibilitychange', handleWake);
      };
   }, [enabled, fireOnMount, intervalMs, requestRefresh]);
}
