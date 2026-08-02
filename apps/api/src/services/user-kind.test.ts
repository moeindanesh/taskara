import { afterEach, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';

const OPERATOR_CONSTRAINT = 'User_operator_only_for_agents';

describe('user kind database invariants', () => {
  afterEach(async () => {
    // Only ever removes rows this file created: the domain is unique to it.
    await prisma.user.deleteMany({ where: { email: { endsWith: '@user-kind.test' } } });
  });

  test('defaults an ordinary user to HUMAN with no operator', async () => {
    const human = await createUser('plain');

    expect(human.kind).toBe('HUMAN');
    expect(human.operatorId).toBeNull();
  });

  test('rejects a human that carries an operator', async () => {
    const operator = await createUser('operator');

    const error = await captureError(
      prisma.user.create({
        data: userRow('human-with-operator', { kind: 'HUMAN', operatorId: operator.id })
      })
    );

    expect(String(error?.message)).toContain(OPERATOR_CONSTRAINT);
  });

  test('accepts an agent with an operator and an agent without one', async () => {
    const operator = await createUser('operator');

    const operated = await createUser('operated-agent', { kind: 'AGENT', operatorId: operator.id });
    expect(operated.kind).toBe('AGENT');
    expect(operated.operatorId).toBe(operator.id);

    const unoperated = await createUser('lone-agent', { kind: 'AGENT' });
    expect(unoperated.kind).toBe('AGENT');
    expect(unoperated.operatorId).toBeNull();
  });

  test('holds against raw writes that bypass the service layer', async () => {
    const operator = await createUser('operator');

    const batch = await captureError(
      prisma.user.createMany({
        data: [
          userRow('legal-agent-in-a-batch', { kind: 'AGENT', operatorId: operator.id }),
          userRow('smuggled-human', { kind: 'HUMAN', operatorId: operator.id })
        ]
      })
    );
    expect(String(batch?.message)).toContain(OPERATOR_CONSTRAINT);
    expect(
      await prisma.user.count({ where: { email: { contains: 'legal-agent-in-a-batch' } } })
    ).toBe(0);
    expect(await prisma.user.count({ where: { email: { contains: 'smuggled-human' } } })).toBe(0);

    const rawSql = await captureError(
      prisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "name", "kind", "operatorId", "updatedAt")
         VALUES ($1::uuid, $2, 'Raw human', 'HUMAN', $3::uuid, now())`,
        crypto.randomUUID(),
        uniqueEmail('raw-human'),
        operator.id
      )
    );
    expect(String(rawSql?.message)).toContain(OPERATOR_CONSTRAINT);
  });

  test('rejects an update that flips an operated agent back to human', async () => {
    const operator = await createUser('operator');
    const agent = await createUser('agent', { kind: 'AGENT', operatorId: operator.id });

    const flip = await captureError(
      prisma.user.update({ where: { id: agent.id }, data: { kind: 'HUMAN' } })
    );
    expect(String(flip?.message)).toContain(OPERATOR_CONSTRAINT);

    const attach = await captureError(
      prisma.user.update({ where: { id: operator.id }, data: { operatorId: agent.id } })
    );
    expect(String(attach?.message)).toContain(OPERATOR_CONSTRAINT);

    const rawFlip = await captureError(
      prisma.$executeRawUnsafe(`UPDATE "User" SET "kind" = 'HUMAN' WHERE "id" = $1::uuid`, agent.id)
    );
    expect(String(rawFlip?.message)).toContain(OPERATOR_CONSTRAINT);

    const untouched = await prisma.user.findUniqueOrThrow({
      where: { id: agent.id },
      select: { kind: true, operatorId: true }
    });
    expect(untouched.kind).toBe('AGENT');
    expect(untouched.operatorId).toBe(operator.id);
  });

  test('accepts flipping a human to an agent, and back once the operator is cleared', async () => {
    const operator = await createUser('operator');
    const promoted = await createUser('promoted');

    const agent = await prisma.user.update({
      where: { id: promoted.id },
      data: { kind: 'AGENT', operatorId: operator.id },
      select: { kind: true, operatorId: true }
    });
    expect(agent.kind).toBe('AGENT');
    expect(agent.operatorId).toBe(operator.id);

    const human = await prisma.user.update({
      where: { id: promoted.id },
      data: { kind: 'HUMAN', operatorId: null },
      select: { kind: true, operatorId: true }
    });
    expect(human.kind).toBe('HUMAN');
    expect(human.operatorId).toBeNull();
  });

  test('deleting the operator nulls the link and keeps the agent user alive', async () => {
    const operator = await createUser('operator');
    const agent = await createUser('agent', { kind: 'AGENT', operatorId: operator.id });

    await prisma.user.delete({ where: { id: operator.id } });

    const survivor = await prisma.user.findUnique({
      where: { id: agent.id },
      select: { id: true, kind: true, operatorId: true }
    });
    expect(survivor).not.toBeNull();
    expect(survivor?.kind).toBe('AGENT');
    expect(survivor?.operatorId).toBeNull();
  });
});

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@user-kind.test`.toLowerCase();
}

function userRow(
  label: string,
  overrides: { kind?: 'HUMAN' | 'AGENT'; operatorId?: string } = {}
): { email: string; name: string; kind?: 'HUMAN' | 'AGENT'; operatorId?: string } {
  return { email: uniqueEmail(label), name: `User ${label}`, ...overrides };
}

async function createUser(
  label: string,
  overrides: { kind?: 'HUMAN' | 'AGENT'; operatorId?: string } = {}
): Promise<{ id: string; kind: string; operatorId: string | null }> {
  const user = await prisma.user.create({
    data: userRow(label, overrides),
    select: { id: true, kind: true, operatorId: true }
  });
  return user;
}

async function captureError(work: Promise<unknown>): Promise<Error | undefined> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  return undefined;
}
