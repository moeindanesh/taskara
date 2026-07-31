import { afterEach, describe, expect, test } from 'bun:test';
import { prisma, type Prisma } from '@taskara/db';

const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];

const EFFORT_FIELDS_CONSTRAINT = 'Task_effort_has_no_work_fields';
const EFFORT_STATUS_CONSTRAINT = 'Task_effort_status';

describe('task kind database invariants', () => {
  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    const userIds = cleanupUserIds.splice(0);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  test('accepts an effort that carries no work fields and is already in progress', async () => {
    const fixture = await createFixture();

    const effort = await prisma.task.create({
      data: taskRow(fixture, { kind: 'EFFORT', status: 'IN_PROGRESS', title: 'Keep the build green' }),
      select: { id: true, kind: true, status: true }
    });

    expect(effort.kind).toBe('EFFORT');
    expect(effort.status).toBe('IN_PROGRESS');
  });

  test('rejects an effort that carries any single work field', async () => {
    const fixture = await createFixture();

    const workFields: Array<[string, Partial<Prisma.TaskCreateManyInput>]> = [
      ['assigneeId', { assigneeId: fixture.user.id }],
      ['dueAt', { dueAt: new Date() }],
      ['weight', { weight: 3 }],
      ['milestoneId', { milestoneId: fixture.milestone.id }],
      ['cycleId', { cycleId: fixture.cycle.id }],
      ['parentId', { parentId: fixture.parentTask.id }]
    ];

    for (const [field, patch] of workFields) {
      const error = await captureError(
        prisma.task.create({
          data: taskRow(fixture, { kind: 'EFFORT', status: 'IN_PROGRESS', title: `Effort with ${field}`, ...patch })
        })
      );
      expect(`${field}: ${String(error?.message)}`).toContain(EFFORT_FIELDS_CONSTRAINT);
    }
  });

  test('rejects an effort in any status that is not in progress, done, or canceled', async () => {
    const fixture = await createFixture();

    for (const status of ['TODO', 'BACKLOG', 'IN_REVIEW', 'BLOCKED'] as const) {
      const error = await captureError(
        prisma.task.create({
          data: taskRow(fixture, { kind: 'EFFORT', status, title: `Effort ${status}` })
        })
      );
      expect(`${status}: ${String(error?.message)}`).toContain(EFFORT_STATUS_CONSTRAINT);
    }

    for (const status of ['IN_PROGRESS', 'DONE', 'CANCELED'] as const) {
      const created = await prisma.task.create({
        data: taskRow(fixture, { kind: 'EFFORT', status, title: `Effort ok ${status}` }),
        select: { status: true }
      });
      expect(created.status).toBe(status);
    }
  });

  test('accepts a completed effort because an effort genuinely completes', async () => {
    const fixture = await createFixture();
    const completedAt = new Date();

    const effort = await prisma.task.create({
      data: taskRow(fixture, { kind: 'EFFORT', status: 'DONE', title: 'Finished effort', completedAt }),
      select: { completedAt: true }
    });

    expect(effort.completedAt?.getTime()).toBe(completedAt.getTime());
  });

  test('leaves work tasks untouched by both constraints', async () => {
    const fixture = await createFixture();

    const loaded = await prisma.task.create({
      data: taskRow(fixture, {
        kind: 'WORK',
        status: 'TODO',
        title: 'Fully loaded work task',
        assigneeId: fixture.user.id,
        dueAt: new Date(),
        weight: 5,
        milestoneId: fixture.milestone.id,
        cycleId: fixture.cycle.id,
        parentId: fixture.parentTask.id
      }),
      select: { id: true, kind: true }
    });
    expect(loaded.kind).toBe('WORK');

    for (const status of ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELED'] as const) {
      const created = await prisma.task.create({
        data: taskRow(fixture, { status, title: `Work ${status}` }),
        select: { kind: true, status: true }
      });
      expect(created.kind).toBe('WORK');
      expect(created.status).toBe(status);
    }
  });

  test('holds against raw writes that bypass the task service layer', async () => {
    const fixture = await createFixture();

    const illegalFields = await captureError(
      prisma.task.createMany({
        data: [
          taskRow(fixture, { kind: 'EFFORT', status: 'IN_PROGRESS', title: 'Legal effort in a batch' }),
          taskRow(fixture, {
            kind: 'EFFORT',
            status: 'IN_PROGRESS',
            title: 'Smuggled effort',
            assigneeId: fixture.user.id
          })
        ]
      })
    );
    expect(String(illegalFields?.message)).toContain(EFFORT_FIELDS_CONSTRAINT);

    const illegalStatus = await captureError(
      prisma.task.createMany({
        data: [taskRow(fixture, { kind: 'EFFORT', status: 'TODO', title: 'Smuggled backlog effort' })]
      })
    );
    expect(String(illegalStatus?.message)).toContain(EFFORT_STATUS_CONSTRAINT);

    expect(
      await prisma.task.count({ where: { workspaceId: fixture.workspace.id, title: { startsWith: 'Smuggled' } } })
    ).toBe(0);
    expect(
      await prisma.task.count({ where: { workspaceId: fixture.workspace.id, title: 'Legal effort in a batch' } })
    ).toBe(0);

    const effort = await prisma.task.create({
      data: taskRow(fixture, { kind: 'EFFORT', status: 'IN_PROGRESS', title: 'Effort to corrupt' }),
      select: { id: true }
    });

    const rawUpdate = await captureError(
      prisma.$transaction(async (tx) => {
        await tx.task.update({ where: { id: effort.id }, data: { weight: 2 } });
      })
    );
    expect(String(rawUpdate?.message)).toContain(EFFORT_FIELDS_CONSTRAINT);

    const rawStatusUpdate = await captureError(
      prisma.$transaction(async (tx) => {
        await tx.task.update({ where: { id: effort.id }, data: { status: 'BLOCKED' } });
      })
    );
    expect(String(rawStatusUpdate?.message)).toContain(EFFORT_STATUS_CONSTRAINT);

    const rawSql = await captureError(
      prisma.$executeRawUnsafe(
        `UPDATE "Task" SET "dueAt" = now() WHERE "id" = $1::uuid`,
        effort.id
      )
    );
    expect(String(rawSql?.message)).toContain(EFFORT_FIELDS_CONSTRAINT);

    const untouched = await prisma.task.findUniqueOrThrow({
      where: { id: effort.id },
      select: { weight: true, dueAt: true, status: true }
    });
    expect(untouched.weight).toBeNull();
    expect(untouched.dueAt).toBeNull();
    expect(untouched.status).toBe('IN_PROGRESS');
  });
});

