import { taskaraRequest } from '@/lib/taskara-client';
import type { SupportCase, SupportCasePriority } from '@/lib/support-types';
import type { SupportTicketMedia } from '@/lib/support-ticket-media';

export type SupportTicketStatus = 'NEW' | 'OPEN' | 'CLOSED';

export interface SupportTicket {
   id: string;
   key: string;
   title: string;
   status: SupportTicketStatus;
   priority: SupportCasePriority;
   createdAt: string;
   updatedAt: string;
   contact: {
      id: string;
      name?: string | null;
      email?: string | null;
      phone?: string | null;
   } | null;
   caseId: string | null;
   caseKey: string | null;
   version: number;
}

export interface SupportTicketMessage {
   id: string;
   authorType: 'CUSTOMER' | 'SUPPORTER' | 'SYSTEM';
   author?: { id: string; name: string; avatarUrl?: string | null } | null;
   body: string | null;
   format: string;
   metadata?: Record<string, unknown> | null;
   createdAt: string;
}

export interface SupportTicketDetail {
   ticket: SupportTicket;
   messages: SupportTicketMessage[];
   case: SupportCase | null;
}

export interface SupportTicketCaseDraft {
   title: string;
   description: string;
   priority: SupportCasePriority;
   impact?: 'LOW' | 'MEDIUM' | 'HIGH';
   urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
   typeKey: string;
}

function segment(value: string): string {
   return encodeURIComponent(value);
}

export const supportTicketClient = {
   list: (query: { status?: SupportTicketStatus; priority?: SupportCasePriority; q?: string; cursor?: string } = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
      return taskaraRequest<{ items: SupportTicket[]; total: number; nextCursor: string | null }>(
         `/support/tickets${params.size ? `?${params.toString()}` : ''}`
      );
   },
   get: (idOrKey: string) =>
      taskaraRequest<SupportTicketDetail>(`/support/tickets/${segment(idOrKey)}`),
   draftCase: (idOrKey: string) =>
      taskaraRequest<{ draft: SupportTicketCaseDraft; ticket: SupportTicket }>(
         `/support/tickets/${segment(idOrKey)}/ai-draft`,
         { method: 'POST' }
      ),
   reply: (idOrKey: string, input: { text?: string; images?: SupportTicketMedia[] }) =>
      taskaraRequest<{ ticket: SupportTicket; replayed: boolean }>(
         `/support/tickets/${segment(idOrKey)}/messages`,
         {
            method: 'POST',
            body: JSON.stringify({ ...input, clientRequestId: crypto.randomUUID() }),
         }
      ),
   uploadImage: (idOrKey: string, file: File) => {
      const form = new FormData();
      form.set('file', file, file.name);
      return taskaraRequest<SupportTicketMedia>(
         `/support/tickets/${segment(idOrKey)}/media`,
         { method: 'POST', body: form }
      );
   },
   updateStatus: (idOrKey: string, status: 'OPEN' | 'CLOSED', baseVersion: number) =>
      taskaraRequest<SupportTicket>(
         `/support/tickets/${segment(idOrKey)}`,
         { method: 'PATCH', body: JSON.stringify({ status, baseVersion }) }
      ),
   updatePriority: (idOrKey: string, priority: SupportCasePriority, baseVersion: number) =>
      taskaraRequest<SupportTicket>(
         `/support/tickets/${segment(idOrKey)}`,
         { method: 'PATCH', body: JSON.stringify({ priority, baseVersion }) }
      ),
   createCase: (
      idOrKey: string,
      input: {
         useAi: boolean;
         title?: string;
         description?: string;
         priority?: SupportCasePriority;
         impact?: 'LOW' | 'MEDIUM' | 'HIGH';
         urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
         typeKey?: string;
         departmentId?: string;
      }
   ) => taskaraRequest<{ ticket: SupportTicket; case: SupportCase; aiFilled: boolean }>(
      `/support/tickets/${segment(idOrKey)}/create-case`,
      { method: 'POST', body: JSON.stringify(input) }
   ),
   updateCase: (
      idOrKey: string,
      input: {
         title?: string;
         description?: string | null;
         priority?: SupportCasePriority;
         impact?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
         urgency?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
         typeKey?: string;
         baseVersion: number;
      }
   ) => taskaraRequest<{ ticket: SupportTicket; case: SupportCase }>(
      `/support/tickets/${segment(idOrKey)}/case`,
      { method: 'PATCH', body: JSON.stringify(input) }
   ),
};
