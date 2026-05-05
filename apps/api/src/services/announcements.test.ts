import { describe, expect, test } from 'bun:test';
import type { RequestActor } from './actor';
import { canManageAnnouncement } from './announcements';

function actor(userId: string, role: RequestActor['role']): RequestActor {
  return {
    workspace: { id: 'workspace-1' },
    user: { id: userId },
    role
  } as RequestActor;
}

describe('announcement access', () => {
  test('allows admins and creators to manage announcements', () => {
    expect(canManageAnnouncement(actor('user-admin', 'ADMIN'), 'user-creator')).toBe(true);
    expect(canManageAnnouncement(actor('user-creator', 'MEMBER'), 'user-creator')).toBe(true);
  });

  test('rejects ordinary non-creators', () => {
    expect(canManageAnnouncement(actor('user-other', 'MEMBER'), 'user-creator')).toBe(false);
  });
});
