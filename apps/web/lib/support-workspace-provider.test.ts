import { describe, expect, test } from 'bun:test';
import {
   accessScopedInitialCounts,
   createSupportWorkspaceState,
   normalizeQueueCounts,
   supportStateFromBootstrap,
   supportAccessEpochMatches,
   supportWorkspaceReducer,
} from './support-workspace-provider';
import type { SupportCase } from './support-types';

describe('memory-only Support workspace state', () => {
   test('drops every sensitive projection when identity or access epoch changes', () => {
      const first = supportWorkspaceReducer(createSupportWorkspaceState('help:alice:4'), {
         type: 'upsert-cases',
         cases: [caseRecord('case-a', 'HELP-1')],
      });
      expect(first.casesById['case-a']?.title).toBe('پرونده آزمایشی');

      const nextPartition = createSupportWorkspaceState('help:bob:5');
      expect(nextPartition.partitionKey).toBe('help:bob:5');
      expect(nextPartition.casesById).toEqual({});
      expect(nextPartition.interactionsByCaseId).toEqual({});
      expect(nextPartition.eventsByCaseId).toEqual({});
   });

   test('treats a string/number equivalent epoch as current and a changed epoch as a purge signal', () => {
      expect(supportAccessEpochMatches('7', 7)).toBeTrue();
      expect(supportAccessEpochMatches('7', '8')).toBeFalse();
   });

   test('keeps normalized queue indexes in memory without duplicating Cases', () => {
      const item = caseRecord('case-a', 'HELP-1');
      let state = supportWorkspaceReducer(createSupportWorkspaceState('help:alice:1'), {
         type: 'set-queue', queue: 'TRIAGE', cases: [item], total: 1,
      });
      state = supportWorkspaceReducer(state, {
         type: 'set-queue', queue: 'NEEDS_ATTENTION', cases: [{ ...item, version: 2 }], total: 1,
      });
      expect(Object.keys(state.casesById)).toEqual(['case-a']);
      expect(state.casesById['case-a']?.version).toBe(2);
      expect(state.queueCaseIds.TRIAGE).toEqual(['case-a']);
      expect(state.queueCaseIds.NEEDS_ATTENTION).toEqual(['case-a']);
   });

   test('never exposes counts for queues the actor cannot read', () => {
      const counts = accessScopedInitialCounts(
         new Set(['support.cases.mine.read']),
         { unassignedCount: 90, departmentInboxCount: 30, myCaseCount: 3 }
      );
      expect(counts).toEqual({ MY_CASES: 3 });
   });

   test('normalizes API count names into the internal queue vocabulary', () => {
      expect(normalizeQueueCounts({ triage: 2, departmentInbox: 3, myCases: 4, needsAttention: 5 })).toEqual({
         TRIAGE: 2,
         DEPARTMENT_INBOX: 3,
         MY_CASES: 4,
         NEEDS_ATTENTION: 5,
      });
   });

   test('a sync reset replaces stale Cases and clears cached private timelines', () => {
      let state = supportWorkspaceReducer(createSupportWorkspaceState('help:alice:4'), {
         type: 'upsert-cases',
         cases: [caseRecord('stale-case', 'HELP-1')],
      });
      state = supportWorkspaceReducer(state, {
         type: 'set-interactions',
         caseId: 'stale-case',
         interactions: [{
            id: 'private-note', workspaceId: 'workspace', caseId: 'stale-case', kind: 'NOTE',
            visibility: 'INTERNAL', channel: 'MANUAL', direction: 'INTERNAL', contactId: null,
            occurredAt: '2026-08-23T12:00:00.000Z', createdAt: '2026-08-23T12:00:00.000Z',
         }],
      });
      state = supportWorkspaceReducer(state, {
         type: 'set-grants',
         grants: [{ userId: 'supervisor', role: 'SUPERVISOR' }],
      });

      const reset = supportStateFromBootstrap(state.partitionKey, {
         cases: [{ ...caseRecord('fresh-case', 'HELP-2'), assigneeMembershipId: 'membership-a' }],
         counts: { myCases: 1 },
         accessEpoch: '4',
         access: {
            workspaceWide: false,
            triager: false,
            supervisor: false,
            managedDepartmentIds: [],
            memberMembershipIds: ['membership-a'],
         },
      }, state);
      expect(Object.keys(reset.casesById)).toEqual(['fresh-case']);
      expect(reset.interactionsByCaseId).toEqual({});
      expect(reset.eventsByCaseId).toEqual({});
      expect(reset.queueCounts).toEqual({ MY_CASES: 1 });
      expect(reset.queueCaseIds.MY_CASES).toEqual(['fresh-case']);
      expect(reset.queueCaseIds.MY_CASES).not.toContain('stale-case');
      expect(reset.grantsByUserId['supervisor:SUPERVISOR']?.role).toBe('SUPERVISOR');
   });

   test('a removeFromScope delta atomically purges the Case, queue row, and private timeline', () => {
      let state = supportWorkspaceReducer(createSupportWorkspaceState('help:alice:4'), {
         type: 'set-queue',
         queue: 'MY_CASES',
         cases: [caseRecord('case-a', 'HELP-1')],
         total: 1,
      });
      state = supportWorkspaceReducer(state, {
         type: 'set-interactions',
         caseId: 'case-a',
         interactions: [{
            id: 'private-note', workspaceId: 'workspace', caseId: 'case-a', kind: 'NOTE',
            visibility: 'INTERNAL', channel: 'MANUAL', direction: 'INTERNAL', contactId: null,
            occurredAt: '2026-08-23T12:00:00.000Z', createdAt: '2026-08-23T12:00:00.000Z',
         }],
      });
      state = supportWorkspaceReducer(state, {
         type: 'set-events',
         caseId: 'case-a',
         events: [{
            id: 'audit-a', caseId: 'case-a', sequence: 1, action: 'case.note_added',
            source: 'WEB', actorId: 'alice', occurredAt: '2026-08-23T12:00:00.000Z',
            createdAt: '2026-08-23T12:00:00.000Z',
         }],
      });

      state = supportWorkspaceReducer(state, {
         type: 'apply-sync-events',
         events: [{ type: 'removeFromScope', entityType: 'support_case', entityId: 'case-a' }],
      });

      expect(state.casesById).toEqual({});
      expect(state.caseIdByKey).toEqual({});
      expect(state.queueCaseIds.MY_CASES).toEqual([]);
      expect(state.interactionsByCaseId).toEqual({});
      expect(state.eventsByCaseId).toEqual({});
      expect(state.syncRevision).toBe(1);
   });

   test('an upsert delta detaches stale queue placement and advances the reload revision', () => {
      const item = caseRecord('case-a', 'HELP-1');
      let state = supportWorkspaceReducer(createSupportWorkspaceState('help:manager:4'), {
         type: 'set-queue', queue: 'DEPARTMENT_INBOX', cases: [item], total: 1,
      });
      state = supportWorkspaceReducer(state, {
         type: 'apply-sync-events',
         events: [{
            type: 'upsert', entityType: 'support_case', entityId: item.id,
            entity: { ...item, status: 'OPEN', assigneeMembershipId: 'membership-a', version: 2 },
         }],
      });

      expect(state.casesById[item.id]?.version).toBe(2);
      expect(state.queueCaseIds.DEPARTMENT_INBOX).toEqual([]);
      expect(state.syncRevision).toBe(1);
   });

   test('a sync reset keeps the visible Triage projection populated', () => {
      const reset = supportStateFromBootstrap('help:triager:2', {
         cases: [caseRecord('new-unassigned', 'HELP-3')],
         counts: { triage: 1 },
         accessEpoch: '2',
         access: {
            workspaceWide: false,
            triager: true,
            supervisor: false,
            managedDepartmentIds: [],
            memberMembershipIds: [],
         },
      });
      expect(reset.queueCaseIds.TRIAGE).toEqual(['new-unassigned']);
   });

   test('a late bootstrap keeps an explicitly loaded queue page authoritative without dropping sync Cases', () => {
      const first = caseRecord('page-first', 'HELP-10');
      const second = caseRecord('page-second', 'HELP-11');
      let state = supportWorkspaceReducer(createSupportWorkspaceState('help:triager:2'), {
         type: 'set-queue',
         queue: 'TRIAGE',
         cases: [first, second],
         total: 75,
      });

      state = supportWorkspaceReducer(state, {
         type: 'replace-bootstrap',
         preserveQueues: ['TRIAGE'],
         bootstrap: {
            cases: [{ ...first, version: 2 }, second, caseRecord('sync-only', 'HELP-12')],
            counts: { triage: 3 },
            accessEpoch: '2',
            access: {
               workspaceWide: false,
               triager: true,
               supervisor: false,
               managedDepartmentIds: [],
               memberMembershipIds: [],
            },
         },
      });

      expect(state.queueCaseIds.TRIAGE).toEqual(['page-first', 'page-second']);
      expect(state.queueCounts.TRIAGE).toBe(75);
      expect(state.casesById['page-first']?.version).toBe(2);
      expect(state.casesById['sync-only']?.key).toBe('HELP-12');
   });
});

function caseRecord(id: string, key: string): SupportCase {
   const now = '2026-08-23T12:00:00.000Z';
   return {
      id, key, workspaceId: 'workspace', sequence: 1, title: 'پرونده آزمایشی', description: null,
      sourceChannel: 'MANUAL', typeKey: 'general', priority: 'NORMAL', impact: null, urgency: null,
      status: 'NEW', waitingReason: null, departmentId: null, assigneeMembershipId: null, contactId: null,
      nextActionAt: null, nextSlaDueAt: null, resolutionCode: null, resolutionSummary: null,
      receivedAt: now, lastMeaningfulActivityAt: now, resolvedAt: null, closedAt: null,
      version: 1, createdAt: now, updatedAt: now,
   };
}
