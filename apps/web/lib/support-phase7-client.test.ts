import { describe, expect, test } from 'bun:test';
import {
   supportCaseRoutingPath,
   supportRoutingMembersPath,
   supportRoutingPolicyPath,
} from './support-routing-client';
import {
   supportPresencePath,
   supportSavedQueuePath,
} from './support-collaboration-client';

describe('Support Phase 7 API clients', () => {
   test('encodes routing action identifiers without changing command shape', () => {
      expect(supportRoutingPolicyPath('policy/one', 'activate')).toBe(
         '/support/routing/policies/policy%2Fone/activate'
      );
      expect(supportRoutingMembersPath('department/one', 'user one')).toBe(
         '/support/routing/departments/department%2Fone/members/user%20one'
      );
      expect(supportCaseRoutingPath('SUP/42', 'simulate')).toBe(
         '/support/cases/SUP%2F42/routing/simulate'
      );
   });

   test('keeps saved-queue cursors and ephemeral presence identifiers in query parameters', () => {
      const saved = new URL(supportSavedQueuePath('view/one', 'opaque/cursor', 25), 'https://taskara.test');
      expect(saved.pathname).toBe('/support/saved-views/view%2Fone/cases');
      expect(saved.searchParams.get('cursor')).toBe('opaque/cursor');
      expect(saved.searchParams.get('limit')).toBe('25');

      const presence = new URL(supportPresencePath('SUP/42', {
         baseVersion: 7,
         clientId: 'support-presence:tab/one',
      }), 'https://taskara.test');
      expect(presence.pathname).toBe('/support/cases/SUP%2F42/presence');
      expect(presence.searchParams.get('baseVersion')).toBe('7');
      expect(presence.searchParams.get('clientId')).toBe('support-presence:tab/one');
   });
});
