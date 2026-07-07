import { describe, expect, test } from 'bun:test';
import type { WorkspaceRole } from '@taskara/db';
import {
  buildAssignmentRecommendations,
  eligibleAssignmentCandidates,
  type AssignmentCandidateFacts
} from './assignment';

const now = new Date('2026-07-05T12:00:00.000Z');

describe('assignment recommendation rules', () => {
  test('filters inactive, unsupported role, and outside-team candidates', () => {
    const result = eligibleAssignmentCandidates(
      [
        candidate('team-member', { teamIds: ['team-1'] }),
        candidate('inactive', { active: false, teamIds: ['team-1'] }),
        candidate('guest', { workspaceRole: 'GUEST', teamIds: ['team-1'] }),
        candidate('outside-team', { teamIds: ['team-2'] })
      ],
      { projectId: 'project-1', projectTeamId: 'team-1' }
    );

    expect(result.candidates.map((item) => item.user.id)).toEqual(['team-member']);
    expect(result.excluded).toEqual({
      inactive: 1,
      unsupportedRole: 1,
      outsideProjectMembership: 1
    });
  });

  test('keeps overloaded candidates visible with warning reasons', () => {
    const [recommendation] = buildAssignmentRecommendations(
      [
        candidate('overloaded', {
          activeCount: 6,
          activeWeight: 10,
          capacity: 8,
          reviewCount: 2,
          blockedCount: 1
        })
      ],
      context()
    );

    expect(recommendation?.status).toBe('overloaded');
    expect(recommendation?.reasons.map((reason) => reason.code)).toContain('over_capacity');
    expect(recommendation?.reasons.map((reason) => reason.code)).toContain('blocked_load');
  });

  test('prioritizes capacity and project context over raw task count alone', () => {
    const recommendations = buildAssignmentRecommendations(
      [
        candidate('available', { activeCount: 1, activeWeight: 1, capacity: 8 }),
        candidate('context-heavy', { activeCount: 2, activeWeight: 2, capacity: 8, projectActiveCount: 2 }),
        candidate('busy', { activeCount: 4, activeWeight: 7, capacity: 8 })
      ],
      context({ weight: 2 })
    );

    expect(recommendations[0]?.user.id).toBe('context-heavy');
    expect(recommendations[0]?.reasons.map((reason) => reason.code)).toContain('project_context');
    expect(recommendations.at(-1)?.user.id).toBe('busy');
  });

  test('treats zero capacity as unavailable instead of dividing by zero', () => {
    const [recommendation] = buildAssignmentRecommendations(
      [candidate('zero-capacity', { capacity: 0 })],
      context()
    );

    expect(recommendation?.status).toBe('unavailable');
    expect(Number.isFinite(recommendation?.projectedLoadRatio)).toBe(true);
    expect(recommendation?.reasons.map((reason) => reason.code)).toContain('zero_capacity');
  });
});

function context(overrides: Partial<Parameters<typeof buildAssignmentRecommendations>[1]> = {}): Parameters<typeof buildAssignmentRecommendations>[1] {
  return {
    projectId: 'project-1',
    projectTeamId: 'team-1',
    weight: 1,
    priority: 'MEDIUM',
    now,
    activeWipLimit: null,
    reviewWipLimit: null,
    ...overrides
  };
}

function candidate(id: string, overrides: Partial<AssignmentCandidateFacts> = {}): AssignmentCandidateFacts {
  return {
    user: {
      id,
      name: `User ${id}`,
      email: `${id}@example.test`,
      phone: null,
      mattermostUsername: null,
      avatarUrl: null
    },
    workspaceRole: 'MEMBER' as WorkspaceRole,
    teamIds: [],
    projectIds: [],
    capacity: 8,
    active: true,
    activeCount: 0,
    activeWeight: 0,
    reviewCount: 0,
    blockedCount: 0,
    overdueCount: 0,
    dueSoonCount: 0,
    projectActiveCount: 0,
    ...overrides
  };
}
