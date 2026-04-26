import type { FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { proposeThreadTasksSchema } from '@taskara/shared';
import { getRequestActor } from '../services/actor';
import { createTask, ensureDefaultProject } from '../services/tasks';

interface ProposedTaskPayload {
  projectId: string;
  title: string;
  description?: string;
  labels: string[];
  priority: 'NO_PRIORITY' | 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: 'TODO';
  source: 'AGENT';
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/agent/thread-to-tasks', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = proposeThreadTasksSchema.parse(request.body);
    const project = input.projectId ? { id: input.projectId } : await ensureDefaultProject(actor.workspace.id);
    const titles = extractTaskTitles(input.text);

    const run = await prisma.agentRun.create({
      data: {
        workspaceId: actor.workspace.id,
        kind: 'THREAD_TO_TASKS',
        status: 'COMPLETED',
        input: {
          text: input.text,
          sourceUrl: input.sourceUrl,
          sourceTitle: input.sourceTitle,
          projectId: project.id
        },
        output: { proposedCount: titles.length },
        createdById: actor.user.id,
        completedAt: new Date(),
        actions: {
          create: titles.map((title) => ({
            kind: 'create_task',
            payload: {
              projectId: project.id,
              title,
              description: buildDescription(input),
              labels: ['follow-up'],
              priority: inferPriority(title),
              status: 'TODO',
              source: 'AGENT'
            } satisfies ProposedTaskPayload
          }))
        }
      },
      include: { actions: true }
    });

    return reply.code(201).send(run);
  });

  app.post('/agent/daily-plan', async (request) => {
    const actor = await getRequestActor(request);
    const tasks = await prisma.task.findMany({
      where: {
        workspaceId: actor.workspace.id,
        assigneeId: actor.user.id,
        status: { notIn: ['DONE', 'CANCELED'] }
      },
      include: {
        project: { select: { id: true, name: true, keyPrefix: true } },
        blockingDependencies: { include: { blockedByTask: true } }
      },
      orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
      take: 25
    });

    const blocked = tasks.filter((task) => task.status === 'BLOCKED' || task.blockingDependencies.length > 0);
    const focus = tasks
      .filter((task) => task.status !== 'BLOCKED' && task.blockingDependencies.length === 0)
      .sort((a, b) => priorityScore(b.priority) - priorityScore(a.priority))
      .slice(0, 5);

    const run = await prisma.agentRun.create({
      data: {
        workspaceId: actor.workspace.id,
        kind: 'DAILY_PLAN',
        status: 'COMPLETED',
        input: { userId: actor.user.id },
        output: {
          focus: focus.map((task) => ({ key: task.key, title: task.title, project: task.project.name, priority: task.priority })),
          blocked: blocked.map((task) => ({ key: task.key, title: task.title }))
        },
        createdById: actor.user.id,
        completedAt: new Date()
      }
    });

    return { runId: run.id, focus, blocked };
  });

  app.post('/agent/actions/:id/apply', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const action = await prisma.agentAction.findUnique({
      where: { id },
      include: { agentRun: true }
    });
    if (!action || action.agentRun.workspaceId !== actor.workspace.id) {
      return reply.code(404).send({ message: 'Agent action not found' });
    }
    if (action.status !== 'PROPOSED' && action.status !== 'ACCEPTED') {
      return reply.code(409).send({ message: `Action is already ${action.status}` });
    }
    if (action.kind !== 'create_task') {
      return reply.code(400).send({ message: `Cannot apply action kind ${action.kind}` });
    }

    const payload = action.payload as unknown as ProposedTaskPayload;
    const task = await createTask(actor, payload);
    await prisma.agentAction.update({
      where: { id },
      data: {
        status: 'APPLIED',
        approverId: actor.user.id,
        decidedAt: new Date()
      }
    });

    return { task };
  });
}

function extractTaskTitles(text: string): string[] {
  const candidates = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').replace(/^(todo|action|follow[-\s]?up|task|کار|اقدام)[:：\s-]*/i, '').trim())
    .filter((line) => /todo|fix|follow|action|implement|باید|پیگیری|اصلاح|انجام|بررسی/i.test(line))
    .map((line) => line.slice(0, 240));

  const unique = [...new Set(candidates)];
  if (unique.length > 0) return unique.slice(0, 12);

  return text
    .split(/[.!؟?]\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12)
    .slice(0, 5)
    .map((sentence) => sentence.slice(0, 240));
}

function buildDescription(input: { sourceUrl?: string; sourceTitle?: string }): string | undefined {
  const lines = [input.sourceTitle ? `Source: ${input.sourceTitle}` : undefined, input.sourceUrl].filter(Boolean);
  return lines.length ? lines.join('\n') : undefined;
}

function inferPriority(title: string): ProposedTaskPayload['priority'] {
  if (/urgent|critical|asap|فوری|بحرانی/i.test(title)) return 'URGENT';
  if (/block|blocked|security|incident|مسدود|امنیت/i.test(title)) return 'HIGH';
  return 'MEDIUM';
}

function priorityScore(priority: string): number {
  return { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NO_PRIORITY: 0 }[priority] ?? 0;
}
