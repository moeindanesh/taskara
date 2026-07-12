import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];

describe('project merge', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(async () => {
    const workspaceIds = cleanupWorkspaceIds.splice(0);
    if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    const userIds = cleanupUserIds.splice(0);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  afterAll(async () => {
    await app.close();
  });

  test('moves project-owned data, preserves task keys, and removes all sources', async () => {
    const fixture = await createFixture();

    const response = await inject(fixture, fixture.owner.email, {
      destinationProjectId: fixture.target.id,
      sourceProjectIds: [fixture.sourceA.id, fixture.sourceB.id]
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mergedProjectIds).toEqual([fixture.sourceA.id, fixture.sourceB.id]);
    expect(response.json().moved.tasks).toBe(3);
    expect(response.json().moved.milestones).toBe(1);
    expect(response.json().moved.knowledgePages).toBe(1);

    const remainingSources = await prisma.project.count({
      where: { id: { in: [fixture.sourceA.id, fixture.sourceB.id] } }
    });
    expect(remainingSources).toBe(0);

    const tasks = await prisma.task.findMany({ where: { projectId: fixture.target.id }, orderBy: { sequence: 'asc' } });
    expect(tasks.map((task) => task.sequence)).toEqual([1, 2, 3, 4]);
    expect(tasks.map((task) => task.key).sort()).toEqual(['DST-1', 'SRCA-1', 'SRCA-2', 'SRCB-1']);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: fixture.target.id } })).nextTaskNumber).toBe(5);

    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: fixture.milestone.id } })).projectId).toBe(fixture.target.id);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: fixture.meeting.id } })).projectId).toBe(fixture.target.id);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: fixture.child.id } })).parentId).toBe(fixture.target.id);
    expect((await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: fixture.target.id, userId: fixture.member.id } }
    })).role).toBe('LEAD');

    const spaces = await prisma.knowledgeSpace.findMany({ where: { projectId: fixture.target.id } });
    expect(spaces).toHaveLength(1);
    const movedPage = await prisma.knowledgePage.findUniqueOrThrow({ where: { id: fixture.page.id } });
    expect(movedPage.spaceId).toBe(spaces[0].id);
    expect(movedPage.path).toStartWith('/merged-');
  });

  test('requires workspace admin access', async () => {
    const fixture = await createFixture();
    const response = await inject(fixture, fixture.member.email, {
      destinationProjectId: fixture.target.id,
      sourceProjectIds: [fixture.sourceA.id]
    });
    expect(response.statusCode).toBe(403);
    expect(await prisma.project.count({ where: { id: { in: [fixture.target.id, fixture.sourceA.id] } } })).toBe(2);
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [owner, member] = await Promise.all([
    prisma.user.create({ data: { email: `project-merge-owner-${suffix}@example.test`, name: 'Owner' } }),
    prisma.user.create({ data: { email: `project-merge-member-${suffix}@example.test`, name: 'Member' } })
  ]);
  cleanupUserIds.push(owner.id, member.id);
  const workspace = await prisma.workspace.create({ data: { name: 'Merge workspace', slug: `merge-${suffix}` } });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' }
    ]
  });

  const target = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Destination', keyPrefix: 'DST', nextTaskNumber: 2 }
  });
  const sourceA = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Source A', keyPrefix: 'SRCA', nextTaskNumber: 3 }
  });
  const sourceB = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Source B', keyPrefix: 'SRCB', nextTaskNumber: 2 }
  });
  const child = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Child', keyPrefix: 'CHLD', parentId: sourceA.id }
  });

  await prisma.task.createMany({
    data: [
      { workspaceId: workspace.id, projectId: target.id, sequence: 1, key: 'DST-1', title: 'Target task' },
      { workspaceId: workspace.id, projectId: sourceA.id, sequence: 1, key: 'SRCA-1', title: 'Source A task 1' },
      { workspaceId: workspace.id, projectId: sourceA.id, sequence: 2, key: 'SRCA-2', title: 'Source A task 2' },
      { workspaceId: workspace.id, projectId: sourceB.id, sequence: 1, key: 'SRCB-1', title: 'Source B task' }
    ]
  });
  const milestone = await prisma.milestone.create({
    data: { workspaceId: workspace.id, projectId: sourceA.id, name: 'Source milestone', kind: 'PHASE' }
  });
  const meeting = await prisma.meeting.create({
    data: { workspaceId: workspace.id, projectId: sourceB.id, title: 'Source meeting' }
  });
  await prisma.projectMember.createMany({
    data: [
      { projectId: target.id, userId: member.id, role: 'VIEWER' },
      { projectId: sourceA.id, userId: member.id, role: 'LEAD' }
    ]
  });
  const targetSpace = await prisma.knowledgeSpace.create({
    data: { workspaceId: workspace.id, type: 'PROJECT', projectId: target.id, key: `dst-${suffix}`, name: 'Destination docs' }
  });
  const sourceSpace = await prisma.knowledgeSpace.create({
    data: { workspaceId: workspace.id, type: 'PROJECT', projectId: sourceA.id, key: `src-${suffix}`, name: 'Source docs' }
  });
  const page = await prisma.knowledgePage.create({
    data: {
      workspaceId: workspace.id,
      spaceId: sourceSpace.id,
      slug: 'overview',
      path: '/overview',
      title: 'Overview',
      content: {},
      contentText: ''
    }
  });

  return { workspace, owner, member, target, sourceA, sourceB, child, milestone, meeting, targetSpace, page };
}

async function inject(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  email: string,
  payload: InjectOptions['payload']
) {
  const options: InjectOptions = {
    method: 'POST',
    url: '/projects/merge',
    headers: { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': email },
    payload
  };
  return app.inject(options);
}
