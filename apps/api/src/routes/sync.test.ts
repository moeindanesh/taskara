import { describe, expect, test } from 'bun:test';
import type { SyncEvent } from '@taskara/db';
import { mapSyncEventForScope } from './sync';
import { syncCursor } from '../services/sync';
import type { RequestActor } from '../services/actor';

const actor = {
  workspace: { id: 'workspace-1' },
  user: { id: 'user-1' },
  role: 'MEMBER'
} as RequestActor;

const baseEvent = {
  id: 'event-1',
  workspaceId: 'workspace-1',
  workspaceSeq: BigInt(7),
  entityType: 'task',
  entityId: 'task-1',
  operation: 'updated',
  entityVersion: 2,
  actorId: 'user-2',
  clientId: null,
  mutationId: null,
  createdAt: new Date('2026-04-26T00:00:00.000Z')
} satisfies Omit<SyncEvent, 'payload'>;

describe('sync event scope mapping', () => {
  test('upserts tasks that move into scope', () => {
    const event = syncEvent({
      before: task({ assignee: { id: 'user-2' } }),
      after: task({ assignee: { id: 'user-1' } })
    });

    const mapped = mapSyncEventForScope(event, syncQuery({ mine: true }), actor, null);

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
    expect(mapped && 'task' in mapped ? mapped.task?.id : null).toBe('task-1');
  });

  test('removes tasks that move out of scope without deleting globally', () => {
    const event = syncEvent({
      before: task({ assignee: { id: 'user-1' } }),
      after: task({ assignee: { id: 'user-2' } })
    });

    const mapped = mapSyncEventForScope(event, syncQuery({ mine: true }), actor, null);

    expect((mapped as { type?: string } | null)?.type).toBe('removeFromScope');
    expect(mapped && 'taskId' in mapped ? mapped.taskId : null).toBe('task-1');
  });

  test('deletes visible tasks when delete tombstone arrives', () => {
    const event = syncEvent({ before: task({ assignee: { id: 'user-1' } }) }, 'deleted');

    const mapped = mapSyncEventForScope(event, syncQuery({ mine: true }), actor, null);

    expect((mapped as { type?: string } | null)?.type).toBe('delete');
    expect(mapped && 'taskKey' in mapped ? mapped.taskKey : null).toBe('CORE-1');
  });

  test('filters events that are outside the requested team scope', () => {
    const event = syncEvent({ after: task({ project: { team: { slug: 'eng' } } }) });

    const mapped = mapSyncEventForScope(event, syncQuery({ teamId: 'ops' }), actor, null);

    expect(mapped).toBeNull();
  });

  test('filters completed tasks outside the hot bootstrap window', () => {
    const event = syncEvent({
      after: task({
        status: 'DONE',
        completedAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      })
    });

    const mapped = mapSyncEventForScope(event, syncQuery({ completedWindowDays: 5 }), actor, null);

    expect(mapped).toBeNull();
  });

  test('keeps recently completed tasks in the hot bootstrap window', () => {
    const event = syncEvent({
      after: task({
        status: 'DONE',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    });

    const mapped = mapSyncEventForScope(event, syncQuery({ completedWindowDays: 5 }), actor, null);

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
  });

  test('keeps manager events visible for workspace-wide access', () => {
    const event = syncEvent(
      { after: { id: 'attention-1', assigneeId: 'user-2', entityType: 'task', entityId: 'task-1' } },
      'updated',
      'attention'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, workspaceWideAccess());

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
    expect(mapped && 'entity' in mapped ? (mapped.entity as { id?: string }).id : null).toBe('attention-1');
  });

  test('keeps member-owned attention events visible', () => {
    const event = syncEvent(
      { after: { id: 'attention-1', assigneeId: 'user-1', entityType: 'task', entityId: 'task-1' } },
      'updated',
      'attention'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess());

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
  });

  test('filters restricted attention events for members', () => {
    const event = syncEvent(
      { after: { id: 'attention-1', assigneeId: 'user-2', entityType: 'task', entityId: 'task-1' } },
      'updated',
      'attention'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess());

    expect(mapped).toBeNull();
  });

  test('keeps review events when actor is the reviewer', () => {
    const event = syncEvent(
      { after: { id: 'review-1', taskId: 'task-1', requesterId: 'user-2', reviewerId: 'user-1' } },
      'created',
      'review'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess());

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
  });

  test('filters review events when neither participant nor task scope is visible', () => {
    const event = syncEvent(
      {
        after: {
          id: 'review-1',
          taskId: 'task-1',
          requesterId: 'user-2',
          reviewerId: 'user-3',
          task: { id: 'task-1', project: { id: 'project-2', team: { id: 'team-private' } } }
        }
      },
      'created',
      'review'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess({ teamIds: ['team-public'] }));

    expect(mapped).toBeNull();
  });

  test('keeps own check-in events for members', () => {
    const event = syncEvent(
      { after: { id: 'check-in-1', userId: 'user-1', authorId: 'user-1' } },
      'created',
      'check_in'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess());

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
  });

  test('filters another member check-in event', () => {
    const event = syncEvent(
      { after: { id: 'check-in-1', userId: 'user-2', authorId: 'user-2' } },
      'created',
      'check_in'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess());

    expect(mapped).toBeNull();
  });

  test('keeps project health updates for accessible project leads', () => {
    const event = syncEvent(
      {
        after: {
          id: 'update-1',
          projectId: 'project-1',
          project: { id: 'project-1', teamId: 'team-private', leadId: 'user-1' }
        }
      },
      'created',
      'project_health_update'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess({ projectIds: ['project-1'] }));

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
  });

  test('filters project health updates for inaccessible projects', () => {
    const event = syncEvent(
      {
        after: {
          id: 'update-1',
          projectId: 'project-2',
          project: { id: 'project-2', teamId: 'team-private', leadId: 'user-2' }
        }
      },
      'created',
      'project_health_update'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess({ teamIds: ['team-public'] }));

    expect(mapped).toBeNull();
  });

  test('keeps meeting action items when the actor participates in the meeting', () => {
    const event = syncEvent(
      {
        after: {
          id: 'action-1',
          assigneeId: 'user-2',
          meeting: { id: 'meeting-1', participants: [{ userId: 'user-1' }] }
        }
      },
      'created',
      'meeting_action_item'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess());

    expect((mapped as { type?: string } | null)?.type).toBe('upsert');
  });

  test('filters one-on-one agenda items when non-admin access cannot be proven from the payload', () => {
    const event = syncEvent(
      { after: { id: 'agenda-1', seriesId: 'series-1', createdById: 'user-2' } },
      'created',
      'one_on_one_agenda_item'
    );

    const mapped = mapSyncEventForScope(event, syncQuery(), actor, memberAccess());

    expect(mapped).toBeNull();
  });
});

describe('sync cursor serialization', () => {
  test('serializes bigint cursors as decimal strings', () => {
    expect(syncCursor(BigInt('9007199254740993'))).toBe('9007199254740993');
  });

  test('normalizes empty cursors to zero', () => {
    expect(syncCursor(undefined)).toBe('0');
    expect(syncCursor(null)).toBe('0');
    expect(syncCursor('')).toBe('0');
  });
});

function syncEvent(payload: Record<string, unknown>, operation = 'updated', entityType = 'task'): SyncEvent {
  return {
    ...baseEvent,
    entityType,
    operation,
    payload: payload as SyncEvent['payload']
  };
}

function syncQuery(overrides: Partial<Parameters<typeof mapSyncEventForScope>[1]> = {}) {
  return {
    scope: 'tasks' as const,
    teamId: 'all',
    cursor: '0',
    limit: 200,
    completedWindowDays: 5,
    ...overrides
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    key: 'CORE-1',
    title: 'Task',
    status: 'TODO',
    updatedAt: '2026-04-26T00:00:00.000Z',
    project: { team: { slug: 'ops' } },
    assignee: null,
    ...overrides
  };
}

function workspaceWideAccess(): {
  workspaceId: string;
  userId: string;
  workspaceWide: boolean;
  teamIds: string[];
  projectIds: string[];
} {
  return {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    workspaceWide: true,
    teamIds: [],
    projectIds: []
  };
}

function memberAccess(overrides: Partial<ReturnType<typeof workspaceWideAccess>> = {}) {
  return {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    workspaceWide: false,
    teamIds: [],
    projectIds: [],
    ...overrides
  };
}
