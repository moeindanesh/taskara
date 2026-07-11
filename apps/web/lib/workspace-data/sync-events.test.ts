import { describe, expect, test } from 'bun:test';
import { applyMilestoneSyncEvents, applyWorkspaceSyncEvents } from './sync-events';
import type { TaskaraMilestone } from '../taskara-types';
import { emptyWorkspaceDataEntities } from './store';

describe('workspace-data sync event application', () => {
   test('upserts manager entities without mutating the previous state', () => {
      const initial = emptyWorkspaceDataEntities();

      const next = applyWorkspaceSyncEvents(initial, [
         {
            entityType: 'review',
            entityId: 'review-1',
            type: 'upsert',
            entity: { id: 'review-1', taskId: 'task-1', status: 'REQUESTED' },
         },
         {
            entityType: 'attention',
            entityId: 'attention-1',
            type: 'upsert',
            payload: { after: { id: 'attention-1', status: 'OPEN' } },
         },
      ]);

      expect(initial.reviews['review-1']).toBeUndefined();
      expect(initial.attention['attention-1']).toBeUndefined();
      expect(next.reviews['review-1']?.status).toBe('REQUESTED');
      expect(next.attention['attention-1']?.status).toBe('OPEN');
   });

   test('removes entities on delete and remove-from-scope events', () => {
      const initial = {
         ...emptyWorkspaceDataEntities(),
         meetingActionItems: {
            'action-1': { id: 'action-1', workspaceId: 'workspace-1', meetingId: 'meeting-1', title: 'Follow up', status: 'OPEN', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
         },
         projectHealthUpdates: {
            'update-1': { id: 'update-1', workspaceId: 'workspace-1', projectId: 'project-1', health: 'AT_RISK', summary: 'Risk', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
         },
      };

      const next = applyWorkspaceSyncEvents(initial, [
         { entityType: 'meeting_action_item', entityId: 'action-1', type: 'delete' },
         { entityType: 'project_health_update', entityId: 'update-1', type: 'removeFromScope' },
      ]);

      expect(next.meetingActionItems['action-1']).toBeUndefined();
      expect(next.projectHealthUpdates['update-1']).toBeUndefined();
      expect(initial.meetingActionItems['action-1']).toBeDefined();
      expect(initial.projectHealthUpdates['update-1']).toBeDefined();
   });

   test('ignores unsupported event types and malformed payloads', () => {
      const initial = emptyWorkspaceDataEntities();

      const next = applyWorkspaceSyncEvents(initial, [
         { entityType: 'task', entityId: 'task-1', type: 'upsert', entity: { id: 'task-1' } },
         { entityType: 'review', entityId: 'review-1', type: 'upsert', entity: { missingId: true } },
      ]);

      expect(next).toBe(initial);
   });

   test('upserts and removes milestone resources without mutating the previous array', () => {
      const initial = [milestone({ id: 'milestone-1', name: 'First', version: 1 })];
      const replacement = milestone({ id: 'milestone-1', name: 'Updated', version: 2 });
      const added = milestone({ id: 'milestone-2', name: 'Second' });

      const updated = applyMilestoneSyncEvents(initial, [
         { entityType: 'milestone', entityId: replacement.id, type: 'upsert', payload: { after: replacement } },
         { entityType: 'milestone', entityId: added.id, type: 'upsert', entity: added },
      ]);

      expect(initial[0]?.name).toBe('First');
      expect(updated.map((item) => [item.id, item.name])).toEqual([
         ['milestone-1', 'Updated'],
         ['milestone-2', 'Second'],
      ]);

      const removed = applyMilestoneSyncEvents(updated, [
         { entityType: 'milestone', entityId: 'milestone-1', type: 'removeFromScope' },
      ]);
      expect(removed.map((item) => item.id)).toEqual(['milestone-2']);
      expect(updated).toHaveLength(2);
   });

   test('preserves viewer-specific capabilities when a global progress event omits them', () => {
      const initial = [milestone({ canManage: true })];
      const refreshed = milestone({
         version: 2,
         progress: {
            ...initial[0].progress,
            eligibleTasks: 1,
            percentage: 0,
         },
      });
      const { canManage: _omitted, ...globalPayload } = refreshed;

      const updated = applyMilestoneSyncEvents(initial, [
         { entityType: 'milestone', entityId: refreshed.id, type: 'upsert', payload: { after: globalPayload } },
      ]);

      expect(updated[0].canManage).toBe(true);
      expect(updated[0].progress.eligibleTasks).toBe(1);
      expect(initial[0].progress.eligibleTasks).toBe(0);
   });
});

function milestone(overrides: Partial<TaskaraMilestone> = {}): TaskaraMilestone {
   return {
      id: 'milestone-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      ownerId: null,
      name: 'Milestone',
      kind: 'FEATURE',
      status: 'ACTIVE',
      health: null,
      position: 1024,
      version: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      project: { id: 'project-1', name: 'Project', keyPrefix: 'CORE' },
      owner: null,
      progress: {
         totalTasks: 0,
         eligibleTasks: 0,
         completedTasks: 0,
         canceledTasks: 0,
         blockedTasks: 0,
         overdueTasks: 0,
         totalWeight: 0,
         completedWeight: 0,
         percentage: null,
      },
      ...overrides,
   };
}
