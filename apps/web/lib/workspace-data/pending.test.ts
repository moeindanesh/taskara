import { describe, expect, test } from 'bun:test';
import type {
   TaskaraAttentionItem,
   TaskaraAttentionResponse,
   TaskaraMeetingActionItem,
   TaskaraOneOnOneAgendaResponse,
   TaskaraOneOnOneSeries,
   TaskaraProject,
   TaskaraTask,
} from '@/lib/taskara-types';
import {
   applyPendingAttentionAction,
   applyPendingAttentionMutations,
   applyPendingAgendaItemMutations,
   applyPendingCarryForwardAgendaMutations,
   applyPendingMeetingActionItemMutations,
   applyPendingOneOnOneMutations,
   applyPendingProjectHealthMutations,
   hasPendingWorkspaceTasks,
   pendingTaskIds,
} from './pending';

const now = new Date('2026-07-05T10:00:00.000Z');

describe('workspace-data pending overlays', () => {
   test('tracks every stable id for pending tasks', () => {
      const ids = pendingTaskIds([
         task({ id: 'task-1', key: 'CORE-1', syncState: 'pending', syncMutationId: 'mutation-1' }),
         task({ id: 'task-2', key: 'CORE-2' }),
      ]);

      expect(ids.has('task-1')).toBe(true);
      expect(ids.has('CORE-1')).toBe(true);
      expect(ids.has('mutation-1')).toBe(true);
      expect(ids.has('task-2')).toBe(false);
      expect(hasPendingWorkspaceTasks([task({ syncState: 'pending' })])).toBe(true);
   });

   test('removes resolved and dismissed attention from the active queue', () => {
      const item = attention({ id: 'attention-1' });
      const resolved = applyPendingAttentionAction(response([item]), item, { type: 'resolve' }, now);
      const dismissed = applyPendingAttentionAction(response([item]), item, { type: 'dismiss', reason: 'Handled elsewhere' }, now);

      expect(resolved.items).toEqual([]);
      expect(resolved.total).toBe(0);
      expect(dismissed.items).toEqual([]);
      expect(dismissed.total).toBe(0);
   });

   test('hides future snoozes but keeps due snoozes visible with updated status', () => {
      const item = attention({ id: 'attention-1' });
      const future = applyPendingAttentionAction(
         response([item]),
         item,
         { type: 'snooze', snoozedUntil: '2026-07-06T10:00:00.000Z' },
         now
      );
      const due = applyPendingAttentionAction(
         response([item]),
         item,
         { type: 'snooze', snoozedUntil: '2026-07-05T09:00:00.000Z' },
         now
      );

      expect(future.items).toEqual([]);
      expect(future.total).toBe(0);
      expect(due.items[0]?.status).toBe('SNOOZED');
      expect(due.items[0]?.snoozedUntil).toBe('2026-07-05T09:00:00.000Z');
      expect(due.total).toBe(1);
   });

   test('replays queued attention mutations over freshly fetched attention', () => {
      const current = response([
         attention({ id: 'attention-1' }),
         attention({ id: 'attention-2' }),
         attention({ id: 'attention-3' }),
      ]);

      const next = applyPendingAttentionMutations(
         current,
         [
            {
               name: 'attention.snooze',
               args: { id: 'attention-1', snoozedUntil: '2026-07-06T10:00:00.000Z' },
               createdAt: '2026-07-05T10:01:00.000Z',
            },
            {
               name: 'attention.resolve',
               args: { id: 'attention-2' },
               createdAt: '2026-07-05T10:02:00.000Z',
            },
            {
               name: 'attention.dismiss',
               args: { id: 'attention-3', reason: 'Handled elsewhere' },
               createdAt: '2026-07-05T10:03:00.000Z',
            },
         ],
         now
      );

      expect(next.items).toEqual([]);
      expect(next.total).toBe(0);
   });

   test('replays queued meeting action item mutations over open action item fetches', () => {
      const next = applyPendingMeetingActionItemMutations(
         [
            actionItem({ id: 'action-1', title: 'Still open' }),
            actionItem({ id: 'action-2', title: 'Complete offline' }),
            actionItem({ id: 'action-3', title: 'Convert offline' }),
            actionItem({ id: 'action-4', title: 'Rename offline' }),
         ],
         [
            { name: 'meeting_action_item.complete', args: { id: 'action-2' }, createdAt: '2026-07-05T10:00:00.000Z' },
            { name: 'meeting_action_item.create_task', args: { id: 'action-3', task: {} }, createdAt: '2026-07-05T10:01:00.000Z' },
            {
               name: 'meeting_action_item.update',
               args: { id: 'action-4', patch: { title: 'Renamed offline', status: 'OPEN' } },
               createdAt: '2026-07-05T10:02:00.000Z',
            },
         ]
      );

      expect(next.map((item) => item.id)).toEqual(['action-1', 'action-4']);
      expect(next.find((item) => item.id === 'action-4')?.title).toBe('Renamed offline');
   });

   test('replays queued meeting action item creates as open pending items', () => {
      const next = applyPendingMeetingActionItemMutations(
         [actionItem({ id: 'action-1', meetingId: 'meeting-1', title: 'Existing action' })],
         [
            {
               name: 'meeting_action_item.create',
               args: {
                  meetingId: 'meeting-1',
                  item: {
                     title: 'Queued follow-up',
                     notes: 'Offline note',
                     dueAt: '2026-07-08T10:00:00.000Z',
                  },
               },
               createdAt: '2026-07-05T10:00:00.000Z',
            },
            {
               name: 'meeting_action_item.create',
               args: {
                  meetingId: 'meeting-1',
                  item: {
                     title: 'Existing action',
                  },
               },
               createdAt: '2026-07-05T10:01:00.000Z',
            },
         ]
      );

      expect(next.map((item) => item.id)).toEqual(['action-1', 'pending-action-meeting-1-2026-07-05T10:00:00.000Z']);
      expect(next[1]).toMatchObject({
         workspaceId: 'pending',
         meetingId: 'meeting-1',
         title: 'Queued follow-up',
         notes: 'Offline note',
         dueAt: '2026-07-08T10:00:00.000Z',
         status: 'OPEN',
         meeting: { id: 'meeting-1', title: 'جلسه' },
      });
   });

   test('replays queued project health updates as the latest project update', () => {
      const next = applyPendingProjectHealthMutations(
         [
            project({
               id: 'project-1',
               healthUpdates: [
                  {
                     id: 'server-update',
                     workspaceId: 'workspace-1',
                     projectId: 'project-1',
                     health: 'ON_TRACK',
                     summary: 'Server update',
                     createdAt: '2026-07-04T10:00:00.000Z',
                     updatedAt: '2026-07-04T10:00:00.000Z',
                  },
               ],
            }),
            project({ id: 'project-2' }),
         ],
         [
            {
               name: 'project_health_update.create',
               args: {
                  projectId: 'project-1',
                  update: {
                     health: 'AT_RISK',
                     summary: 'Queued update',
                     risks: 'Waiting on contract',
                     nextUpdateDueAt: '2026-07-07T10:00:00.000Z',
                  },
               },
               createdAt: '2026-07-05T10:00:00.000Z',
            },
         ],
         now
      );

      expect(next[0]?.healthUpdates?.[0]).toMatchObject({
         id: 'pending-project-1-2026-07-05T10:00:00.000Z',
         workspaceId: 'pending',
         projectId: 'project-1',
         health: 'AT_RISK',
         summary: 'Queued update',
         risks: 'Waiting on contract',
         nextUpdateDueAt: '2026-07-07T10:00:00.000Z',
      });
      expect(next[0]?.healthUpdates?.[1]?.id).toBe('server-update');
      expect(next[1]?.healthUpdates).toEqual([]);
   });

   test('replays queued one-on-one creates without duplicating existing participants', () => {
      const next = applyPendingOneOnOneMutations(
         [oneOnOne({ id: 'server-series', participantId: 'user-1' })],
         [
            {
               name: 'one_on_one.create',
               args: { participantId: 'user-1', cadenceDays: 14 },
               createdAt: '2026-07-05T10:00:00.000Z',
            },
            {
               name: 'one_on_one.create',
               args: { participantId: 'user-2', cadenceDays: 7, title: 'Weekly sync' },
               createdAt: '2026-07-05T10:01:00.000Z',
            },
            {
               name: 'one_on_one.create',
               args: { participantId: 'user-2', cadenceDays: 30, title: 'Duplicate queued sync' },
               createdAt: '2026-07-05T10:02:00.000Z',
            },
         ],
         [user('user-2')],
         now
      );

      expect(next.map((item) => item.id)).toEqual(['server-series', 'pending-one-on-one-user-2-2026-07-05T10:01:00.000Z']);
      expect(next[1]?.participant?.name).toBe('user-2');
      expect(next[1]?.cadenceDays).toBe(7);
   });

   test('replays queued agenda items and removes matching generated candidates', () => {
      const next = applyPendingAgendaItemMutations(
         agenda({
            generated: [
               {
                  sourceType: 'blocked_task',
                  sourceId: 'task-1',
                  title: 'Talk about blocker',
                  notes: 'Blocked by API',
                  severity: 'HIGH',
               },
               {
                  sourceType: 'overdue_task',
                  sourceId: 'task-2',
                  title: 'Talk about overdue task',
                  severity: 'MEDIUM',
               },
            ],
         }),
         [
            {
               name: 'one_on_one_agenda_item.create',
               args: {
                  seriesId: 'series-1',
                  item: {
                     title: 'Talk about blocker',
                     notes: 'Blocked by API',
                     sourceType: 'blocked_task',
                     sourceId: 'task-1',
                  },
               },
               createdAt: '2026-07-05T10:00:00.000Z',
            },
            {
               name: 'one_on_one_agenda_item.create',
               args: {
                  seriesId: 'other-series',
                  item: { title: 'Wrong series' },
               },
               createdAt: '2026-07-05T10:01:00.000Z',
            },
         ],
         now
      );

      expect(next.items.map((item) => item.id)).toEqual(['pending-agenda-series-1-blocked_task-task-1']);
      expect(next.items[0]?.workspaceId).toBe('pending');
      expect(next.generated.map((item) => `${item.sourceType}:${item.sourceId}`)).toEqual(['overdue_task:task-2']);
   });

   test('replays queued carry-forward mutations as agenda items from open action items', () => {
      const next = applyPendingCarryForwardAgendaMutations(
         agenda({
            generated: [
               {
                  sourceType: 'action_item',
                  sourceId: 'action-1',
                  title: 'Carry action item',
                  severity: 'MEDIUM',
               },
               {
                  sourceType: 'blocked_task',
                  sourceId: 'task-1',
                  title: 'Keep generated task',
                  severity: 'HIGH',
               },
            ],
         }),
         [
            actionItem({
               id: 'action-1',
               title: 'Carry action item',
               notes: 'Original action notes',
               updatedAt: '2026-07-05T09:00:00.000Z',
            }),
         ],
         [
            {
               name: 'meeting_action_item.carry_forward',
               args: { id: 'action-1', carry: { seriesId: 'series-1', notes: 'Carry-specific notes' } },
               createdAt: '2026-07-05T10:00:00.000Z',
            },
         ]
      );

      expect(next.items).toEqual([
         expect.objectContaining({
            id: 'pending-carry-series-1-action-1',
            workspaceId: 'pending',
            sourceType: 'action_item',
            sourceId: 'action-1',
            title: 'Carry action item',
            notes: 'Carry-specific notes',
         }),
      ]);
      expect(next.generated.map((item) => `${item.sourceType}:${item.sourceId}`)).toEqual(['blocked_task:task-1']);
   });

   test('does not duplicate queued carry-forward when agenda already has the action item source', () => {
      const next = applyPendingCarryForwardAgendaMutations(
         agenda({
            items: [
               {
                  id: 'server-agenda',
                  workspaceId: 'workspace-1',
                  seriesId: 'series-1',
                  sourceType: 'action_item',
                  sourceId: 'action-1',
                  title: 'Already carried',
                  status: 'OPEN',
                  createdAt: '2026-07-05T09:00:00.000Z',
               },
            ],
         }),
         [actionItem({ id: 'action-1', title: 'Carry action item' })],
         [
            {
               name: 'meeting_action_item.carry_forward',
               args: { id: 'action-1', carry: { seriesId: 'series-1' } },
               createdAt: '2026-07-05T10:00:00.000Z',
            },
         ]
      );

      expect(next.items.map((item) => item.id)).toEqual(['server-agenda']);
   });
});

