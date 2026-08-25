import { taskaraRequest } from '@/lib/taskara-client';
import type { SupportCasePriority } from '@/lib/support-types';
import type {
   CreateSupportRoutingPolicyInput,
   SupportPriorityDecisionResult,
   SupportRoutingApplyResult,
   SupportRoutingDecision,
   SupportRoutingMember,
   SupportRoutingPolicy,
} from '@/lib/support-routing-types';

function segment(value: string): string {
   return encodeURIComponent(value);
}

export function supportRoutingPolicyPath(id?: string, action?: 'activate'): string {
   const base = '/support/routing/policies';
   if (!id) return base;
   return `${base}/${segment(id)}${action ? `/${action}` : ''}`;
}

export function supportRoutingMembersPath(departmentId: string, userId?: string): string {
   const base = `/support/routing/departments/${segment(departmentId)}/members`;
   return userId ? `${base}/${segment(userId)}` : base;
}

export function supportCaseRoutingPath(
   idOrKey: string,
   action: 'simulate' | 'apply' | 'priority'
): string {
   return `/support/cases/${segment(idOrKey)}/routing/${action}`;
}

export const supportRoutingClient = {
   listPolicies: async () => {
      const result = await taskaraRequest<{ items: SupportRoutingPolicy[] }>(supportRoutingPolicyPath());
      return result.items;
   },
   createPolicy: (input: CreateSupportRoutingPolicyInput) => taskaraRequest<SupportRoutingPolicy>(
      supportRoutingPolicyPath(),
      { method: 'POST', body: JSON.stringify(input) }
   ),
   activatePolicy: (id: string) => taskaraRequest<SupportRoutingPolicy>(
      supportRoutingPolicyPath(id, 'activate'),
      { method: 'POST' }
   ),
   listMembers: async (departmentId: string) => {
      const result = await taskaraRequest<{ departmentId: string; items: SupportRoutingMember[] }>(
         supportRoutingMembersPath(departmentId)
      );
      return result.items;
   },
   updateMember: (
      departmentId: string,
      userId: string,
      input: Partial<Pick<SupportRoutingMember, 'routingAvailability' | 'routingCapacity' | 'routingSkills'>>
   ) => taskaraRequest<SupportRoutingMember>(supportRoutingMembersPath(departmentId, userId), {
      method: 'PATCH',
      body: JSON.stringify(input),
   }),
   simulate: (idOrKey: string, baseVersion: number) => taskaraRequest<SupportRoutingDecision>(
      supportCaseRoutingPath(idOrKey, 'simulate'),
      { method: 'POST', body: JSON.stringify({ baseVersion }) }
   ),
   apply: (idOrKey: string, baseVersion: number) => taskaraRequest<SupportRoutingApplyResult>(
      supportCaseRoutingPath(idOrKey, 'apply'),
      { method: 'POST', body: JSON.stringify({ baseVersion }) }
   ),
   decidePriority: (
      idOrKey: string,
      input: { decision: 'ACCEPT_SUGGESTION'; baseVersion: number }
         | { decision: 'OVERRIDE'; priority: SupportCasePriority; reason: string; baseVersion: number }
   ) => taskaraRequest<SupportPriorityDecisionResult>(supportCaseRoutingPath(idOrKey, 'priority'), {
      method: 'POST',
      body: JSON.stringify(input),
   }),
};
