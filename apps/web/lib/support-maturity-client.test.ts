import { describe, expect, test } from 'bun:test';
import {
   normalizeSupportAssistanceSuggestion,
   normalizeSupportKnowledgeSearch,
   normalizeSupportProblemCluster,
   normalizeSupportQualityReview,
   supportCaseAssistancePath,
   supportCaseEnablementPath,
   supportKnowledgeGapsPath,
   supportProblemClustersPath,
} from './support-maturity-client';

describe('Support maturity client', () => {
   test('encodes Case and definition identifiers and preserves typed filters', () => {
      expect(supportCaseAssistancePath('SUP/42')).toBe('/support/cases/SUP%2F42/assistance');
      expect(supportCaseEnablementPath('SUP/42', 'definition/one', 'preview'))
         .toBe('/support/cases/SUP%2F42/enablement/definition%2Fone/preview');

      const gaps = new URL(supportKnowledgeGapsPath({ status: 'IN_REVIEW', limit: 25, offset: 50 }), 'https://taskara.test');
      expect(gaps.pathname).toBe('/support/knowledge/gaps');
      expect(Object.fromEntries(gaps.searchParams)).toEqual({ status: 'IN_REVIEW', limit: '25', offset: '50' });

      const clusters = new URL(supportProblemClustersPath({ q: 'login / sso', status: 'OPEN' }), 'https://taskara.test');
      expect(clusters.pathname).toBe('/support/problem-clusters');
      expect(clusters.searchParams.get('q')).toBe('login / sso');
      expect(clusters.searchParams.get('status')).toBe('OPEN');
   });

   test('projects assistance provenance and the closed payload union without retaining provider context', () => {
      const normalized = normalizeSupportAssistanceSuggestion({
         id: 'suggestion', caseId: 'case', kind: 'PRIORITY',
         payload: { priority: 'URGENT', privateContext: 'payload-secret' },
         provenance: {
            provider: 'rules', modelOrRule: 'impact-urgency', version: '3', confidence: 0.91,
            contextDigest: 'a'.repeat(64), privateContext: 'provenance-secret',
         },
         decision: 'PENDING', decisionReason: null, decisionCaseVersion: null,
         decidedAt: null, expiresAt: null, createdAt: '2026-08-23T10:00:00.000Z',
         privateContext: 'root-secret',
      });

      expect(normalized).toEqual({
         id: 'suggestion', caseId: 'case', kind: 'PRIORITY', payload: { priority: 'URGENT' },
         provenance: {
            provider: 'rules', modelOrRule: 'impact-urgency', version: '3', confidence: 0.91,
            contextDigest: 'a'.repeat(64),
         },
         decision: 'PENDING', decisionReason: null, decisionCaseVersion: null,
         decidedAt: null, expiresAt: null, createdAt: '2026-08-23T10:00:00.000Z',
      });
      expect(JSON.stringify(normalized)).not.toContain('secret');
   });

   test('keeps cluster and quality projections access-scoped even if a server adds incompatible peer fields', () => {
      const cluster = normalizeSupportProblemCluster({
         id: 'cluster', title: 'ورود سازمانی', summary: 'خطای ورود', status: 'OPEN', version: 2,
         createdById: 'manager', createdAt: '2026-08-20T10:00:00.000Z', updatedAt: '2026-08-23T10:00:00.000Z',
         visibleMemberCount: 1, accessEpoch: '9', unrestrictedMemberCount: 99,
         cases: [{
            id: 'case-visible', key: 'SUP-1', title: 'پرونده مجاز', status: 'OPEN', priority: 'HIGH',
            departmentId: 'department', assigneeMembershipId: null, version: 4,
            updatedAt: '2026-08-23T10:00:00.000Z', linkedAt: '2026-08-22T10:00:00.000Z',
            contact: { phone: 'peer-secret' }, description: 'peer-secret',
         }],
      });
      const review = normalizeSupportQualityReview({
         id: 'review', caseId: 'case-visible', rubricId: 'rubric', rubricVersion: 2,
         departmentId: 'department', assigneeUserId: 'agent', reviewerId: 'manager', reviewerKind: 'HUMAN',
         sampleReason: 'نمونه بسته‌شده', score: 84,
         findings: [{ criterionKey: 'accuracy', score: 4, finding: 'دقیق' }],
         completedAt: '2026-08-23T10:00:00.000Z', createdAt: '2026-08-23T10:00:00.000Z',
         case: { id: 'case-visible', key: 'SUP-1', title: 'پرونده مجاز', description: 'peer-secret' },
         rubric: { id: 'rubric', rubricKey: 'standard', name: 'استاندارد', version: 2, privateNotes: 'peer-secret' },
         reviewer: { id: 'manager', name: 'مدیر', email: 'peer-secret' },
         assignee: { id: 'agent', name: 'کارشناس', email: 'peer-secret' },
         aggregate: [{ name: 'peer-secret' }],
      });

      expect(cluster.cases?.[0]).toEqual({
         id: 'case-visible', key: 'SUP-1', title: 'پرونده مجاز', status: 'OPEN', priority: 'HIGH',
         departmentId: 'department', assigneeMembershipId: null, version: 4,
         updatedAt: '2026-08-23T10:00:00.000Z', linkedAt: '2026-08-22T10:00:00.000Z',
      });
      expect(review.reviewer).toEqual({ id: 'manager', name: 'مدیر' });
      expect(review.assignee).toEqual({ id: 'agent', name: 'کارشناس' });
      expect(JSON.stringify({ cluster, review })).not.toContain('peer-secret');
      expect(cluster.visibleMemberCount).toBe(1);
   });

   test('reduces Knowledge search results to metadata needed for KCS use', () => {
      const result = normalizeSupportKnowledgeSearch({
         items: [{
            id: 'page', title: 'راهنمای بازپرداخت', path: 'finance/refund', summary: 'مراحل پاسخ',
            status: 'PUBLISHED', version: 7, updatedAt: '2026-08-23T10:00:00.000Z',
            content: { children: ['large-private-copy'] }, contentText: 'large-private-copy',
            owner: { email: 'owner-private' },
         }],
         total: 1, limit: 20, offset: 0,
         case: { id: 'case', key: 'SUP-1', version: 3, title: 'must-not-cross' },
         accessDoesNotTransfer: true,
      });

      expect(result).toEqual({
         items: [{
            id: 'page', title: 'راهنمای بازپرداخت', path: 'finance/refund', summary: 'مراحل پاسخ',
            status: 'PUBLISHED', version: 7, updatedAt: '2026-08-23T10:00:00.000Z',
         }],
         total: 1, limit: 20, offset: 0,
         case: { id: 'case', key: 'SUP-1', version: 3 },
         accessDoesNotTransfer: true,
      });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(result)).not.toContain('must-not-cross');
   });
});
