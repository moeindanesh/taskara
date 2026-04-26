import type { TaskaraAttachment } from './taskara-types';
import { clearAuthSession, getAuthToken } from '@/store/auth-store';

export interface UploadedMediaObject {
   documentId?: string;
   object: string;
   url: string;
   name: string;
   mimeType?: string;
   sizeBytes: number;
}

export class TaskaraClientError extends Error {
   constructor(
      message: string,
      public readonly status?: number
   ) {
      super(message);
      this.name = 'TaskaraClientError';
   }
}

export async function taskaraRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
   const pathParts = typeof window !== 'undefined' ? window.location.pathname.split('/').filter(Boolean) : [];
   const publicRouteRoots = new Set(['login', 'signup', 'onboarding', 'accept-invite']);
   const workspaceSlug =
      typeof window !== 'undefined' && pathParts[0] && !publicRouteRoots.has(pathParts[0])
         ? pathParts[0]
         : undefined;
   const apiBaseUrl = requiredViteEnv('VITE_TASKARA_API_URL').replace(/\/$/, '');

   const headers = new Headers(init.headers);
   const token = getAuthToken();
   if (token) headers.set('authorization', `Bearer ${token}`);
   if (workspaceSlug) headers.set('x-workspace-slug', workspaceSlug);
   if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
   }

   const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
   });

   if (response.status === 204) return undefined as T;

   const text = await response.text();
   const isJson = isJsonResponse(response);
   const data = text && isJson ? parseJsonResponse(text, response, `${apiBaseUrl}${path}`) : undefined;

   if (!response.ok) {
      if (response.status === 401 && !path.startsWith('/auth/')) {
         clearAuthSession();
      }
      throw new TaskaraClientError(
         errorMessageFromResponse(data) ||
            (!isJson && text ? unexpectedApiResponseMessage(response, apiBaseUrl) : response.statusText),
         response.status
      );
   }

   if (text && !isJson) {
      throw new TaskaraClientError(unexpectedApiResponseMessage(response, apiBaseUrl), response.status);
   }

   return data as T;
}

function isJsonResponse(response: Response): boolean {
   const contentType = response.headers.get('content-type')?.toLowerCase() || '';
   return contentType.includes('application/json') || contentType.includes('+json');
}

function parseJsonResponse(text: string, response: Response, url: string): unknown {
   try {
      return JSON.parse(text);
   } catch {
      throw new TaskaraClientError(`Taskara API returned invalid JSON from ${url}.`, response.status);
   }
}

function errorMessageFromResponse(data: unknown): string | undefined {
   if (typeof data !== 'object' || data === null || !('message' in data)) return undefined;
   const message = data.message;
   return typeof message === 'string' && message.trim() ? message : undefined;
}

function unexpectedApiResponseMessage(response: Response, apiBaseUrl: string): string {
   const contentType = response.headers.get('content-type') || 'unknown content type';
   return `Expected JSON from Taskara API, but received ${contentType}. Check VITE_TASKARA_API_URL; it should point to the API server (${apiBaseUrl}), not the web server.`;
}

function requiredViteEnv(name: string): string {
   const runtimeValue = runtimeEnvValue(name);
   if (runtimeValue) return runtimeValue;

   const value = import.meta.env[name];
   if (typeof value === 'string' && value.trim()) return value.trim();
   throw new Error(`${name} is required`);
}

function runtimeEnvValue(name: string): string | undefined {
   if (typeof window === 'undefined') return undefined;

   const config = window.__TASKARA_CONFIG__;
   const value =
      name === 'VITE_TASKARA_API_URL' ? config?.TASKARA_API_URL || config?.VITE_TASKARA_API_URL : undefined;
   return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function uploadTaskAttachment(task: string, file: File, name = file.name): Promise<TaskaraAttachment> {
   const form = new FormData();
   form.set('name', name);
   form.set('file', file, file.name);

   return taskaraRequest<TaskaraAttachment>(`/tasks/${encodeURIComponent(task)}/attachments`, {
      method: 'POST',
      body: form,
   });
}

export function uploadMedia(file: File, name = file.name): Promise<UploadedMediaObject> {
   const form = new FormData();
   form.set('name', name);
   form.set('file', file, file.name);

   return taskaraRequest<UploadedMediaObject>('/uploads', {
      method: 'POST',
      body: form,
   });
}
