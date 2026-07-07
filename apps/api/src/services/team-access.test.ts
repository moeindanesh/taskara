import { describe, expect, test } from 'bun:test';
import type { WorkspaceAccess } from './team-access';
import {
  canReadProject,
  canReadTeam,
  projectWhereForAccess,
  taskWhereForAccess,
  teamWhereForAccess,
  viewWhereForAccess
} from './team-access';

const workspaceAccess: WorkspaceAccess = {
  workspaceId: 'workspace-1',
  userId: 'user-admin',
  workspaceWide: true,
  teamIds: [],
  projectIds: []
};

const scopedAccess: WorkspaceAccess = {
  workspaceId: 'workspace-1',
  userId: 'user-member',
  workspaceWide: false,
  teamIds: ['team-1'],
  projectIds: ['project-direct']
};

describe('workspace access policy predicates', () => {
  test('workspace-wide actors get unrestricted workspace predicates', () => {
    expect(teamWhereForAccess(workspaceAccess)).toEqual({ workspaceId: 'workspace-1' });
    expect(projectWhereForAccess(workspaceAccess)).toEqual({ workspaceId: 'workspace-1' });
    expect(taskWhereForAccess(workspaceAccess)).toEqual({ workspaceId: 'workspace-1' });
    expect(viewWhereForAccess(workspaceAccess)).toEqual({ workspaceId: 'workspace-1' });
  });

  test('scoped actors can read their teams, unteamed projects, direct projects, and led projects', () => {
    expect(canReadTeam(scopedAccess, 'team-1')).toBe(true);
    expect(canReadTeam(scopedAccess, 'team-2')).toBe(false);
    expect(canReadTeam(scopedAccess, null)).toBe(true);

    expect(canReadProject(scopedAccess, { id: 'project-team', teamId: 'team-1' })).toBe(true);
    expect(canReadProject(scopedAccess, { id: 'project-direct', teamId: 'team-2' })).toBe(true);
    expect(canReadProject(scopedAccess, { id: 'project-led', teamId: 'team-2', leadId: 'user-member' })).toBe(true);
    expect(canReadProject(scopedAccess, { id: 'project-open', teamId: null })).toBe(true);
    expect(canReadProject(scopedAccess, { id: 'project-private', teamId: 'team-2' })).toBe(false);
  });

  test('scoped predicates include workspace, team, direct project, and lead access without becoming global', () => {
    expect(teamWhereForAccess(scopedAccess)).toEqual({
      workspaceId: 'workspace-1',
      id: { in: ['team-1'] }
    });
    expect(projectWhereForAccess(scopedAccess)).toEqual({
      workspaceId: 'workspace-1',
      OR: [
        { teamId: null },
        { leadId: 'user-member' },
        { teamId: { in: ['team-1'] } },
        { id: { in: ['project-direct'] } }
      ]
    });
    expect(taskWhereForAccess(scopedAccess)).toEqual({
      workspaceId: 'workspace-1',
      project: {
        OR: [
          { teamId: null },
          { leadId: 'user-member' },
          { teamId: { in: ['team-1'] } },
          { id: { in: ['project-direct'] } }
        ]
      }
    });
  });
});
