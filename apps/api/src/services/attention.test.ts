import { describe, expect, test } from 'bun:test';
import type { AttentionItem } from '@taskara/db';
import {
  attentionCandidateFromWorkHealth,
  attentionCandidatesFromDecisionQueues,
  isCheckInMissing,
  isMeetingActionItemStale,
  isOneOnOneDue,
  shouldReopenAttention,
  trackedAttentionReasons
} from './attention';
import type { WorkHealthAttentionItem, WorkHealthSummary } from './work-health';

const now = new Date('2026-07-05T12:00:00.000Z');

describe('attention lifecycle rules', () => {
  test('manual resolution does not reopen while the same condition is still present', () => {
    const candidate = candidateFromDueAt('2026-07-04T12:00:00.000Z');
    const item = attentionItem({
      status: 'RESOLVED',
      resolvedAt: now,
      payload: candidate.payload as unknown as AttentionItem['payload']
    });

    expect(shouldReopenAttention(item, candidate)).toBe(false);
  });

  test('resolved item reopens after the condition clears and appears again', () => {
    const candidate = candidateFromDueAt('2026-07-04T12:00:00.000Z');
    const item = attentionItem({
      status: 'RESOLVED',
      resolvedAt: new Date('2026-07-05T12:00:00.000Z'),
      payload: {
        ...candidate.payload,
        lifecycle: { lastClearedAt: '2026-07-05T15:00:00.000Z' }
      } as unknown as AttentionItem['payload']
    });

    expect(shouldReopenAttention(item, candidate)).toBe(true);
  });

  test('dismissed item stays dismissed for the same material condition and reopens for a changed one', () => {
    const first = candidateFromDueAt('2026-07-04T12:00:00.000Z');
    const same = candidateFromDueAt('2026-07-04T12:00:00.000Z');
    const changed = candidateFromDueAt('2026-07-03T12:00:00.000Z');
    const item = attentionItem({
      status: 'DISMISSED',
      dismissedAt: now,
      payload: first.payload as unknown as AttentionItem['payload']
    });

    expect(shouldReopenAttention(item, same)).toBe(false);
    expect(shouldReopenAttention(item, changed)).toBe(true);
  });

  test('serializes project health attention with project lead as assignee', () => {
    const candidate = attentionCandidateFromWorkHealth('workspace-1', {
      id: 'project:project-1:at-risk',
      reason: 'project_at_risk',
      severity: 'HIGH',
      title: 'Website rebuild',
      description: 'Launch risk needs a decision',
      actionLabel: 'Open project',
      entityType: 'project',
      project: {
        id: 'project-1',
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        parentId: null,
        leadId: 'user-lead',
        name: 'Website rebuild',
        keyPrefix: 'WEB',
        description: null,
        status: 'ACTIVE',
        nextTaskNumber: 12,
        createdAt: new Date('2026-07-01T12:00:00.000Z'),
        updatedAt: new Date('2026-07-05T10:00:00.000Z'),
        team: { id: 'team-1', name: 'Growth', slug: 'growth' },
        lead: { id: 'user-lead', name: 'Mina', email: 'mina@example.test', avatarUrl: null },
        healthUpdates: [
          {
            id: 'update-1',
            health: 'OFF_TRACK',
            summary: 'Launch is blocked by copy approval.',
            risks: 'Approval delay',
            decisionsNeeded: 'Pick launch scope',
            nextUpdateDueAt: new Date('2026-07-06T12:00:00.000Z'),
            createdAt: new Date('2026-07-05T10:00:00.000Z')
          }
        ]
      } as WorkHealthAttentionItem['project']
    }, now);

    expect(candidate.entityType).toBe('project');
    expect(candidate.entityId).toBe('project-1');
    expect(candidate.assigneeId).toBe('user-lead');
    expect(candidate.payload.project?.healthUpdate?.health).toBe('OFF_TRACK');
  });

  test('tracks every generated manager attention reason', () => {
    expect(trackedAttentionReasons).toContain('backlog_triage');
    expect(trackedAttentionReasons).toContain('project_at_risk');
    expect(trackedAttentionReasons).toContain('project_update_due');
    expect(trackedAttentionReasons).toContain('missing_check_in');
    expect(trackedAttentionReasons).toContain('one_on_one_due');
    expect(trackedAttentionReasons).toContain('stale_meeting_action_item');
  });

  test('projects fresh reviews and backlog triage into the manager attention queue', () => {
    const candidates = attentionCandidatesFromDecisionQueues('workspace-1', {
      review: [decisionTask({
        id: 'review-task',
        key: 'OPS-2',
        status: 'IN_REVIEW',
        activeReviewRequest: {
          id: 'review-1',
          reviewerId: 'manager-1',
          requestedAt: '2026-07-05T11:00:00.000Z',
          dueAt: null
        }
      })],
      backlog: [decisionTask({ id: 'backlog-task', key: 'OPS-3', status: 'BACKLOG' })]
    }, now);

    expect(candidates.map((candidate) => candidate.reason)).toEqual(['review_waiting', 'backlog_triage']);
    expect(candidates[0]?.severity).toBe('LOW');
    expect(candidates[1]?.payload.actionLabel).toBe('تصمیم تریاژ');
  });

  test('uses fixed cadence thresholds for check-ins and 1:1s', () => {
    expect(isCheckInMissing(new Date('2026-07-04T13:00:00.000Z'), now)).toBe(false);
    expect(isCheckInMissing(new Date('2026-07-04T12:00:00.000Z'), now)).toBe(true);
    expect(isOneOnOneDue(new Date('2026-07-12T12:00:00.000Z'), now)).toBe(true);
    expect(isOneOnOneDue(new Date('2026-07-13T12:00:00.000Z'), now)).toBe(false);
    expect(isOneOnOneDue(null, now)).toBe(true);
  });

  test('stales only open unlinked meeting action items', () => {
    expect(isMeetingActionItemStale({ status: 'OPEN', dueAt: new Date('2026-07-05T11:00:00.000Z'), createdAt: now }, now)).toBe(true);
    expect(isMeetingActionItemStale({ status: 'OPEN', dueAt: new Date('2026-07-05T13:00:00.000Z'), createdAt: now }, now)).toBe(false);
    expect(isMeetingActionItemStale({ status: 'OPEN', dueAt: null, createdAt: new Date('2026-06-28T12:00:00.000Z') }, now)).toBe(true);
    expect(isMeetingActionItemStale({ status: 'DONE', dueAt: new Date('2026-07-04T12:00:00.000Z'), createdAt: now }, now)).toBe(false);
    expect(isMeetingActionItemStale({ status: 'OPEN', taskId: 'task-1', dueAt: new Date('2026-07-04T12:00:00.000Z'), createdAt: now }, now)).toBe(false);
  });
});

