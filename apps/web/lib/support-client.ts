import { taskaraRequest } from '@/lib/taskara-client';
import type {
   CreateSupportCallInput,
   CreateSupportCaseInput,
   SupportBootstrap,
   SupportCase,
   SupportCaseDetail,
   SupportCaseEvent,
   SupportCaseListQuery,
   SupportCaseMutationResult,
   SupportDepartment,
   SupportDepartmentMember,
   SupportInteraction,
   SupportPage,
   SupportPermissionGrant,
   SupportSearchResult,
   SupportSyncPull,
} from '@/lib/support-types';

function supportPath(part: string): string {
   return encodeURIComponent(part);
}

export function supportCaseListPath(query: SupportCaseListQuery = {}): string {
   const params = new URLSearchParams();
   for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
         value.forEach((item) => params.append(key, String(item)));
      } else {
         params.set(key, String(value));
      }
   }
   const suffix = params.toString();
   return `/support/cases${suffix ? `?${suffix}` : ''}`;
}

export function supportSearchPath(query: string, limit = 20): string {
   const params = new URLSearchParams({ q: query, limit: String(limit) });
   return `/support/search?${params.toString()}`;
}

export function supportSyncPullPath(accessEpoch: string | number, cursor: string, limit = 200): string {
   const params = new URLSearchParams({
      accessEpoch: String(accessEpoch),
      cursor,
      limit: String(limit),
   });
   return `/support/sync/pull?${params.toString()}`;
}

