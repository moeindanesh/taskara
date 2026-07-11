import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@taskara/db';
import { registerApp } from '../app';

const taskCount = 10_000;
const milestoneCount = 20;
const listP95BudgetMs = 250;
const sampleRuns = 20;

let app: FastifyInstance | null = null;
let workspaceId: string | null = null;
let userId: string | null = null;

try {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `milestone-benchmark-${suffix}@taskara.test`;
  const user = await prisma.user.create({
    data: { email, name: 'Milestone benchmark owner' },
    select: { id: true }
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Milestone benchmark',
      slug: `milestone-benchmark-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60),
      users: { create: { userId: user.id, role: 'OWNER' } }
    },
    select: { id: true, slug: true }
  });
  workspaceId = workspace.id;
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      leadId: user.id,
      name: '10k task project',
      keyPrefix: `B${Date.now().toString(36).slice(-7)}`.toUpperCase()
    },
    select: { id: true, keyPrefix: true }
  });

  const milestoneIds = Array.from({ length: milestoneCount }, () => crypto.randomUUID());
  await prisma.milestone.createMany({
    data: milestoneIds.map((id, index) => ({
      id,
      workspaceId: workspace.id,
      projectId: project.id,
      ownerId: user.id,
      name: `Milestone ${index + 1}`,
      kind: index % 2 === 0 ? 'FEATURE' : 'PHASE',
      status: index % 3 === 0 ? 'PLANNED' : 'ACTIVE',
      health: index % 5 === 0 ? 'AT_RISK' : 'ON_TRACK',
      targetOn: new Date(Date.UTC(2026, 7, (index % 20) + 1)),
      position: (index + 1) * 1024
    }))
  });

  const now = new Date();
  const overdue = new Date(now.getTime() - 86_400_000);
  const taskRows: Prisma.TaskCreateManyInput[] = Array.from({ length: taskCount }, (_, index) => {
    const bucket = index % 10;
    const status = bucket < 2 ? 'DONE' : bucket === 2 ? 'CANCELED' : bucket === 3 ? 'BLOCKED' : 'TODO';
    return {
      workspaceId: workspace.id,
      projectId: project.id,
      milestoneId: milestoneIds[index % milestoneIds.length],
      sequence: index + 1,
      key: `${project.keyPrefix}-${index + 1}`,
      title: `Representative task ${index + 1}`,
      status,
      priority: bucket === 3 ? 'HIGH' : 'MEDIUM',
      weight: (index % 5) + 1,
      dueAt: bucket === 3 ? overdue : null,
      completedAt: status === 'DONE' ? now : null
    };
  });
  await prisma.task.createMany({ data: taskRows });

  app = Fastify({ logger: false });
  await registerApp(app);
  await app.ready();
  const headers = {
    'x-workspace-slug': workspace.slug,
    'x-user-email': email
  };
  const listUrl = '/milestones?status=PLANNED,ACTIVE&limit=50&offset=0';
  const tasksUrl = `/tasks?milestoneId=${milestoneIds[0]}&limit=100&offset=0`;

  for (let index = 0; index < 3; index += 1) {
    await app.inject({ method: 'GET', url: listUrl, headers });
    await app.inject({ method: 'GET', url: tasksUrl, headers });
  }

  const listSamples = await measureRequests(app, listUrl, headers, sampleRuns, (response) => {
    if (response.statusCode !== 200 || response.json().items.length !== milestoneCount) {
      throw new Error(`Milestone list benchmark returned ${response.statusCode} or an unexpected item count`);
    }
  });
  const taskSamples = await measureRequests(app, tasksUrl, headers, sampleRuns, (response) => {
    if (response.statusCode !== 200 || response.json().items.length !== 100) {
      throw new Error(`Milestone task-page benchmark returned ${response.statusCode} or an unexpected item count`);
    }
  });
  const result = {
    taskCount,
    milestoneCount,
    samples: sampleRuns,
    milestoneList: summarize(listSamples),
    milestoneTaskPage: summarize(taskSamples),
    listP95BudgetMs
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.milestoneList.p95Ms >= listP95BudgetMs) {
    throw new Error(`Milestone list p95 ${result.milestoneList.p95Ms}ms exceeded ${listP95BudgetMs}ms`);
  }
} finally {
  if (app) await app.close();
  if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}

async function measureRequests(
  server: FastifyInstance,
  url: string,
  headers: Record<string, string>,
  runs: number,
  assertResponse: (response: Awaited<ReturnType<FastifyInstance['inject']>>) => void
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    const response = await server.inject({ method: 'GET', url, headers });
    samples.push(performance.now() - startedAt);
    assertResponse(response);
  }
  return samples;
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] || 0;
  return {
    minMs: round(sorted[0] || 0),
    medianMs: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(sorted.at(-1) || 0)
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