function task(overrides: Partial<TaskaraTask> = {}): TaskaraTask {
   return {
      id: 'task-1',
      key: 'CORE-1',
      title: 'Task',
      status: 'TODO',
      priority: 'MEDIUM',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
   };
}

function response(items: TaskaraAttentionItem[]): TaskaraAttentionResponse {
   return {
      items,
      total: items.length,
      limit: 50,
      offset: 0,
      generatedAt: '2026-07-05T10:00:00.000Z',
   };
}

function attention(overrides: Partial<TaskaraAttentionItem> = {}): TaskaraAttentionItem {
   return {
      id: 'attention-1',
      workspaceId: 'workspace-1',
      assigneeId: 'user-1',
      managerId: null,
      entityType: 'task',
      entityId: 'task-1',
      reason: 'overdue_task',
      severity: 'HIGH',
      status: 'OPEN',
      firstSeenAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-01T00:00:00.000Z',
      snoozedUntil: null,
      resolvedAt: null,
      dismissedAt: null,
      dismissalReason: null,
      payload: {
         version: 1,
         title: 'Attention',
         description: 'Needs action',
         actionLabel: 'Open',
         reason: 'overdue_task',
         severity: 'HIGH',
         entity: { type: 'task', id: 'task-1' },
         signal: { conditionKey: 'overdue_task:task-1', generatedAt: '2026-07-05T10:00:00.000Z' },
      },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
   };
}

