import { describe, expect, test } from 'bun:test';
import {
  dedupeAgendaCandidates,
  diffPlannedTasks,
  latestCheckInByUser,
  taskTargetFromMeetingActionItem,
  type AgendaCandidate
} from './check-ins';

describe('plan versus done diffing', () => {
  test('marks planned task keys as done or slipped based on what was reported', () => {
    const diff = diffPlannedTasks('فردا TSK-1 و TSK-2 را تمام می‌کنم', 'TSK-1 تمام شد، روی چیز دیگری وقت گذاشتم');

    expect(diff).toEqual([
      { key: 'TSK-1', status: 'done' },
      { key: 'TSK-2', status: 'slipped' }
    ]);
  });

  test('stays empty when the plan named no task keys, rather than guessing from prose', () => {
    expect(diffPlannedTasks('یک‌سری کار متفرقه', 'TSK-9 تمام شد')).toEqual([]);
    expect(diffPlannedTasks(null, null)).toEqual([]);
  });

  test('ignores completed keys that were never planned', () => {
    const diff = diffPlannedTasks('TSK-1', 'TSK-1 و TSK-5 تمام شدند');

    expect(diff).toEqual([{ key: 'TSK-1', status: 'done' }]);
  });
});

describe('check-in and one-on-one helpers', () => {
  test('keeps latest check-in by submitted date per user', () => {
    const latest = latestCheckInByUser([
      { userId: 'user-1', submittedFor: new Date('2026-07-04T10:00:00.000Z') },
      { userId: 'user-1', submittedFor: new Date('2026-07-05T10:00:00.000Z') },
      { userId: 'user-2', submittedFor: new Date('2026-07-03T10:00:00.000Z') }
    ]);

    expect(latest.get('user-1')?.toISOString()).toBe('2026-07-05T10:00:00.000Z');
    expect(latest.get('user-2')?.toISOString()).toBe('2026-07-03T10:00:00.000Z');
  });

  test('dedupes generated agenda candidates by source identity', () => {
    const candidates: AgendaCandidate[] = [
      candidate('attention', 'a-1', 'First'),
      candidate('attention', 'a-1', 'Duplicate'),
      candidate('blocked_task', 'task-1', 'Task')
    ];

    expect(dedupeAgendaCandidates(candidates).map((item) => item.title)).toEqual(['First', 'Task']);
  });

  test('creates executable task when action item has an explicit or meeting project', () => {
    expect(taskTargetFromMeetingActionItem('project-input', 'project-meeting', 'project-default')).toEqual({
      projectId: 'project-input',
      status: 'TODO'
    });
    expect(taskTargetFromMeetingActionItem(undefined, 'project-meeting', 'project-default')).toEqual({
      projectId: 'project-meeting',
      status: 'TODO'
    });
  });

  test('falls back to backlog when action item has no project context', () => {
    expect(taskTargetFromMeetingActionItem(undefined, null, 'project-default')).toEqual({
      projectId: 'project-default',
      status: 'BACKLOG'
    });
  });
});

function candidate(sourceType: AgendaCandidate['sourceType'], sourceId: string, title: string): AgendaCandidate {
  return {
    sourceType,
    sourceId,
    title,
    severity: 'MEDIUM'
  };
}
