import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';

const EMAIL_DOMAIN = 'support-teardown.test';
const ids: { workspace?: string; owner?: string; staff?: string; case?: string; interaction?: string; event?: string } = {};

describe('Support immutable provenance and tenant teardown', () => {
  beforeAll(async () => {
    const [owner, staff] = await Promise.all([
      prisma.user.create({ data: { email: `owner-${crypto.randomUUID()}@${EMAIL_DOMAIN}`, name: 'Owner' } }),
      prisma.user.create({ data: { email: `staff-${crypto.randomUUID()}@${EMAIL_DOMAIN}`, name: 'Staff' } })
    ]);
    ids.owner = owner.id;
    ids.staff = staff.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Support teardown',
        slug: `support-teardown-${crypto.randomUUID()}`,
        mode: 'SUPPORT',
        users: {
          create: [
            { userId: owner.id, role: 'OWNER' },
            { userId: staff.id, role: 'MEMBER' }
          ]
        }
      }
    });
    ids.workspace = workspace.id;
    const department = await prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Operations', slug: 'operations' }
    });
    const membership = await prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: staff.id }
    });
    await prisma.supportWorkspaceState.create({
      data: { workspaceId: workspace.id, keyPrefix: 'TD', nextCaseNumber: 2 }
    });
    const receivedAt = new Date(Date.now() - 60_000);
    const supportCase = await prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        key: 'TD-1',
        sequence: 1,
        title: 'Closed historical Case',
        sourceChannel: 'CALL',
        typeKey: 'incident',
        status: 'CLOSED',
        departmentId: department.id,
        assigneeMembershipId: membership.id,
        receivedAt,
        lastMeaningfulActivityAt: receivedAt,
        resolutionCode: 'FIXED',
        resolutionSummary: 'Verified',
        resolvedAt: new Date(receivedAt.getTime() + 10_000),
        closedAt: new Date(receivedAt.getTime() + 20_000)
      }
    });
    ids.case = supportCase.id;
    const interaction = await prisma.supportInteraction.create({
      data: {
        workspaceId: workspace.id,
        caseId: supportCase.id,
        kind: 'CALL',
        visibility: 'PUBLIC',
        channel: 'CALL',
        direction: 'OUTBOUND',
        authorId: staff.id,
        occurredAt: new Date(receivedAt.getTime() + 5_000)
      }
    });
    ids.interaction = interaction.id;
    await prisma.supportCallDetail.create({
      data: {
        workspaceId: workspace.id,
        interactionId: interaction.id,
        direction: 'OUTBOUND',
        disposition: 'ANSWERED',
        startedAt: interaction.occurredAt,
        callbackOwnerId: staff.id,
        callbackDueAt: new Date(Date.now() + 60_000)
      }
    });
    const event = await prisma.supportCaseEvent.create({
      data: {
        workspaceId: workspace.id,
        caseId: supportCase.id,
        sequence: 1,
        actorId: staff.id,
        actorType: 'USER',
        source: 'WEB',
        action: 'case.closed'
      }
    });
    ids.event = event.id;
  });

  afterAll(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  test('hard User deletion nulls only live pointers while immutable envelopes survive', async () => {
    let directNullRejected = false;
    try {
      await prisma.supportCaseEvent.update({
        where: { id: ids.event! },
        data: { actorId: null }
      });
    } catch (error) {
      directNullRejected = true;
      expect(String(error)).toMatch(/provenance is immutable|append-only/);
    }
    expect(directNullRejected).toBe(true);

    // Knowing the transaction-local guard name is not enough: only the nested User-delete trigger
    // may exercise the exception, so a direct database writer still cannot erase provenance.
    let flagSpoofRejected = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('taskara.support_provenance_nulling', 'on', true)`;
        await tx.supportInteraction.update({
          where: { id: ids.interaction! },
          data: { authorId: null }
        });
      });
    } catch (error) {
      flagSpoofRejected = true;
      expect(String(error)).toMatch(/provenance is immutable|append-only/);
    }
    expect(flagSpoofRejected).toBe(true);

    await prisma.user.delete({ where: { id: ids.staff! } });
    const [supportCase, interaction, call, event] = await Promise.all([
      prisma.supportCase.findUniqueOrThrow({ where: { id: ids.case! } }),
      prisma.supportInteraction.findUniqueOrThrow({ where: { id: ids.interaction! } }),
      prisma.supportCallDetail.findUniqueOrThrow({ where: { interactionId: ids.interaction! } }),
      prisma.supportCaseEvent.findUniqueOrThrow({ where: { id: ids.event! } })
    ]);
    expect(supportCase.assigneeMembershipId).toBeNull();
    expect(interaction.authorId).toBeNull();
    expect(event.actorId).toBeNull();
    expect(call.callbackOwnerId).toBeNull();
    expect(call.callbackDueAt).toBeNull();

    let rejected = false;
    try {
      await prisma.supportCaseEvent.update({
        where: { id: event.id },
        data: { actorId: ids.owner! }
      });
    } catch (error) {
      rejected = true;
      expect(String(error)).toMatch(/provenance is immutable|append-only/);
    }
    expect(rejected).toBe(true);
  });

  test('whole Support tenant deletion traverses every restrictive child safely', async () => {
    await prisma.workspace.delete({ where: { id: ids.workspace! } });
    expect(await prisma.supportCase.count({ where: { workspaceId: ids.workspace! } })).toBe(0);
    ids.workspace = undefined;
  });
});