function actionItem(overrides: Partial<TaskaraMeetingActionItem> = {}): TaskaraMeetingActionItem {
   return {
      id: 'action-1',
      workspaceId: 'workspace-1',
      meetingId: 'meeting-1',
      title: 'Action item',
      notes: null,
      status: 'OPEN',
      assigneeId: null,
      taskId: null,
      dueAt: null,
      createdById: 'user-1',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
   };
}

function oneOnOne(overrides: Partial<TaskaraOneOnOneSeries> = {}): TaskaraOneOnOneSeries {
   return {
      id: 'series-1',
      workspaceId: 'workspace-1',
      managerId: 'manager-1',
      participantId: 'user-1',
      title: null,
      cadenceDays: 14,
      nextScheduledAt: null,
      lastMeetingId: null,
      active: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      participant: user('user-1'),
      manager: user('manager-1'),
      lastMeeting: null,
      _count: { agendaItems: 0 },
      ...overrides,
   };
}

function agenda(overrides: Partial<TaskaraOneOnOneAgendaResponse> = {}): TaskaraOneOnOneAgendaResponse {
   return {
      series: oneOnOne({ id: 'series-1' }),
      items: [],
      generated: [],
      generatedAt: '2026-07-05T10:00:00.000Z',
      ...overrides,
   };
}

function project(overrides: Partial<TaskaraProject> = {}): TaskaraProject {
   return {
      id: 'project-1',
      name: 'Project',
      keyPrefix: 'PROJ',
      description: null,
      status: 'ACTIVE',
      healthUpdates: [],
      ...overrides,
   };
}

function user(id: string) {
   return {
      id,
      membershipId: `member-${id}`,
      email: `${id}@example.com`,
      name: id,
      role: 'MEMBER',
      joinedAt: '2026-07-01T00:00:00.000Z',
   };
}
