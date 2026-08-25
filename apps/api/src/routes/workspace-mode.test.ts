import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { getRequestActor, type RequestActor } from '../services/actor';
import { createTask, ensureDefaultProject } from '../services/tasks';
import { workspaceRouteMode } from '../services/workspace-mode-routes';

let app: FastifyInstance;
let fixture: Awaited<ReturnType<typeof createFixture>>;

const emailDomain = 'workspace-mode.test';

describe('workspace mode spine', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    // Phase 1 has no production Support record routes yet. This probe exercises the same global
    // guard every future `/support/*` route inherits without pretending Cases already exist.
    app.get('/support/mode-probe', async (request) => {
      const actor = await getRequestActor(request);
      return { mode: actor.workspace.mode };
    });
    await app.ready();
    fixture = await createFixture(app);
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: [fixture.support.id, fixture.team.id] } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${emailDomain}` } } });
    await app.close();
  });

  test('creation defaults to TEAM and preserves an explicit SUPPORT mode in every workspace response', async () => {
    expect(fixture.supportCreate.workspace.mode).toBe('SUPPORT');
    expect(fixture.supportCreate.capabilities).toContain('support.cases');
    expect(fixture.supportCreate.permissions).toContain('support.setup');
    expect(fixture.teamCreate.workspace.mode).toBe('TEAM');
    expect(fixture.teamCreate.capabilities).toContain('team.tasks');

    const [authWorkspaces, workspaces] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/auth/workspaces',
        headers: { authorization: `Bearer ${fixture.token}` }
      }),
      app.inject({
        method: 'GET',
        url: '/workspaces',
        headers: { authorization: `Bearer ${fixture.token}` }
      })
    ]);
    expect(authWorkspaces.statusCode).toBe(200);
    expect(workspaces.statusCode).toBe(200);

    for (const response of [authWorkspaces, workspaces]) {
      const items = response.json().items as Array<{
        workspace: { slug: string; mode: string; capabilities: string[] };
        capabilities: string[];
        permissions: string[];
      }>;
      expect(items.find((item) => item.workspace.slug === fixture.support.slug)?.workspace.mode).toBe('SUPPORT');
      expect(items.find((item) => item.workspace.slug === fixture.team.slug)?.workspace.mode).toBe('TEAM');
      expect(items.find((item) => item.workspace.slug === fixture.support.slug)?.permissions).toContain('support.setup');
    }
  });

  test('/me returns server-derived capabilities and actor permissions for the URL workspace', async () => {
    const support = await injectIn('support', { method: 'GET', url: '/me' });
    expect(support.statusCode).toBe(200);
    expect(support.json().workspace.mode).toBe('SUPPORT');
    expect(support.json().workspace.capabilities).toEqual(support.json().capabilities);
    expect(support.json().capabilities).toContain('support.departments');
    expect(support.json().capabilities).not.toContain('team.tasks');
    expect(support.json().permissions).toContain('support.triage.read');

    const team = await injectIn('team', { method: 'GET', url: '/me' });
    expect(team.statusCode).toBe(200);
    expect(team.json().workspace.mode).toBe('TEAM');
    expect(team.json().capabilities).toContain('team.tasks');
    expect(team.json().capabilities).not.toContain('support.cases');
  });

  test('Team routes fail before validation or writes in SUPPORT while common routes remain available', async () => {
    const taskCount = await prisma.task.count({ where: { workspaceId: fixture.support.id } });
    const blocked = await injectIn('support', {
      method: 'POST',
      url: '/tasks',
      // Deliberately malformed: the mode gate must run before a Team payload is inspected.
      payload: { mode: 'TEAM' }
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain('only available in TEAM workspaces');
    expect(await prisma.task.count({ where: { workspaceId: fixture.support.id } })).toBe(taskCount);

    for (const url of [
      '/projects',
      '/sync/bootstrap',
      '/announcements',
      '/check-ins',
      '/raycast/scripts/open-taskara.bash'
    ]) {
      const response = await injectIn('support', { method: 'GET', url });
      expect(response.statusCode).toBe(409);
    }

    const users = await injectIn('support', { method: 'GET', url: '/users' });
    const notifications = await injectIn('support', { method: 'GET', url: '/notifications' });
    const knowledge = await injectIn('support', { method: 'GET', url: '/knowledge/spaces' });
    expect(users.statusCode).toBe(200);
    expect(notifications.statusCode).toBe(200);
    expect(knowledge.statusCode).toBe(200);
  });

  test('Support routes are refused in TEAM and accepted in SUPPORT', async () => {
    const team = await injectIn('team', { method: 'GET', url: '/support/mode-probe' });
    expect(team.statusCode).toBe(409);

    const support = await injectIn('support', { method: 'GET', url: '/support/mode-probe' });
    expect(support.statusCode).toBe(200);
    expect(support.json() as { mode: string }).toEqual({ mode: 'SUPPORT' });
  });

  test('mode and feature claims in a request body cannot change the server-owned workspace profile', async () => {
    const response = await injectIn('support', {
      method: 'PATCH',
      url: '/me',
      payload: {
        name: fixture.user.name,
        mode: 'TEAM',
        capabilities: ['team.tasks'],
        permissions: ['team.tasks.create']
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().workspace.mode).toBe('SUPPORT');
    expect(response.json().capabilities).not.toContain('team.tasks');

    const stored = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.support.id } });
    expect(stored.mode).toBe('SUPPORT');
  });

  test('an existing workspace cannot be recreated as another mode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/workspaces',
      headers: { authorization: `Bearer ${fixture.token}` },
      payload: { name: fixture.support.name, slug: fixture.support.slug, mode: 'TEAM' }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('Workspace mode cannot be changed after creation');
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.support.id } })).mode).toBe('SUPPORT');
  });

  test('Task service entry points reject SUPPORT before resolving a project or creating defaults', async () => {
    const actor: RequestActor = {
      workspace: fixture.support,
      user: fixture.user,
      role: 'OWNER',
      actorType: 'USER',
      actorRuntime: null,
      source: 'WEB'
    };

    await expect(ensureDefaultProject(fixture.support.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(createTask(actor, {
      projectId: crypto.randomUUID(),
      title: 'Must not be created',
      kind: 'WORK',
      status: 'TODO',
      priority: 'NO_PRIORITY',
      weight: null,
      labels: [],
      source: 'API'
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(await prisma.project.count({ where: { workspaceId: fixture.support.id } })).toBe(0);
    expect(await prisma.task.count({ where: { workspaceId: fixture.support.id } })).toBe(0);
  });

  test('unsupported agent and Mattermost clients fail before provisioning identities or defaults', async () => {
    const beforeAgents = await prisma.user.count({ where: { kind: 'AGENT', operatorId: fixture.user.id } });
    const beforeRuns = await prisma.agentRun.count({ where: { workspaceId: fixture.support.id } });
    const credential = await injectIn('support', {
      method: 'POST',
      url: '/agent-credentials/self',
      payload: { name: 'unsupported-mode-test' }
    });
    expect(credential.statusCode).toBe(409);
    expect(await prisma.user.count({ where: { kind: 'AGENT', operatorId: fixture.user.id } })).toBe(beforeAgents);

    const agentAction = await injectIn('support', {
      method: 'POST',
      url: '/agent/thread-to-tasks',
      payload: { text: 'create a task anyway' }
    });
    const aiAction = await injectIn('support', {
      method: 'POST',
      url: '/ai/tasks/refine',
      payload: { mode: 'TEAM' }
    });
    expect(agentAction.statusCode).toBe(409);
    expect(aiAction.statusCode).toBe(409);
    expect(await prisma.agentRun.count({ where: { workspaceId: fixture.support.id } })).toBe(beforeRuns);

    const mattermostUserId = `support-mm-${crypto.randomUUID()}`;
    const mattermost = await app.inject({
      method: 'POST',
      url: '/integrations/mattermost/command',
      payload: {
        workspace_slug: fixture.support.slug,
        user_id: mattermostUserId,
        user_name: mattermostUserId,
        text: 'create must-not-exist'
      }
    });
    expect(mattermost.statusCode).toBe(409);
    expect(mattermost.json().message).toContain('only available in TEAM workspaces');
    expect(await prisma.user.count({ where: { mattermostUserId } })).toBe(0);
    expect(await prisma.project.count({ where: { workspaceId: fixture.support.id } })).toBe(0);
  });

  test('the centralized route registry classifies every current product surface and fails closed', () => {
    expect(workspaceRouteMode('/health')).toBe('PUBLIC');
    expect(workspaceRouteMode('/auth/workspaces')).toBe('PUBLIC');
    expect(workspaceRouteMode('/me')).toBe('COMMON');
    expect(workspaceRouteMode('/knowledge/pages')).toBe('COMMON');
    expect(workspaceRouteMode('/tasks/:idOrKey')).toBe('TEAM');
    expect(workspaceRouteMode('/agent-credentials/self')).toBe('TEAM');
    expect(workspaceRouteMode('/support/cases')).toBe('SUPPORT');
    expect(workspaceRouteMode('/support/intake/:lookupId/events')).toBe('SUPPORT_INTAKE');
    expect(workspaceRouteMode('/integrations/mattermost/command')).toBe('TEAM_INTEGRATION');
    expect(workspaceRouteMode('/new-unclassified-domain')).toBe('UNCLASSIFIED');
  });

  test('omitted mode leaves existing Team HTTP behavior unchanged', async () => {
    const created = await injectIn('team', {
      method: 'POST',
      url: '/projects',
      payload: { name: 'Core', keyPrefix: `WM${crypto.randomUUID().slice(0, 4).toUpperCase()}` }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().workspaceId).toBe(fixture.team.id);
  });
});

async function createFixture(instance: FastifyInstance) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `owner-${suffix}@${emailDomain}`;
  const password = `mode-test-${crypto.randomUUID()}`;
  const registered = await instance.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { name: 'Mode Owner', email, password }
  });
  expect(registered.statusCode).toBe(201);

  const supportCreated = await instance.inject({
    method: 'POST',
    url: '/auth/workspaces',
    headers: { authorization: `Bearer ${registered.json().token}` },
    payload: { name: 'Support Desk', slug: `support-${suffix}`, mode: 'SUPPORT' }
  });
  expect(supportCreated.statusCode).toBe(201);

  const teamCreated = await instance.inject({
    method: 'POST',
    url: '/auth/workspaces',
    headers: { authorization: `Bearer ${supportCreated.json().token}` },
    payload: { name: 'Delivery Team', slug: `team-${suffix}` }
  });
  expect(teamCreated.statusCode).toBe(201);

  const support = await prisma.workspace.findUniqueOrThrow({ where: { slug: `support-${suffix}` } });
  const team = await prisma.workspace.findUniqueOrThrow({ where: { slug: `team-${suffix}` } });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });

  return {
    user,
    support,
    team,
    supportCreate: supportCreated.json(),
    teamCreate: teamCreated.json(),
    token: teamCreated.json().token as string
  };
}

function injectIn(mode: 'support' | 'team', options: Omit<InjectOptions, 'headers'>) {
  const workspace = fixture[mode];
  return app.inject({
    ...options,
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'x-workspace-slug': workspace.slug
    }
  });
}
