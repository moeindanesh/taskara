import { taskaraApiBaseUrl, TaskaraClientError } from './taskara-client';

export interface PublicSupportMedia {
  documentId?: string;
  object: string;
  url?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSeconds?: number;
}

export interface PublicSupportCase {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  sourceChannel: string;
  description: string | null;
  receivedAt: string;
  updatedAt: string;
  version: number;
  contact?: { name?: string | null; email?: string | null; phone?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

export interface PublicSupportTimelineItem {
  id: string;
  kind: string;
  direction: string;
  occurredAt: string;
  receivedAt?: string;
  content?: { body?: string; format?: string } | null;
  metadata?: Record<string, unknown> | null;
}

export interface PublicSupportDetail {
  case: PublicSupportCase;
  timeline: PublicSupportTimelineItem[];
  events: Array<{ action: string; occurredAt: string }>;
  replayed?: boolean;
}

export interface PublicSupportPayload {
  text?: string;
  phone?: string;
  images?: PublicSupportMedia[];
  audio?: PublicSupportMedia[];
  consoleErrors?: Array<{ message: string; stack?: string; source?: string; line?: number; column?: number }>;
  pageContext?: {
    url?: string;
    title?: string;
    route?: string;
    referrer?: string;
    userAgent?: string;
    viewport?: { width: number; height: number };
    locale?: string;
    timezone?: string;
  };
  metadata?: Record<string, unknown>;
  clientRequestId?: string;
  contact?: { name?: string; email?: string; phone?: string; externalCustomerId?: string };
}

async function publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${taskaraApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...init.headers
    },
    cache: 'no-store'
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = data && typeof data.message === 'string' ? data.message : response.statusText;
    throw new TaskaraClientError(message, response.status);
  }
  return data as T;
}

export const publicSupportClient = {
  list: (query: { phone: string; q?: string; status?: string; priority?: string }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
    return publicRequest<{ items: PublicSupportCase[]; total: number; nextCursor: string | null }>(
      `/public/support/cases${params.size ? `?${params.toString()}` : ''}`
    );
  },
  detail: (idOrKey: string, phone: string) => {
    const params = new URLSearchParams({ phone });
    return publicRequest<PublicSupportDetail>(
      `/public/support/cases/${encodeURIComponent(idOrKey)}?${params.toString()}`
    );
  },
  create: (payload: PublicSupportPayload) =>
    publicRequest<PublicSupportDetail>('/public/support/cases', { method: 'POST', body: JSON.stringify(payload) }),
  message: (idOrKey: string, payload: PublicSupportPayload) =>
    publicRequest<PublicSupportDetail>(`/public/support/cases/${encodeURIComponent(idOrKey)}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  updateStatus: (idOrKey: string, status: string, baseVersion: number, reason?: string) =>
    publicRequest<PublicSupportDetail>(`/public/support/cases/${encodeURIComponent(idOrKey)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, baseVersion, reason })
    }),
  upload: async (file: File) => {
    const form = new FormData();
    form.set('file', file, file.name);
    form.set('name', file.name);
    return publicRequest<PublicSupportMedia>('/public/support/media', { method: 'POST', body: form });
  }
};
