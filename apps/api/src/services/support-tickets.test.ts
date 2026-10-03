import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import { config } from '../config';
import type { RequestActor } from './actor';
import {
  addSupportTicketMessage,
  createCaseFromTicket,
  createSupportTicket,
  listSupportTicketMessages,
  listSupportTickets,
  normalizeSupportPhone,
  updateCaseFromTicket
} from './support-tickets';

const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];
const originalSecret = config.TASKARA_SUPPORT_DATA_SECRET;

describe('Support Ticket lifecycle', () => {
  beforeAll(() => {
    config.TASKARA_SUPPORT_DATA_SECRET ||= `${crypto.randomUUID()}${crypto.randomUUID()}`;
  });

  afterEach(async () => {
    const workspaceIds = cleanupWorkspaceIds.splice(0);
    if (workspaceIds.length) {
      await prisma.supportTicket.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.supportCase.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    const userIds = cleanupUserIds.splice(0);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  afterAll(() => {
    config.TASKARA_SUPPORT_DATA_SECRET = originalSecret;
  });

  test('normalizes Iranian mobile formats to one customer identity', () => {
    expect(normalizeSupportPhone('09399569034')).toBe('+989399569034');
    expect(normalizeSupportPhone('9399569034')).toBe('+989399569034');
    expect(normalizeSupportPhone('989399569034')).toBe('+989399569034');
    expect(normalizeSupportPhone('+989399569034')).toBe('+989399569034');
  });

  test('stores Ticket chat separately, filters by phone, converts once, and edits the Case', async () => {
    const actor = await createActor();
    const created = await createSupportTicket(actor, {
      title: 'Customer cannot finish checkout',
      priority: 'HIGH',
      phone: '09399569034',
      text: 'Checkout fails after payment.',
      clientRequestId: crypto.randomUUID(),
      authorType: 'CUSTOMER'
    });
    expect(created.ticket.key).toStartWith('TKT-');
    expect(created.ticket.caseId).toBeNull();

    const localList = await listSupportTickets(actor, { phone: '09399569034' });
    const internationalList = await listSupportTickets(actor, { phone: '+989399569034' });
    expect(localList.items.map((item) => item.id)).toEqual([created.ticket.id]);
    expect(internationalList.items.map((item) => item.id)).toEqual([created.ticket.id]);

    await addSupportTicketMessage(actor, created.ticket.key, {
      text: 'We are checking this now.',
      clientRequestId: crypto.randomUUID(),
      authorType: 'SUPPORTER',
      authorId: actor.user.id
    });
    const messages = await listSupportTicketMessages(actor, created.ticket.key);
    expect(messages.items.map((item) => item.authorType)).toEqual(['CUSTOMER', 'SUPPORTER']);

    const supportCase = await createCaseFromTicket(actor, created.ticket.key, {
      useAi: false,
      title: 'Checkout payment failure',
      description: 'Investigate checkout payment completion.',
      priority: 'URGENT',
      impact: 'HIGH',
      urgency: 'HIGH',
      typeKey: 'checkout-payment'
    });
    expect(supportCase.key).toStartWith('TST-');
    expect(await prisma.supportInteraction.count({ where: { caseId: supportCase.id } })).toBe(0);
    expect(await prisma.supportTicketMessage.count({ where: { ticketId: created.ticket.id } })).toBe(2);

    const replay = await createCaseFromTicket(actor, created.ticket.key, { useAi: true });
    expect(replay.id).toBe(supportCase.id);

    await updateCaseFromTicket(actor, created.ticket.key, {
      title: 'Edited checkout failure',
      priority: 'LOW',
      impact: null,
      urgency: null,
      typeKey: 'checkout',
      baseVersion: supportCase.version
    });
    const updated = await prisma.supportCase.findUniqueOrThrow({ where: { id: supportCase.id } });
    expect(updated).toMatchObject({
      title: 'Edited checkout failure',
      priority: 'LOW',
      impact: null,
      urgency: null,
      typeKey: 'checkout',
      version: supportCase.version + 1
    });
  });
});

async function createActor(): Promise<RequestActor> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { email: `ticket-${suffix}@support-tickets.test`, name: 'Ticket Admin' }
  });
  const workspace = await prisma.workspace.create({
    data: { name: 'Ticket Test', slug: `ticket-${suffix}`, mode: 'SUPPORT' }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' }
  });
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'TST', nextCaseNumber: 1 }
  });
  cleanupWorkspaceIds.push(workspace.id);
  cleanupUserIds.push(user.id);
  return {
    workspace,
    user,
    role: 'OWNER',
    actorType: 'USER',
    actorRuntime: null,
    source: 'WEB'
  };
}
