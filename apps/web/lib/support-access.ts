import type { SupportAccessSummary, SupportCase, SupportResolutionCode } from '@/lib/support-types';

export type SupportCaseActionAccess = {
   canWork: boolean;
   canCloseOrReopen: boolean;
   routeMode: 'ANY_DEPARTMENT' | 'RETURN_TO_INBOX' | 'NONE';
   allowedResolutionCodes: SupportResolutionCode[];
};

const allResolutionCodes: SupportResolutionCode[] = [
   'FIXED', 'ANSWERED', 'WORKAROUND', 'DUPLICATE', 'NO_RESPONSE',
   'NOT_REPRODUCIBLE', 'REJECTED', 'WITHDRAWN', 'SPAM',
];

export function supportCaseActionAccess(
   item: Pick<SupportCase, 'departmentId' | 'assigneeMembershipId'>,
   access?: SupportAccessSummary
): SupportCaseActionAccess {
   if (!access) return {
      canWork: false,
      canCloseOrReopen: false,
      routeMode: 'NONE',
      allowedResolutionCodes: [],
   };

   const credentialActor = Boolean(access.credentialScopes?.length);
   const canWrite = !credentialActor || access.credentialScopes?.includes('CASE_WRITE');
   const elevated = (access.workspaceWide || access.supervisor) && canWrite;
   const unroutedTriager = access.triager && !item.departmentId;
   const departmentManager = Boolean(item.departmentId && access.managedDepartmentIds.includes(item.departmentId));
   const assignedMember = Boolean(
      item.assigneeMembershipId && access.memberMembershipIds.includes(item.assigneeMembershipId)
   );
   const canWork = Boolean(canWrite && (elevated || unroutedTriager || departmentManager || assignedMember));

   return {
      canWork,
      canCloseOrReopen: elevated || departmentManager,
      routeMode: canWrite && (elevated || unroutedTriager || departmentManager)
         ? 'ANY_DEPARTMENT'
         : canWrite && assignedMember && item.departmentId
           ? 'RETURN_TO_INBOX'
           : 'NONE',
      allowedResolutionCodes: unroutedTriager && !elevated
         ? ['REJECTED', 'SPAM', 'DUPLICATE']
         : canWork
           ? allResolutionCodes
           : [],
   };
}
