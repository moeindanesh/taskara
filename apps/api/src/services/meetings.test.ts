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
  test('allows participants regardless of management scope', () => {
    const meeting = {
      participants: [{ userId: 'user-participant' }]
    };

    expect(canAccessMeeting(actor('user-participant', 'MEMBER'), meeting)).toBe(true);
  });

  test('allows workspace admins and rejects unrelated members', () => {
    expect(canAccessMeeting(actor('user-admin', 'ADMIN'), { participants: [] })).toBe(true);
    expect(canAccessMeeting(actor('user-owner', 'OWNER'), { participants: [] })).toBe(true);
    expect(canAccessMeeting(actor('user-other', 'MEMBER'), { participants: [] })).toBe(false);
  });

  test('allows owned/created meetings for any user', () => {
    const actorManager = actor('user-manager', 'MEMBER');

    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], ownerId: 'user-manager' }
      )
    ).toBe(true);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], createdById: 'user-manager' }
      )
    ).toBe(true);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], teamId: 'team-1' }
      )
    ).toBe(false);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], projectId: 'project-1' }
      )
    ).toBe(false);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], project: { teamId: 'team-1' } }
      )
    ).toBe(false);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], teamId: 'team-2', projectId: 'project-2', ownerId: 'user-other', createdById: 'user-other' }
      )
    ).toBe(false);

    expect(canAccessMeeting(actor('user-admin', 'ADMIN'), { participants: [], teamId: 'team-2' })).toBe(true);
  });

  test('owner is global workspace meeting viewer', () => {
    expect(
      canAccessMeeting(actor('user-owner', 'OWNER'), { participants: [], ownerId: 'user-owner' })
    ).toBe(true);
    expect(
      canAccessMeeting(actor('user-owner', 'OWNER'), { participants: [], ownerId: 'user-other' })
    ).toBe(true);
  });
});
