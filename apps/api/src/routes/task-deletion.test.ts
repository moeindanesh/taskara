import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { mintAgentCredentialToken } from '../services/agent-credential';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];

const EMAIL_DOMAIN = 'task-deletion.test';

/**
 * Destruction is the one task verb an agent does not get. Everything else it does to a task —
 * create, read, update, status, comment, label, dependency, subtask — stays permitted, so the gate
 * has to be narrow in both directions: it must stop the agent, and it must not quietly cost a human
 * a capability they had. Both halves are asserted here, because a gate that refuses everyone passes
 * the first half on its own.
 */
describe('task deletion is closed to agents and open to humans', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    // Only ever removes rows this file created: the domain is unique to it.
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => {
    await app.close();
  });

  test('an agent actor is refused and the task survives', async () => {
    const fixture = await createFixture();
    const task = await createTask(fixture, 'Task an agent must not delete');

    const response = await injectAs(fixture, 'agent', { method: 'DELETE', url: `/tasks/${task.key}` });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe('Agents cannot delete tasks');
    expect(await prisma.task.count({ where: { id: task.id } })).toBe(1);
  });

  test('an ordinary human member deletes the same task', async () => {
    const fixture = await createFixture();
    const task = await createTask(fixture, 'Task a human may delete');

    const response = await injectAs(fixture, 'member', { method: 'DELETE', url: `/tasks/${task.key}` });

    expect(response.statusCode).toBe(204);
    expect(await prisma.task.count({ where: { id: task.id } })).toBe(0);
  });

  // WorkspaceRole.AGENT is a permission, not a species. An agent holding an ordinary MEMBER role is
  // still an agent, and a gate written against the role instead of the kind would let it through.
  test('an agent holding an ordinary MEMBER role is refused too', async () => {
    const fixture = await createFixture();
    const task = await createTask(fixture, 'Task a member-role agent must not delete');

    const response = await injectAs(fixture, 'memberRoleAgent', { method: 'DELETE', url: `/tasks/${task.key}` });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe('Agents cannot delete tasks');
    expect(await prisma.task.count({ where: { id: task.id } })).toBe(1);
  });
});

type Persona = 'member' | 'agent' | 'memberRoleAgent';

interface Fixture {
  workspace: { id: string; slug: string };
  project: { id: string; keyPrefix: string };
  member: { id: string; email: string };
  agent: { id: string; email: string; token: string };
  memberRoleAgent: { id: string; email: string; token: string };
  nextSequence: () => number;
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Task deletion ${suffix}`,
      slug: `task-deletion-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const member = await prisma.user.create({
    data: { email: uniqueEmail('member'), name: 'Member' },
    select: { id: true, email: true }
  });
  const agent = await prisma.user.create({
    data: { email: uniqueEmail('agent'), name: 'Agent', kind: 'AGENT' },
    select: { id: true, email: true }
  });
  const memberRoleAgent = await prisma.user.create({
    data: { email: uniqueEmail('member-role-agent'), name: 'Member-role agent', kind: 'AGENT' },
    select: { id: true, email: true }
  });

  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: agent.id, role: 'AGENT' },
      { workspaceId: workspace.id, userId: memberRoleAgent.id, role: 'MEMBER' }
    ]
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Task deletion',
      keyPrefix: `TD${Math.random().toString(36).slice(2, 7)}`.toUpperCase()
    },
    select: { id: true, keyPrefix: true }
  });

  let sequence = 0;
  return {
    workspace,
    project,
    member,
    // An agent authenticates with an agent credential -- the email header cannot speak as one. The
    // credential is deliberately full read-write, so what the gate below refuses is the agent's
    // kind and not a narrow scope.
    agent: { ...agent, token: await issueCredential(workspace.id, agent.id) },
    memberRoleAgent: {
      ...memberRoleAgent,
      token: await issueCredential(workspace.id, memberRoleAgent.id)
    },
    nextSequence: () => (sequence += 1)
  };
}

async function issueCredential(workspaceId: string, userId: string): Promise<string> {
  const minted = mintAgentCredentialToken();
  await prisma.agentCredential.create({
    data: {
      workspaceId,
      userId,
      name: 'Task deletion test',
      lookupId: minted.lookupId,
      tokenHash: minted.tokenHash,
      scope: 'READ_WRITE'
    }
  });
  return minted.token;
}

async function createTask(fixture: Fixture, title: string): Promise<{ id: string; key: string }> {
  const sequence = fixture.nextSequence();
  return prisma.task.create({
    data: {
      workspaceId: fixture.workspace.id,
      projectId: fixture.project.id,
      sequence,
      key: `${fixture.project.keyPrefix}-${sequence}`,
      title
    },
    select: { id: true, key: true }
  });
}

async function injectAs(fixture: Fixture, persona: Persona, options: InjectOptions) {
  const actor = fixture[persona];
  // Each persona authenticates the way it actually can: a person by the email header, an agent by
  // its credential. Using the header for both would test a path an agent no longer has.
  const credentials =
    'token' in actor
      ? { authorization: `Bearer ${actor.token}` }
      : { 'x-user-email': actor.email };

  return app.inject({
    ...options,
    headers: {
      'x-workspace-slug': fixture.workspace.slug,
      ...credentials,
      ...(options.headers || {})
    }
  });
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@${EMAIL_DOMAIN}`.toLowerCase();
}
