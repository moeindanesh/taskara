import { Prisma, prisma } from '@taskara/db';
import type { RequestActor } from './actor';
import { HttpError } from './http';
import {
  decryptSupportBytes,
  encryptSupportBytes,
  hashSupportPayload
} from './support-crypto';
import { resolveSupportContactId } from './support-cases';
import {
  assertCanWorkCase,
  canReadSupportCase,
  resolveSupportAccess,
  type SupportAccess
} from './support-access';
import {
  appendSupportCaseEvent,
  caseEventSnapshot,
  createSupportCase,
  findSupportCaseForAccess,
  serializeSupportCase,
  supportCaseInclude
} from './support-cases';
import { assertSupportWorkspace } from './workspace-mode';
import { generatePublicSupportCaseDraft } from './public-support-ai';
import { config } from '../config';
import { appendSupportCaseSyncEvent } from './support-sync';

export const ticketInclude = {
  contact: {
    select: { id: true, name: true, email: true, phone: true, normalizedPhone: true, redactedAt: true }
  },
  case: {
    select: {
      id: true,
      key: true,
      title: true,
      description: true,
      priority: true,
      status: true,
      version: true,
      typeKey: true,
      impact: true,
      urgency: true
    }
  }
} satisfies Prisma.SupportTicketInclude;

export type SupportTicketView = Prisma.SupportTicketGetPayload<{ include: typeof ticketInclude }>;

export interface SupportTicketListQuery {
  status?: 'NEW' | 'OPEN' | 'CLOSED';
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  phone?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface SupportTicketMessageInput {
  text?: string;
  metadata?: Record<string, unknown>;
  clientRequestId?: string;
  authorType: 'CUSTOMER' | 'SUPPORTER' | 'SYSTEM';
  authorId?: string | null;
}

export interface SupportTicketCreateInput extends SupportTicketMessageInput {
  title: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  contact?: {
    name?: string;
    email?: string;
    phone?: string;
    externalCustomerId?: string;
  };
  phone?: string;
}

export function normalizeSupportPhone(value: string): string {
  const trimmed = value.trim().replace(/[^\d+]/g, '');
  if (/^09\d{9}$/.test(trimmed)) return `+98${trimmed.slice(1)}`;
  if (/^9\d{9}$/.test(trimmed)) return `+98${trimmed}`;
  if (/^98\d{10}$/.test(trimmed)) return `+${trimmed}`;
  if (/^\+98\d{10}$/.test(trimmed)) return trimmed;
  return trimmed;
}

export function serializeSupportTicket(ticket: SupportTicketView) {
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    contact: ticket.contact
      ? {
          id: ticket.contact.id,
          name: ticket.contact.name,
          email: ticket.contact.email,
          phone: ticket.contact.phone,
          redactedAt: ticket.contact.redactedAt?.toISOString() ?? null
        }
      : null,
    case: ticket.case,
    caseId: ticket.caseId,
    caseKey: ticket.case?.key ?? null,
    version: ticket.version
  };
}

export async function listSupportTickets(
  actor: RequestActor,
  query: SupportTicketListQuery = {}
) {
  assertSupportWorkspace(actor.workspace);
  const where: Prisma.SupportTicketWhereInput = {
    workspaceId: actor.workspace.id,
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.phone
      ? { contact: { is: { normalizedPhone: normalizeSupportPhone(query.phone) } } }
      : {}),
    ...(query.q
      ? {
          OR: [
            { key: { contains: query.q, mode: 'insensitive' } },
            { title: { contains: query.q, mode: 'insensitive' } },
            { contact: { is: { name: { contains: query.q, mode: 'insensitive' } } } },
            { contact: { is: { email: { contains: query.q, mode: 'insensitive' } } } }
          ]
        }
      : {})
  };
  const cursor = query.cursor ? decodeTicketCursor(query.cursor) : null;
  const pageWhere = cursor
    ? {
        AND: [
          where,
          {
            OR: [
              { updatedAt: { lt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, id: { lt: cursor.id } }
            ]
          }
        ]
      }
    : where;
  const limit = query.limit ?? 50;
  const [rows, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where: pageWhere,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: ticketInclude
    }),
    prisma.supportTicket.count({ where })
  ]);
  const items = rows.slice(0, limit);
  return {
    items: items.map(serializeSupportTicket),
    nextCursor: rows.length > limit && items.at(-1) ? encodeTicketCursor(items.at(-1)!) : null,
    total
  };
}

export async function findSupportTicket(actor: RequestActor, idOrKey: string) {
  assertSupportWorkspace(actor.workspace);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idOrKey);
  const ticket = await prisma.supportTicket.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      ...(isUuid ? { id: idOrKey } : { key: idOrKey.toUpperCase() })
    },
    include: ticketInclude
  });
  if (!ticket) throw new HttpError(404, 'Support Ticket not found');
  return ticket;
}

