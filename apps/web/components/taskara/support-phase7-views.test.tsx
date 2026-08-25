import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
   SupportRoutingDecisionExplanation,
   suggestPriority,
} from './support-case-routing-assistance';
import { createSupportPresenceClientId } from './support-case-presence';
import { parseSupportRoutingKeys } from './support-routing-view';
import { savedQueueSummary } from './support-saved-queues-view';
import type { SupportRoutingDecision } from '@/lib/support-routing-types';
import type { SupportSavedQueue } from '@/lib/support-collaboration-types';

describe('Support Phase 7 views', () => {
   test('matches the server impact-by-urgency priority matrix', () => {
      expect(suggestPriority('LOW', 'LOW')).toBe('LOW');
      expect(suggestPriority('MEDIUM', 'MEDIUM')).toBe('HIGH');
      expect(suggestPriority('HIGH', 'MEDIUM')).toBe('URGENT');
      expect(suggestPriority(null, 'HIGH')).toBeNull();
   });

   test('explains a capacity route without exposing opaque member or decision identifiers', () => {
      const html = renderToStaticMarkup(<SupportRoutingDecisionExplanation decision={routingDecision()} />);
      expect(html).toContain('ارسال به مراقبت مشتری');
      expect(html).toContain('کمترین نسبت بار');
      expect(html).toContain('قاعده مشتری سازمانی');
      for (const hidden of ['membership-private-id', 'user-private-id', 'decision-fingerprint-private']) {
         expect(html).not.toContain(hidden);
      }
   });

   test('normalizes skill/type keys and describes saved filters without owner ids', () => {
      expect(parseSupportRoutingKeys(' Billing, api:Enterprise, billing ')).toEqual([
         'api:enterprise',
         'billing',
      ]);
      const summary = savedQueueSummary(savedQueue(), [{
         id: 'department-care', workspaceId: 'workspace', name: 'مراقبت مشتری', slug: 'care',
         description: null, active: true, createdAt: '', updatedAt: '',
      }]);
      expect(summary).toContain('نیازمند توجه');
      expect(summary).toContain('مراقبت مشتری');
      expect(summary).not.toContain('owner-private-id');
   });

   test('creates an allowed memory-only presence client id', () => {
      const id = createSupportPresenceClientId();
      expect(id.length).toBeGreaterThanOrEqual(8);
      expect(id.length).toBeLessThanOrEqual(160);
      expect(id).toMatch(/^[A-Za-z0-9._:-]+$/);
   });
});

function routingDecision(): SupportRoutingDecision {
   return {
      explanationVersion: 1,
      outcome: 'ROUTE',
      case: {
         id: 'case-id', key: 'SUP-7', version: 4, typeKey: 'enterprise', priority: 'HIGH',
         sourceChannel: 'API', impact: 'HIGH', urgency: 'MEDIUM',
      },
      policy: { id: 'policy-id', version: 3, label: 'سازمانی' },
      evaluatedRules: [{
         ruleId: 'rule-id', order: 1, name: 'قاعده مشتری سازمانی', result: 'MATCH', mismatches: [],
      }],
      matchedRule: { id: 'rule-id', order: 1, name: 'قاعده مشتری سازمانی' },
      fallbackReason: null,
      route: {
         departmentId: 'department-care',
         departmentName: 'مراقبت مشتری',
         assignment: {
            mode: 'CAPACITY_AWARE', result: 'MEMBER_SELECTED',
            selectionAlgorithm: 'LOWEST_UTILIZATION_THEN_LOAD_THEN_MEMBERSHIP_ID',
            capacityDetailsRedacted: false, consideredMemberCount: 4, eligibleMemberCount: 2,
            selectedMember: {
               membershipId: 'membership-private-id', userId: 'user-private-id', activeCaseLoad: 1,
               capacity: 5, availableSlots: 4, skills: ['enterprise'],
            },
         },
      },
      prioritySuggestion: {
         method: 'IMPACT_BY_URGENCY', suggestedPriority: 'URGENT', available: true,
         requiresHumanDecision: true,
      },
      decisionFingerprint: 'decision-fingerprint-private',
   };
}

function savedQueue(): SupportSavedQueue {
   return {
      id: 'queue-id', workspaceId: 'workspace', ownerId: 'owner-private-id', name: 'پیگیری فوری',
      visibility: 'PRIVATE', departmentId: null, version: 1, createdAt: '', updatedAt: '',
      filters: {
         schemaVersion: 1, queue: 'NEEDS_ATTENTION', statuses: ['OPEN'],
         departmentId: 'department-care', priorities: ['HIGH'], sourceChannels: [],
      },
   };
}
