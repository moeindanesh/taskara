import { describe, expect, test } from 'bun:test';
import type { TaskaraMilestone } from '@/lib/taskara-types';
import { allowedLifecycleActions, primaryLifecycleAction } from './milestone-detail';
import { compareMilestones } from './milestones-view';
import { isMilestoneOverdue } from './primitives';

function milestone(overrides: Partial<TaskaraMilestone> = {}): TaskaraMilestone {
   return {
      id: overrides.id || crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      projectId: overrides.projectId || crypto.randomUUID(),
      ownerId: null,
      name: 'گام',
      description: null,
      kind: 'FEATURE',
      status: 'PLANNED',
      health: null,
      startsOn: null,
      targetOn: null,
      position: 1024,
      version: 1,
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-01T10:00:00.000Z',
      project: {
         id: overrides.projectId || crypto.randomUUID(),
         name: 'پروژه',
         keyPrefix: 'PROJ',
      },
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

describe('milestone lifecycle presentation', () => {
   test('exposes only contract-valid actions for each lifecycle state', () => {
      expect(allowedLifecycleActions(milestone({ status: 'PLANNED' }))).toEqual(['activate', 'complete', 'cancel']);
      expect(allowedLifecycleActions(milestone({ status: 'ACTIVE' }))).toEqual(['complete', 'cancel']);
      expect(allowedLifecycleActions(milestone({ status: 'COMPLETED' }))).toEqual(['reopen', 'archive']);
      expect(allowedLifecycleActions(milestone({ status: 'CANCELED' }))).toEqual(['activate', 'archive']);
      expect(allowedLifecycleActions(milestone({ status: 'COMPLETED', archivedAt: '2026-07-11T10:00:00.000Z' }))).toEqual(['restore']);
   });

   test('chooses the contextual lifecycle action without auto-completing', () => {
      expect(primaryLifecycleAction(milestone({ status: 'PLANNED', progress: { ...milestone().progress, percentage: 100 } }))).toBe('activate');
      expect(primaryLifecycleAction(milestone({ status: 'ACTIVE' }))).toBe('complete');
      expect(primaryLifecycleAction(milestone({ status: 'COMPLETED' }))).toBe('reopen');
      expect(primaryLifecycleAction(milestone({ status: 'CANCELED' }))).toBe('activate');
   });
});

describe('milestone hub ordering', () => {
   test('puts overdue open milestones ahead of healthier milestones', () => {
      const overdue = milestone({ id: 'overdue', targetOn: '2000-01-01' });
      const offTrack = milestone({ id: 'off-track', health: 'OFF_TRACK', targetOn: '2999-01-01' });
      expect([offTrack, overdue].sort(compareMilestones).map((item) => item.id)).toEqual(['overdue', 'off-track']);
   });

   test('orders health, target date, then manual position within a project', () => {
      const projectId = crypto.randomUUID();
      const items = [
         milestone({ id: 'later-position', projectId, health: 'ON_TRACK', targetOn: '2999-02-01', position: 2048 }),
         milestone({ id: 'at-risk', projectId, health: 'AT_RISK', targetOn: '2999-03-01', position: 4096 }),
         milestone({ id: 'earlier-position', projectId, health: 'ON_TRACK', targetOn: '2999-02-01', position: 1024 }),
      ];
      expect(items.sort(compareMilestones).map((item) => item.id)).toEqual(['at-risk', 'earlier-position', 'later-position']);
   });

   test('never reports terminal milestones overdue', () => {
      expect(isMilestoneOverdue(milestone({ status: 'COMPLETED', targetOn: '2000-01-01' }))).toBeFalse();
      expect(isMilestoneOverdue(milestone({ status: 'CANCELED', targetOn: '2000-01-01' }))).toBeFalse();
   });

   test('uses the same UTC boundary as the server for date-only targets', () => {
      const due = milestone({ targetOn: '2026-07-10', status: 'ACTIVE' });
      expect(isMilestoneOverdue(due, new Date('2026-07-10T23:59:59.999Z'))).toBeFalse();
      expect(isMilestoneOverdue(due, new Date('2026-07-11T00:00:00.000Z'))).toBeTrue();
   });
});
