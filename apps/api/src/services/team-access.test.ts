import { describe, expect, test } from 'bun:test';
import type { WorkspaceAccess } from './team-access';
import {
  canManageProjectPlanningFromRoles,
  canReadProject,
  canReadTeam,
  projectWhereForAccess,
  taskWhereForAccess,
  teamWhereForAccess,
  viewWhereForAccess
} from './team-access';

const planningActor = (role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST' | 'AGENT', userId = 'user-member') => ({
  role,
  user: { id: userId }
}) as Parameters<typeof canManageProjectPlanningFromRoles>[0];

const planningProject = { id: 'project-1', teamId: 'team-1', leadId: 'user-lead' };

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

describe('milestone planning permission precedence', () => {
  test('allows workspace admins and the project lead', () => {
    expect(canManageProjectPlanningFromRoles(planningActor('OWNER'), planningProject, 'VIEWER', 'GUEST')).toBe(true);
    expect(canManageProjectPlanningFromRoles(planningActor('ADMIN'), planningProject, 'VIEWER', 'AGENT')).toBe(true);
    expect(canManageProjectPlanningFromRoles(planningActor('MEMBER', 'user-lead'), planningProject, 'VIEWER', 'GUEST')).toBe(true);
  });

  test('lets explicit project roles override team roles', () => {
    expect(canManageProjectPlanningFromRoles(planningActor('MEMBER'), planningProject, 'LEAD', 'GUEST')).toBe(true);
    expect(canManageProjectPlanningFromRoles(planningActor('AGENT'), planningProject, 'MEMBER', 'AGENT')).toBe(true);
    expect(canManageProjectPlanningFromRoles(planningActor('MEMBER'), planningProject, 'VIEWER', 'OWNER')).toBe(false);
  });

  test('allows writable team roles only when no explicit project role exists', () => {
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      expect(canManageProjectPlanningFromRoles(planningActor('MEMBER'), planningProject, undefined, role)).toBe(true);
    }
    for (const role of ['GUEST', 'AGENT'] as const) {
      expect(canManageProjectPlanningFromRoles(planningActor(role), planningProject, undefined, role)).toBe(false);
    }
  });

  test('keeps unteamed projects limited to admins, lead, or explicit writers', () => {
    const unteamed = { ...planningProject, teamId: null };
    expect(canManageProjectPlanningFromRoles(planningActor('MEMBER'), unteamed, undefined, 'OWNER')).toBe(false);
    expect(canManageProjectPlanningFromRoles(planningActor('MEMBER'), unteamed, 'MEMBER', undefined)).toBe(true);
  });
});
