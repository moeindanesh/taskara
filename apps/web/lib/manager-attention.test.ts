import { describe, expect, test } from 'bun:test';
import type { TaskaraAttentionItem } from './taskara-types';
import { managerAttentionGroupKey } from './manager-attention';

describe('manager attention projection', () => {
   test('collapses overlapping flow signals for the same task', () => {
      const overdue = attention({ id: 'overdue', reason: 'overdue_task' });
      const blocked = attention({ id: 'blocked', reason: 'blocked_task' });
      const stale = attention({ id: 'stale', reason: 'stale_task' });

      expect(new Set([overdue, blocked, stale].map(managerAttentionGroupKey)).size).toBe(1);
   });

   test('keeps a distinct review decision separate from restoring task flow', () => {
      const overdue = attention({ id: 'overdue', reason: 'overdue_task' });
      const review = attention({ id: 'review', reason: 'review_waiting' });

      expect(new Set([overdue, review].map(managerAttentionGroupKey)).size).toBe(2);
   });

   test('keeps backlog triage separate from later delivery interventions', () => {
      const triage = attention({ id: 'triage', reason: 'backlog_triage' });
      const overdue = attention({ id: 'overdue', reason: 'overdue_task' });

      expect(new Set([triage, overdue].map(managerAttentionGroupKey)).size).toBe(2);
   });

   test('combines overload and missing check-in into one person coordination item', () => {
      const overload = attention({
         entityId: 'user-1',
         entityType: 'user',
         id: 'overload',
         payload: { user: { id: 'user-1', name: 'سارا', email: 'sara@example.com' } },
         reason: 'overloaded_person',
      });
      const checkIn = attention({
         entityId: 'user-1',
         entityType: 'user',
         id: 'check-in',
         payload: { user: { id: 'user-1', name: 'سارا', email: 'sara@example.com' } },
         reason: 'missing_check_in',
      });

      expect(new Set([overload, checkIn].map(managerAttentionGroupKey)).size).toBe(1);
   });
});

function attention(overrides: Partial<TaskaraAttentionItem>): TaskaraAttentionItem {
   return {
      id: 'attention-1',
      workspaceId: 'workspace-1',
      assigneeId: 'user-1',
      managerId: 'manager-1',
      entityType: 'task',
      entityId: 'task-1',
      reason: 'overdue_task',
      severity: 'HIGH',
      status: 'OPEN',
      firstSeenAt: '2026-07-05T08:00:00.000Z',
      lastSeenAt: '2026-07-05T10:00:00.000Z',
      snoozedUntil: null,
      resolvedAt: null,
      dismissedAt: null,
      dismissalReason: null,
      payload: {
         task: {
            id: 'task-1',
            key: 'CORE-1',
            title: 'رفع مانع پرداخت',
            status: 'BLOCKED',
            priority: 'HIGH',
            dueAt: '2026-07-04T10:00:00.000Z',
            assigneeId: 'user-1',
            projectId: 'project-1',
            projectName: 'پرداخت',
         },
      },
      createdAt: '2026-07-05T08:00:00.000Z',
      updatedAt: '2026-07-05T10:00:00.000Z',
      ...overrides,
   };
}
