import { describe, expect, test } from 'bun:test';
import type { RequestActor } from './actor';
import { canManageTaskReview } from './task-reviews';

function actor(userId: string, role: RequestActor['role'] = 'MEMBER'): Pick<RequestActor, 'role' | 'user'> {
  return {
    role,
    user: { id: userId }
  } as Pick<RequestActor, 'role' | 'user'>;
}

function review(overrides: Partial<Parameters<typeof canManageTaskReview>[1]> = {}): Parameters<typeof canManageTaskReview>[1] {
  return {
    requesterId: 'requester',
    reviewerId: 'reviewer',
    task: {
      assigneeId: 'assignee',
      reporterId: 'reporter'
    },
    ...overrides
  };
}

describe('task review management policy', () => {
  test('allows requester, reviewer, assignee, reporter, and workspace admins to manage review assignment', () => {
    expect(canManageTaskReview(actor('requester'), review())).toBe(true);
    expect(canManageTaskReview(actor('reviewer'), review())).toBe(true);
    expect(canManageTaskReview(actor('assignee'), review())).toBe(true);
    expect(canManageTaskReview(actor('reporter'), review())).toBe(true);
    expect(canManageTaskReview(actor('admin', 'ADMIN'), review())).toBe(true);
    expect(canManageTaskReview(actor('owner', 'OWNER'), review())).toBe(true);
  });

  test('rejects unrelated task viewers', () => {
    expect(canManageTaskReview(actor('visible-but-unrelated'), review())).toBe(false);
  });
});