export async function listSupportTicketMessages(
  actor: RequestActor,
  idOrKey: string
) {
  const ticket = await findSupportTicket(actor, idOrKey);
  const messages = await prisma.supportTicketMessage.findMany({
    where: { workspaceId: actor.workspace.id, ticketId: ticket.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { author: { select: { id: true, name: true, email: true, avatarUrl: true } } }
  });
  return {
    ticket,
    items: messages.map((message) => ({
      id: message.id,
      authorType: message.authorType,
      author: message.author,
      body: message.bodyCiphertext
        ? decryptSupportBytes(message.bodyCiphertext).toString('utf8')
        : null,
      format: message.format,
      metadata: message.metadata,
      createdAt: message.createdAt.toISOString()
    }))
  };
}

export async function createSupportTicket(
  actor: RequestActor,
  input: SupportTicketCreateInput
) {
  assertSupportWorkspace(actor.workspace);
  const content = input.text ? encryptSupportBytes(Buffer.from(input.text, 'utf8')) : null;
  return prisma.$transaction(async (tx) => {
    if (input.clientRequestId) {
      const replay = await tx.supportTicket.findUnique({
        where: {
          workspaceId_publicClientRequestId: {
            workspaceId: actor.workspace.id,
            publicClientRequestId: input.clientRequestId
          }
        },
        include: ticketInclude
      });
      if (replay) {
        return { ticket: replay, replayed: true };
      }
    }
    const requestedPhone = input.phone || input.contact?.phone;
    const normalizedPhone = requestedPhone ? normalizeSupportPhone(requestedPhone) : null;
    const existingContact = normalizedPhone
      ? await tx.supportContact.findFirst({
          where: { workspaceId: actor.workspace.id, normalizedPhone, redactedAt: null },
          select: { id: true }
        })
      : null;
    const contactId = existingContact?.id
      ?? (input.contact
        ? await resolveSupportContactId(tx, actor.workspace.id, {
            contact: {
              ...input.contact,
              ...(normalizedPhone ? { phone: normalizedPhone } : {})
            }
          })
        : normalizedPhone
          ? await resolveSupportContactId(tx, actor.workspace.id, {
              contact: { phone: normalizedPhone }
            })
          : null);
    const { key, sequence } = await reserveTicketKey(tx, actor.workspace.id);
    const ticket = await tx.supportTicket.create({
      data: {
        workspaceId: actor.workspace.id,
        key,
        sequence,
        title: input.title,
        priority: input.priority,
        contactId,
        metadata: input.metadata ? input.metadata as Prisma.InputJsonValue : undefined,
        publicClientRequestId: input.clientRequestId
      },
      include: ticketInclude
    });
    if (content || input.metadata) {
      await createTicketMessage(tx, actor.workspace.id, ticket.id, {
        ...input,
        authorType: input.authorType,
        authorId: input.authorId ?? null
      }, content);
    }
    return { ticket, replayed: false };
  });
}

export async function addSupportTicketMessage(
  actor: RequestActor,
  idOrKey: string,
  input: SupportTicketMessageInput
) {
  const ticket = await findSupportTicket(actor, idOrKey);
  const content = input.text ? encryptSupportBytes(Buffer.from(input.text, 'utf8')) : null;
  return prisma.$transaction(async (tx) => {
    const current = await tx.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: ticketInclude
    });
    if (input.clientRequestId) {
      const replay = await tx.supportTicketMessage.findUnique({
        where: {
          workspaceId_publicClientRequestId: {
            workspaceId: actor.workspace.id,
            publicClientRequestId: input.clientRequestId
          }
        }
      });
      if (replay) return { ticket: current, replayed: true };
    }
    await createTicketMessage(tx, actor.workspace.id, current.id, input, content);
    const updated = await tx.supportTicket.update({
      where: { id: current.id },
      data: { status: 'OPEN', version: { increment: 1 } },
      include: ticketInclude
    });
    return { ticket: updated, replayed: false };
  });
}