export const supportClient = {
   bootstrap: () => taskaraRequest<SupportBootstrap>('/support/sync/bootstrap'),
   pull: (accessEpoch: string | number, cursor: string, limit = 200) =>
      taskaraRequest<SupportSyncPull>(supportSyncPullPath(accessEpoch, cursor, limit)),
   counts: () => taskaraRequest<{ counts: SupportBootstrap['counts']; accessEpoch: string | number }>('/support/cases/counts'),

   listDepartments: () => taskaraRequest<{ items: SupportDepartment[]; total: number; accessEpoch: string }>('/support/departments'),
   createDepartment: (input: { name: string; slug: string; description?: string }) =>
      taskaraRequest<SupportDepartment>('/support/departments', {
         method: 'POST',
         body: JSON.stringify(input),
      }),
   updateDepartment: (id: string, input: Partial<Pick<SupportDepartment, 'name' | 'description' | 'active'>>) =>
      taskaraRequest<SupportDepartment>(`/support/departments/${supportPath(id)}`, {
         method: 'PATCH',
         body: JSON.stringify(input),
      }),
   listDepartmentMembers: (departmentId: string) =>
      taskaraRequest<{ items: SupportDepartmentMember[]; total: number; departmentId: string; accessEpoch: string }>(`/support/departments/${supportPath(departmentId)}/members`),
   addDepartmentMember: (departmentId: string, input: { userId: string; role: 'MEMBER' | 'MANAGER' }) =>
      taskaraRequest<SupportDepartmentMember>(`/support/departments/${supportPath(departmentId)}/members`, {
         method: 'POST',
         body: JSON.stringify(input),
      }),
   updateDepartmentMember: (
      departmentId: string,
      userId: string,
      input: { role?: 'MEMBER' | 'MANAGER'; active?: boolean }
   ) => taskaraRequest<SupportDepartmentMember>(
      `/support/departments/${supportPath(departmentId)}/members/${supportPath(userId)}`,
      { method: 'PATCH', body: JSON.stringify(input) }
   ),
   removeDepartmentMember: (departmentId: string, userId: string) =>
      taskaraRequest<void>(`/support/departments/${supportPath(departmentId)}/members/${supportPath(userId)}`, {
         method: 'DELETE',
      }),

   listPermissionGrants: () => taskaraRequest<{ items: SupportPermissionGrant[]; total: number; accessEpoch: string }>('/support/permission-grants'),
   setPermissionGrant: (input: { userId: string; role: 'TRIAGER' | 'SUPERVISOR' }) =>
      taskaraRequest<SupportPermissionGrant>('/support/permission-grants', {
         method: 'PUT',
         body: JSON.stringify(input),
      }),
   removePermissionGrant: (userId: string, role: 'TRIAGER' | 'SUPERVISOR') => {
      const params = new URLSearchParams({ userId, role });
      return taskaraRequest<void>(`/support/permission-grants?${params.toString()}`, { method: 'DELETE' });
   },

   listCases: (query: SupportCaseListQuery = {}) => taskaraRequest<SupportPage<SupportCase>>(supportCaseListPath(query)),
   search: (query: string, limit = 20) =>
      taskaraRequest<SupportSearchResult>(supportSearchPath(query, limit)),
   createCase: (input: CreateSupportCaseInput) =>
      taskaraRequest<SupportCaseMutationResult>('/support/cases', {
         method: 'POST',
         body: JSON.stringify(input),
      }),
   getCase: (idOrKey: string) =>
      taskaraRequest<SupportCase | SupportCaseDetail>(`/support/cases/${supportPath(idOrKey)}`),
   routeCase: (
      idOrKey: string,
      input: { targetDepartmentId: string; targetAssigneeMembershipId?: string | null; reason?: string; baseVersion: number }
   ) => supportMutation(idOrKey, 'route', input),
   waitCase: (
      idOrKey: string,
      input:
         | { status: 'WAITING_ON_CUSTOMER'; nextActionAt: string; baseVersion: number }
         | { status: 'WAITING_ON_INTERNAL'; waitingReason: string; nextActionAt: string; baseVersion: number }
   ) => supportMutation(idOrKey, 'wait', input),
   resolveCase: (
      idOrKey: string,
      input: { resolutionCode: string; resolutionSummary: string; duplicateOfCaseId?: string; baseVersion: number }
   ) => supportMutation(idOrKey, 'resolve', input),
   closeCase: (
      idOrKey: string,
      input: { confirmation: 'CUSTOMER_CONFIRMED' | 'POLICY_WINDOW_ELAPSED' | 'ADMIN_OVERRIDE'; reason?: string; baseVersion: number }
   ) => supportMutation(idOrKey, 'close', input),
   reopenCase: (idOrKey: string, input: { reason: string; baseVersion: number }) =>
      supportMutation(idOrKey, 'reopen', input),

   listInteractions: (idOrKey: string) =>
      taskaraRequest<SupportPage<SupportInteraction>>(`/support/cases/${supportPath(idOrKey)}/interactions`),
   listEvents: (idOrKey: string) =>
      taskaraRequest<SupportPage<SupportCaseEvent>>(`/support/cases/${supportPath(idOrKey)}/events`),
   addInteraction: (
      idOrKey: string,
      input: {
         kind: 'MESSAGE' | 'CALL' | 'NOTE';
         visibility: 'PUBLIC' | 'INTERNAL';
         channel: 'API' | 'CALL' | 'MANUAL' | 'EMAIL' | 'MESSAGING';
         direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
         contactId?: string;
         occurredAt?: string;
         externalId?: string;
         content?: { body: string; format: 'text/plain' | 'text/markdown' };
         baseVersion: number;
      }
   ) => taskaraRequest<SupportCaseMutationResult>(`/support/cases/${supportPath(idOrKey)}/interactions`, {
      method: 'POST',
      body: JSON.stringify(input),
   }),
   createCall: (input: CreateSupportCallInput) =>
      taskaraRequest<SupportCaseMutationResult>('/support/calls', {
         method: 'POST',
         body: JSON.stringify(input),
      }),
};

function supportMutation(idOrKey: string, command: string, input: object) {
   return taskaraRequest<SupportCaseMutationResult>(`/support/cases/${supportPath(idOrKey)}/${command}`, {
      method: 'POST',
      body: JSON.stringify(input),
   });
}

export function caseFromMutation(
   result: SupportCaseMutationResult
): SupportCase {
   if ('case' in result) return result.case;
   return result;
}

export function caseFromDetail(result: SupportCase | SupportCaseDetail): SupportCase {
   return 'case' in result ? result.case : result;
}
