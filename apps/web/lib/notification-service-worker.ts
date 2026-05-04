import { dispatchWorkspaceRefresh } from '@/lib/live-refresh';

const SERVICE_WORKER_URL = '/service-worker.js';
const AUTH_STORAGE_KEY = 'taskara.auth.session.v1';
const AUTH_CHANGED_EVENT = 'taskara:auth-changed';
const NOTIFICATIONS_ENABLED_STORAGE_KEY = 'taskara.notifications.enabled.v1';
const NOTIFICATIONS_CHANGED_EVENT = 'taskara:notifications-changed';

type ServiceWorkerConfigMessage = {
   type: 'TASKARA_SW_CONFIG';
   payload: {
      token: string;
      workspaceSlug: string;
      apiBaseUrl: string;
      notificationsEnabled: boolean;
   };
};

type ServiceWorkerSyncMessage = {
   type: 'TASKARA_SW_SYNC';
};

type ServiceWorkerSetEnabledMessage = {
   type: 'TASKARA_SW_SET_ENABLED';
   payload: {
      enabled: boolean;
   };
};

const publicRouteRoots = new Set(['login', 'signup', 'onboarding', 'accept-invite']);

export async function setupNotificationServiceWorker(): Promise<void> {
   if (typeof window === 'undefined') return;
   if (!('serviceWorker' in navigator)) return;
   if (!window.isSecureContext && window.location.hostname !== 'localhost') return;

   try {
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
      const readyRegistration = await navigator.serviceWorker.ready;

      const pushConfig = () => {
         const config = readServiceWorkerConfig();
         if (!config) return;

         const message: ServiceWorkerConfigMessage = {
            type: 'TASKARA_SW_CONFIG',
            payload: config,
         };

         registration.active?.postMessage(message);
         navigator.serviceWorker.controller?.postMessage(message);
      };

      const requestSync = () => {
         if (!areDesktopNotificationsEnabled()) return;
         if ('Notification' in window && window.Notification.permission !== 'granted') return;
         pushConfig();
         const syncMessage: ServiceWorkerSyncMessage = { type: 'TASKARA_SW_SYNC' };
         navigator.serviceWorker.controller?.postMessage(syncMessage);

         const syncRegistration = readyRegistration as ServiceWorkerRegistration & {
            sync?: { register: (tag: string) => Promise<void> };
         };
         void syncRegistration.sync?.register('taskara-notifications-sync').catch(() => undefined);
      };

      pushConfig();
      requestSync();

      navigator.serviceWorker.addEventListener('message', (event) => {
         const data = event.data as { type?: string; count?: number } | undefined;
         if (data?.type !== 'TASKARA_NOTIFICATIONS_UPDATED') return;
         dispatchWorkspaceRefresh({ source: `sw:notifications:${String(data.count ?? 0)}` });
      });

      window.addEventListener(AUTH_CHANGED_EVENT, pushConfig);
      window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, () => {
         pushConfig();
         requestSync();
      });
      window.addEventListener('storage', (event) => {
         if (!event.key || event.key === AUTH_STORAGE_KEY || event.key === NOTIFICATIONS_ENABLED_STORAGE_KEY) {
            pushConfig();
         }
      });
      window.addEventListener('online', requestSync);
      window.addEventListener('focus', requestSync);
      window.addEventListener('pageshow', requestSync);
      window.addEventListener('popstate', pushConfig);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
         pushConfig();
         requestSync();
      });
   } catch {
      // Service worker is best-effort. Main app notifications remain available via API polling.
   }
}

function readServiceWorkerConfig(): { token: string; workspaceSlug: string; apiBaseUrl: string; notificationsEnabled: boolean } | null {
   const token = readAuthToken();
   const workspaceSlug = readWorkspaceSlug();
   const apiBaseUrl = readApiBaseUrl();

   if (!token || !workspaceSlug || !apiBaseUrl) return null;

   return {
      token,
      workspaceSlug,
      apiBaseUrl,
      notificationsEnabled: areDesktopNotificationsEnabled(),
   };
}

function readAuthToken(): string | null {
   try {
      const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { token?: string };
      return typeof parsed?.token === 'string' && parsed.token ? parsed.token : null;
   } catch {
      return null;
   }
}

function readWorkspaceSlug(): string | null {
   const pathParts = window.location.pathname.split('/').filter(Boolean);
   if (!pathParts[0]) return null;
   if (publicRouteRoots.has(pathParts[0])) return null;
   return pathParts[0];
}

function readApiBaseUrl(): string | null {
   const runtimeConfig = window.__TASKARA_CONFIG__;
   const runtimeValue = runtimeConfig?.TASKARA_API_URL || runtimeConfig?.VITE_TASKARA_API_URL;
   if (typeof runtimeValue === 'string' && runtimeValue.trim()) return runtimeValue.trim().replace(/\/$/, '');

   const viteValue = import.meta.env.VITE_TASKARA_API_URL;
   if (typeof viteValue === 'string' && viteValue.trim()) return viteValue.trim().replace(/\/$/, '');

   return null;
}

export function areDesktopNotificationsEnabled(): boolean {
   if (typeof window === 'undefined') return true;

   try {
      const raw = window.localStorage.getItem(NOTIFICATIONS_ENABLED_STORAGE_KEY);
      if (raw === null) return true;
      return raw === '1';
   } catch {
      return true;
   }
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
   if (typeof window === 'undefined') return;

   try {
      window.localStorage.setItem(NOTIFICATIONS_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
   } catch {
      // Ignore localStorage failures and still try runtime update.
   }

   const message: ServiceWorkerSetEnabledMessage = {
      type: 'TASKARA_SW_SET_ENABLED',
      payload: { enabled },
   };

   navigator.serviceWorker?.controller?.postMessage(message);
   void navigator.serviceWorker?.ready
      .then((registration) => {
         registration.active?.postMessage(message);
      })
      .catch(() => undefined);

   window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail: { enabled } }));
}