function candidateFromDueAt(dueAt: string) {
  return attentionCandidateFromWorkHealth('workspace-1', {
    id: 'task:task-1:overdue',
    reason: 'overdue_task',
    severity: 'HIGH',
    title: 'OPS-1: Follow up',
    description: 'Overdue',
    actionLabel: 'Open task',
    entityType: 'task',
    dueAt,
    task: {
      id: 'task-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      cycleId: null,
      parentId: null,
      key: 'OPS-1',
      sequence: 1,
      title: 'Follow up',
      description: null,
      status: 'TODO',
      priority: 'HIGH',
      weight: 1,
      assigneeId: 'user-1',
      reporterId: null,
      dueAt: new Date(dueAt),
      completedAt: null,
      source: 'WEB',
      version: 1,
      createdAt: new Date('2026-07-01T12:00:00.000Z'),
      updatedAt: new Date('2026-07-02T12:00:00.000Z'),
      progressStartedAt: null,
      project: {
        id: 'project-1',
        name: 'Operations',
        keyPrefix: 'OPS',
        parentId: null,
        team: { id: 'team-1', name: 'Ops', slug: 'ops' }
      },
      assignee: {
        id: 'user-1',
        name: 'Sara',
        email: 'sara@example.test',
        phone: null,
        mattermostUsername: null,
        avatarUrl: null
      },
      reporter: null,
      attachments: [],
      labels: [],
      triageState: null,
      _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 }
    } as WorkHealthAttentionItem['task']
  }, now);
}

function decisionTask(
  overrides: Partial<WorkHealthSummary['queues']['review'][number]> = {}
): WorkHealthSummary['queues']['review'][number] {
  return {
    id: 'decision-task',
    workspaceId: 'workspace-1',
    projectId: null,
    cycleId: null,
    parentId: null,
    key: 'OPS-1',
    sequence: 1,
    title: 'Manager decision',
    description: null,
    status: 'TODO',
    priority: 'MEDIUM',
    weight: 1,
    assigneeId: null,
    reporterId: null,
    dueAt: null,
    completedAt: null,
    source: 'WEB',
    version: 1,
    createdAt: new Date('2026-07-05T10:00:00.000Z'),
    updatedAt: new Date('2026-07-05T11:00:00.000Z'),
    progressStartedAt: null,
    activeReviewRequest: null,
    project: null,
    assignee: null,
    reporter: null,
    attachments: [],
    labels: [],
    triageState: null,
    _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 },
    ...overrides
  } as WorkHealthSummary['queues']['review'][number];
}

function attentionItem(overrides: Partial<AttentionItem>): AttentionItem {
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
    firstSeenAt: now,
    lastSeenAt: now,
    snoozedUntil: null,
    resolvedAt: null,
    dismissedAt: null,
    dismissalReason: null,
    payload: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as AttentionItem;
}
