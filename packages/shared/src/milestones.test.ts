import { describe, expect, test } from 'bun:test';
import {
  createMilestoneSchema,
  createTaskSchema,
  milestoneCompletionSchema,
  milestoneDateSchema,
  milestoneListQuerySchema,
  taskViewStateSchema,
  updateMilestoneSchema,
  updateTaskSchema
} from './index';

const projectId = '00000000-0000-4000-8000-000000000001';
const milestoneId = '00000000-0000-4000-8000-000000000002';

describe('milestone shared contracts', () => {
  test('validates real date-only values without timezone coercion', () => {
    expect(milestoneDateSchema.parse('2026-07-11')).toBe('2026-07-11');
    expect(milestoneDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(milestoneDateSchema.safeParse('2024-02-29').success).toBe(true);
    expect(milestoneDateSchema.safeParse('2026-7-1').success).toBe(false);
  });

  test('defaults creation to planned and rejects invalid metadata and ranges', () => {
    const parsed = createMilestoneSchema.parse({ projectId, name: 'Beta', kind: 'FEATURE' });
    expect(parsed.status).toBe('PLANNED');
    expect(createMilestoneSchema.parse({ id: milestoneId, projectId, name: 'Beta', kind: 'FEATURE' }).id).toBe(milestoneId);
    expect(createMilestoneSchema.safeParse({ id: 'local-id', projectId, name: 'Beta', kind: 'FEATURE' }).success).toBe(false);
    expect(createMilestoneSchema.safeParse({ projectId, name: 'Beta', kind: 'RELEASE' }).success).toBe(false);
    expect(createMilestoneSchema.safeParse({
      projectId,
      name: 'Beta',
      kind: 'FEATURE',
      health: 'UNKNOWN'
    }).success).toBe(false);
    expect(createMilestoneSchema.safeParse({
      projectId,
      name: 'Beta',
      kind: 'FEATURE',
      startsOn: '2026-08-01',
      targetOn: '2026-07-01'
    }).success).toBe(false);
  });

  test('requires an optimistic version and at least one metadata patch', () => {
    expect(updateMilestoneSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateMilestoneSchema.safeParse({ version: 1, targetOn: null }).success).toBe(true);
    expect(updateMilestoneSchema.safeParse({ version: 0, name: 'Nope' }).success).toBe(false);
  });

  test('requires MOVE targets and forbids stray target ids for completion policies', () => {
    expect(milestoneCompletionSchema.safeParse({ unfinishedTaskPolicy: 'MOVE' }).success).toBe(false);
    expect(milestoneCompletionSchema.safeParse({
      unfinishedTaskPolicy: 'MOVE',
      targetMilestoneId: milestoneId
    }).success).toBe(true);
    expect(milestoneCompletionSchema.safeParse({
      unfinishedTaskPolicy: 'KEEP',
      targetMilestoneId: milestoneId
    }).success).toBe(false);
  });

  test('parses list booleans and comma-separated lifecycle filters strictly', () => {
    expect(milestoneListQuerySchema.parse({ status: 'PLANNED,ACTIVE', overdue: 'true', archivedOnly: 'true' })).toMatchObject({
      status: ['PLANNED', 'ACTIVE'],
      overdue: true,
      includeArchived: false,
      archivedOnly: true
    });
    expect(milestoneListQuerySchema.safeParse({ overdue: 'yes' }).success).toBe(false);
    expect(milestoneListQuerySchema.safeParse({ archivedOnly: 'yes' }).success).toBe(false);
  });

  test('supports optional task relations and preserves old saved-view defaults', () => {
    expect(createTaskSchema.parse({ projectId, title: 'Task', milestoneId }).milestoneId).toBe(milestoneId);
    expect(updateTaskSchema.parse({ milestoneId: null }).milestoneId).toBeNull();
    expect(taskViewStateSchema.parse({}).milestoneIds).toEqual([]);
    expect(taskViewStateSchema.parse({ milestoneIds: [milestoneId, 'no-milestone'] }).milestoneIds).toEqual([
      milestoneId,
      'no-milestone'
    ]);
  });
});
