import { taskaraRequest } from '@/lib/taskara-client';
import type {
   CreateSupportSavedQueueInput,
   SupportPresenceResponse,
   SupportSavedQueue,
   SupportSavedQueueCasePage,
} from '@/lib/support-collaboration-types';

function segment(value: string): string {
   return encodeURIComponent(value);
}

export function supportSavedQueuePath(id?: string, cursor?: string, limit = 50): string {
   const base = `/support/saved-views${id ? `/${segment(id)}` : ''}`;
   if (!id || cursor === undefined) return base;
   const params = new URLSearchParams({ limit: String(limit) });
   if (cursor) params.set('cursor', cursor);
   return `${base}/cases?${params.toString()}`;
}

export function supportPresencePath(
   idOrKey: string,
   query?: { baseVersion: number; clientId?: string }
): string {
   const base = `/support/cases/${segment(idOrKey)}/presence`;
   if (!query) return base;
   const params = new URLSearchParams({ baseVersion: String(query.baseVersion) });
   if (query.clientId) params.set('clientId', query.clientId);
   return `${base}?${params.toString()}`;
}

export const supportCollaborationClient = {
   listSavedQueues: async () => {
      const result = await taskaraRequest<{ items: SupportSavedQueue[]; accessEpoch: string }>(
         supportSavedQueuePath()
      );
      return result.items;
   },
   createSavedQueue: (input: CreateSupportSavedQueueInput) => taskaraRequest<SupportSavedQueue>(
      supportSavedQueuePath(),
      { method: 'POST', body: JSON.stringify(input) }
   ),
   updateSavedQueue: (
      id: string,
      input: Partial<Omit<CreateSupportSavedQueueInput, 'filters' | 'departmentId'>> & {
         filters?: CreateSupportSavedQueueInput['filters'];
         departmentId?: string | null;
         baseVersion: number;
      }
   ) => taskaraRequest<SupportSavedQueue>(supportSavedQueuePath(id), {
      method: 'PATCH',
      body: JSON.stringify(input),
   }),
   deleteSavedQueue: (id: string, baseVersion: number) => taskaraRequest<void>(
      `${supportSavedQueuePath(id)}?baseVersion=${baseVersion}`,
      { method: 'DELETE' }
   ),
   useSavedQueue: (id: string, cursor = '', limit = 50) => taskaraRequest<SupportSavedQueueCasePage>(
      supportSavedQueuePath(id, cursor, limit)
   ),
   touchPresence: (
      idOrKey: string,
      input: { clientId: string; intent: 'VIEWING' | 'EDITING'; baseVersion: number }
   ) => taskaraRequest<SupportPresenceResponse>(supportPresencePath(idOrKey), {
      method: 'POST',
      body: JSON.stringify(input),
   }),
   readPresence: (idOrKey: string, baseVersion: number, clientId?: string) =>
      taskaraRequest<SupportPresenceResponse>(supportPresencePath(idOrKey, { baseVersion, clientId })),
   releasePresence: (idOrKey: string, baseVersion: number, clientId: string) => taskaraRequest<void>(
      supportPresencePath(idOrKey, { baseVersion, clientId }),
      { method: 'DELETE' }
   ),
};
