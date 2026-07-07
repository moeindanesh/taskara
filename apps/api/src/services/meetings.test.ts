import { describe, expect, test } from 'bun:test';
import type { RequestActor } from './actor';
import { canAccessMeeting, type MeetingAccessScope } from './meetings';

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
    const scope: MeetingAccessScope = { memberTeamIds: [], memberProjectIds: [] };

    expect(canAccessMeeting(actor('user-participant', 'MEMBER'), meeting, scope)).toBe(true);
  });

  test('allows workspace admins and rejects unrelated members', () => {
    const scope: MeetingAccessScope = { memberTeamIds: [], memberProjectIds: [] };
    expect(canAccessMeeting(actor('user-admin', 'ADMIN'), { participants: [] }, scope)).toBe(true);
    expect(canAccessMeeting(actor('user-owner', 'OWNER'), { participants: [] }, scope)).toBe(true);
    expect(canAccessMeeting(actor('user-other', 'MEMBER'), { participants: [] }, scope)).toBe(false);
  });

  test('allows owned/created meetings for any user', () => {
    const actorManager = actor('user-manager', 'MEMBER');
    const scope: MeetingAccessScope = { memberTeamIds: ['team-1'], memberProjectIds: ['project-1'] };

    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], ownerId: 'user-manager' },
        scope
      )
    ).toBe(true);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], createdById: 'user-manager' },
        scope
      )
    ).toBe(true);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], teamId: 'team-1' },
        scope
      )
    ).toBe(false);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], projectId: 'project-1' },
        scope
      )
    ).toBe(false);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], project: { teamId: 'team-1' } },
        scope
      )
    ).toBe(false);
    expect(
      canAccessMeeting(
        actorManager,
        { participants: [], teamId: 'team-2', projectId: 'project-2', ownerId: 'user-other', createdById: 'user-other' },
        scope
      )
    ).toBe(false);

    expect(canAccessMeeting(actor('user-admin', 'ADMIN'), { participants: [], teamId: 'team-2' }, scope)).toBe(true);
  });

  test('owner is global workspace meeting viewer', () => {
    const ownerScope: MeetingAccessScope = { memberTeamIds: [], memberProjectIds: [] };
    expect(
      canAccessMeeting(actor('user-owner', 'OWNER'), { participants: [], ownerId: 'user-owner' }, ownerScope)
    ).toBe(true);
    expect(
      canAccessMeeting(actor('user-owner', 'OWNER'), { participants: [], ownerId: 'user-other' }, ownerScope)
    ).toBe(true);
  });
});