export async function createCaseFromTicket(
  actor: RequestActor,
  idOrKey: string,
  input: {
    useAi?: boolean;
    title?: string;
    description?: string;
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    impact?: 'LOW' | 'MEDIUM' | 'HIGH';
    urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
    typeKey?: string;
    departmentId?: string;
  }
) {
  const ticket = await findSupportTicket(actor, idOrKey);
  if (ticket.case) return ticket.case;
  const draft = input.useAi ? await generateCaseDraftFromTicket(actor, ticket.id) : null;
  if (input.useAi && !draft) {
    throw new HttpError(503, 'AI Case draft is unavailable; create the Case manually', {
      code: 'SUPPORT_AI_DRAFT_UNAVAILABLE'
    });
  }
  const created = await createSupportCase(actor, {
    title: input.title || draft?.title || ticket.title,
    description: input.description ?? draft?.description ?? undefined,
    sourceChannel: 'API',
    typeKey: input.typeKey || draft?.typeKey || 'public-web',
    priority: input.priority || draft?.priority || ticket.priority,
    impact: input.impact || draft?.impact,
    urgency: input.urgency || draft?.urgency,
    contactId: ticket.contactId ?? undefined,
    departmentId: input.departmentId,
    metadata: {
      createdFromTicketId: ticket.id,
      createdFromTicketKey: ticket.key,
      aiFilled: Boolean(input.useAi)
    }
  });
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { caseId: created.supportCase.id, status: 'OPEN' }
  });
  return created.supportCase;
}

export async function updateCaseFromTicket(
  actor: RequestActor,
  idOrKey: string,
  input: {
    title?: string;
    description?: string | null;
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    impact?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
    urgency?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
    typeKey?: string;
    baseVersion: number;
  }
) {
  const ticket = await findSupportTicket(actor, idOrKey);
  if (!ticket.caseId) throw new HttpError(409, 'Support Ticket has no Case yet');
  const current = await findSupportCaseForAccess(actor, ticket.caseId);
  assertCanWorkCase(current.access, current.supportCase);
  if (current.supportCase.version !== input.baseVersion) {
    throw new HttpError(409, 'Support Case version is stale', {
      code: 'SUPPORT_CASE_VERSION_CONFLICT',
      current: serializeSupportCase(current.supportCase, current.access)
    });
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.supportCase.update({
      where: { id: current.supportCase.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.impact === undefined ? {} : { impact: input.impact }),
        ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
        ...(input.typeKey === undefined ? {} : { typeKey: input.typeKey }),
        version: { increment: 1 }
      },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: 'case.updated_from_ticket',
      before: caseEventSnapshot(current.supportCase),
      after: caseEventSnapshot(updated),
      reason: `Ticket ${ticket.key}`
    });
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id
    });
    return updated;
  });
}

async function createTicketMessage(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  ticketId: string,
  input: SupportTicketMessageInput,
  content: { ciphertext: Buffer; keyId: string } | null
) {
  return tx.supportTicketMessage.create({
    data: {
      workspaceId,
      ticketId,
      authorType: input.authorType,
      authorId: input.authorId ?? null,
      bodyCiphertext: content?.ciphertext ? Uint8Array.from(content.ciphertext) : undefined,
      bodyHash: content ? hashSupportPayload(Buffer.from(input.text || '', 'utf8')) : undefined,
      format: 'text/plain',
      metadata: input.metadata ? input.metadata as Prisma.InputJsonValue : undefined,
      publicClientRequestId: input.clientRequestId
    }
  });
}

async function reserveTicketKey(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`support-ticket-key:${workspaceId}`}))`;
  const latest = await tx.supportTicket.aggregate({
    where: { workspaceId },
    _max: { sequence: true }
  });
  const sequence = (latest._max.sequence ?? 0) + 1;
  return { sequence, key: `TKT-${sequence}` };
}

export async function generateCaseDraftFromTicket(actor: RequestActor, ticketId: string) {
  if (!config.TASKARA_OPENROUTER_API_KEY || !config.TASKARA_AI_MODEL) {
    throw new HttpError(503, 'AI Case drafting is not configured', {
      code: 'SUPPORT_AI_NOT_CONFIGURED'
    });
  }
  const messages = await prisma.supportTicketMessage.findMany({
    where: { workspaceId: actor.workspace.id, ticketId },
    orderBy: { createdAt: 'asc' },
    select: { authorType: true, bodyCiphertext: true, metadata: true }
  });
  const ticket = await prisma.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
    select: { title: true, priority: true }
  });
  return generatePublicSupportCaseDraft({
    messages: messages.map((message) => ({
      authorType: message.authorType,
      body: message.bodyCiphertext
        ? decryptSupportBytes(message.bodyCiphertext).toString('utf8')
        : null,
      metadata: message.metadata
    })),
    ticketTitle: ticket.title,
    ticketPriority: ticket.priority
  });
}

function encodeTicketCursor(item: { updatedAt: Date | string; id: string }) {
  return Buffer.from(JSON.stringify({
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    id: item.id
  }), 'utf8').toString('base64url');
}

function decodeTicketCursor(value: string): { updatedAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { updatedAt: string; id: string };
    const updatedAt = new Date(parsed.updatedAt);
    if (!parsed.id || Number.isNaN(updatedAt.getTime())) throw new Error('invalid');
    return { updatedAt, id: parsed.id };
  } catch {
    throw new HttpError(400, 'Invalid Support Ticket cursor');
  }
}