interface Fixture {
  workspace: { id: string };
  user: { id: string };
  project: { id: string; keyPrefix: string };
  milestone: { id: string };
  cycle: { id: string };
  parentTask: { id: string };
  nextSequence: () => number;
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Task kind ${suffix}`,
      slug: `task-kind-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const user = await prisma.user.create({
    data: { email: `member-${suffix}@task-kind.test`.toLowerCase(), name: 'Member' },
    select: { id: true }
  });
  cleanupUserIds.push(user.id);
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'MEMBER' }
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Task kind',
      keyPrefix: `TK${Math.random().toString(36).slice(2, 7)}`.toUpperCase()
    },
    select: { id: true, keyPrefix: true }
  });

  const milestone = await prisma.milestone.create({
    data: { workspaceId: workspace.id, projectId: project.id, name: 'Scope', kind: 'FEATURE' },
    select: { id: true }
  });

  const cycle = await prisma.cycle.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Cycle 1',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 7 * 86_400_000)
    },
    select: { id: true }
  });

  let sequence = 0;
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };

  const parentSequence = nextSequence();
  const parentTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      sequence: parentSequence,
      key: `${project.keyPrefix}-${parentSequence}`,
      title: 'Parent work'
    },
    select: { id: true }
  });

  return { workspace, user, project, milestone, cycle, parentTask, nextSequence };
}

function taskRow(
  fixture: Fixture,
  overrides: Partial<Prisma.TaskCreateManyInput>
): Prisma.TaskCreateManyInput {
  const sequence = fixture.nextSequence();
  return {
    workspaceId: fixture.workspace.id,
    projectId: fixture.project.id,
    sequence,
    key: `${fixture.project.keyPrefix}-${sequence}`,
    title: 'Task',
    ...overrides
  };
}

async function captureError(work: Promise<unknown>): Promise<Error | undefined> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  return undefined;
}
