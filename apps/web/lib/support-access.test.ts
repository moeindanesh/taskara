import { describe, expect, test } from 'bun:test';
import { supportCaseActionAccess } from './support-access';
import type { SupportAccessSummary } from './support-types';

const emptyAccess: SupportAccessSummary = {
   workspaceWide: false,
   triager: false,
   supervisor: false,
   managedDepartmentIds: [],
   memberMembershipIds: [],
};

describe('Support entity-scoped actions', () => {
   test('lets an assigned member return only their own Case to its Department inbox', () => {
      const access = { ...emptyAccess, memberMembershipIds: ['membership-me'] };
      expect(supportCaseActionAccess({ departmentId: 'sales', assigneeMembershipId: 'membership-me' }, access)).toMatchObject({
         canWork: true,
         canCloseOrReopen: false,
         routeMode: 'RETURN_TO_INBOX',
      });
      expect(supportCaseActionAccess({ departmentId: 'sales', assigneeMembershipId: 'membership-other' }, access)).toMatchObject({
         canWork: false,
         routeMode: 'NONE',
      });
   });

   test('limits an unrouted triager to safe resolution codes', () => {
      const access = supportCaseActionAccess(
         { departmentId: null, assigneeMembershipId: null },
         { ...emptyAccess, triager: true }
      );
      expect(access.routeMode).toBe('ANY_DEPARTMENT');
      expect(access.allowedResolutionCodes).toEqual(['REJECTED', 'SPAM', 'DUPLICATE']);
      expect(access.canCloseOrReopen).toBeFalse();
   });

   test('allows a Department manager to work and close Cases only in that Department', () => {
      const access = { ...emptyAccess, managedDepartmentIds: ['billing'] };
      expect(supportCaseActionAccess({ departmentId: 'billing', assigneeMembershipId: null }, access).canCloseOrReopen).toBeTrue();
      expect(supportCaseActionAccess({ departmentId: 'sales', assigneeMembershipId: null }, access).canWork).toBeFalse();
   });

   test('does not turn credential CASE_READ into browser write controls', () => {
      const access = supportCaseActionAccess(
         { departmentId: 'billing', assigneeMembershipId: null },
         { ...emptyAccess, workspaceWide: true, credentialScopes: ['CASE_READ'] }
      );
      expect(access.canWork).toBeFalse();
      expect(access.routeMode).toBe('NONE');
   });
});
