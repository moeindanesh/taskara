import { describe, expect, test } from 'bun:test';
import { applyWorkspaceSyncEvents } from './sync-events';
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
});
