import { describe, expect, test } from 'bun:test';
import type { RequestActor } from './actor';
import { canAccessMeeting } from './meetings';

function actor(userId: string, role: RequestActor['role']): RequestActor {
  return {
    workspace: { id: 'workspace-1' },
    user: { id: userId },
    role
  } as RequestActor;
}

describe('meeting access', () => {
  test('allows admins, owners, creators, and participants', () => {
    const meeting = {
      ownerId: 'user-owner',
      createdById: 'user-creator',
      participants: [{ userId: 'user-participant' }]
    };

    expect(canAccessMeeting(actor('user-admin', 'ADMIN'), meeting)).toBe(true);
    expect(canAccessMeeting(actor('user-owner', 'MEMBER'), meeting)).toBe(true);
    expect(canAccessMeeting(actor('user-creator', 'MEMBER'), meeting)).toBe(true);
    expect(canAccessMeeting(actor('user-participant', 'MEMBER'), meeting)).toBe(true);
  });

  test('rejects unrelated members', () => {
    expect(canAccessMeeting(actor('user-other', 'MEMBER'), { participants: [] })).toBe(false);
  });
});
