import type { FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import {
  addSupportTicketMessage,
  createCaseFromTicket,
  findSupportTicket,
  generateCaseDraftFromTicket,
  listSupportTicketMessages,
  listSupportTickets,
  serializeSupportTicket,
  updateCaseFromTicket
} from '../services/support-tickets';
import { resolveSupportAccess } from '../services/support-access';
import { serializeSupportCase, findSupportCaseForAccess } from '../services/support-cases';
import { uploadMultipartMedia } from '../services/media-upload';

const listQuerySchema = z.object({
  status: z.enum(['NEW', 'OPEN', 'CLOSED']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const supporterMessageSchema = z.object({
  text: z.string().trim().max(100_000).optional(),
  metadata: z.record(z.unknown()).optional(),
  images: z.array(z.object({
    documentId: z.string().trim().min(1).max(300).optional(),
    object: z.string().trim().min(1).max(500),
    url: z.string().url().max(2_000).optional(),
    name: z.string().trim().min(1).max(300).optional(),
    mimeType: z.string().regex(/^image\//u),
    sizeBytes: z.number().int().positive().optional()
  }).strict()).max(8).optional(),
  clientRequestId: z.string().trim().min(8).max(200).optional()
}).refine((value) => Boolean(value.text || value.images?.length || value.metadata), {
  message: 'Message text or image is required'
});

const createCaseSchema = z.object({
  useAi: z.boolean().default(false),
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(50_000).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  impact: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  typeKey: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/).optional(),
  departmentId: z.string().uuid().optional()
});

const updateCaseSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(50_000).nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  impact: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable().optional(),
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable().optional(),
  typeKey: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/).optional(),
  baseVersion: z.coerce.number().int().positive()
});

const ticketPatchSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  status: z.enum(['NEW', 'OPEN', 'CLOSED']).optional(),
  baseVersion: z.number().int().positive().optional()
}).refine((value) => Boolean(value.title || value.priority || value.status), {
  message: 'At least one Ticket field is required'
});

export async function registerSupportTicketRoutes(app: FastifyInstance): Promise<void> {
  if (!app.hasContentTypeParser('multipart/form-data')) {
    app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  }

  app.get('/support/tickets', async (request) => {
    const actor = await getRequestActor(request);
    await assertTicketAccess(actor);
    return listSupportTickets(actor, listQuerySchema.parse(request.query));
  });

  app.get('/support/tickets/:idOrKey', async (request) => {
    const actor = await getRequestActor(request);
    await assertTicketAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const ticket = await findSupportTicket(actor, idOrKey);
    const messages = await listSupportTicketMessages(actor, idOrKey);
    const caseDetail = ticket.caseId
      ? await findSupportCaseForAccess(actor, ticket.caseId)
      : null;
    return {
      ticket: serializeSupportTicket(ticket),
      messages: messages.items,
      case: caseDetail
        ? serializeSupportCase(caseDetail.supportCase, caseDetail.access)
        : null
    };
  });

  app.post('/support/tickets/:idOrKey/messages', async (request, reply) => {
    const actor = await getRequestActor(request);
    await assertTicketAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = supporterMessageSchema.parse(request.body);
    const result = await addSupportTicketMessage(actor, idOrKey, {
      text: input.text,
      clientRequestId: input.clientRequestId,
      metadata: input.images?.length ? { ...input.metadata, images: input.images } : input.metadata,
      authorType: 'SUPPORTER',
      authorId: actor.user.id
    });
    return reply.code(result.replayed ? 200 : 201).send({
      ticket: serializeSupportTicket(result.ticket),
      replayed: result.replayed
    });
  });

  app.post('/support/tickets/:idOrKey/media', async (request, reply) => {
    const actor = await getRequestActor(request);
    await assertTicketAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    await findSupportTicket(actor, idOrKey);
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string') throw new HttpError(400, 'Multipart content type is required');
    const media = await uploadMultipartMedia(request.body as Buffer, contentType, {
      allowedMimeType: (mimeType) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)
    });
    return reply.code(201).send(media);
  });

  app.post('/support/tickets/:idOrKey/create-case', async (request, reply) => {
    const actor = await getRequestActor(request);
    await assertTicketAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = createCaseSchema.parse(request.body);
    const supportCase = await createCaseFromTicket(actor, idOrKey, input);
    const ticket = await findSupportTicket(actor, idOrKey);
    const caseDetail = await findSupportCaseForAccess(actor, supportCase.id);
    return reply.code(201).send({
      ticket: serializeSupportTicket(ticket),
      case: serializeSupportCase(caseDetail.supportCase, caseDetail.access),
      aiFilled: input.useAi
    });
  });

  app.post('/support/tickets/:idOrKey/ai-draft', async (request) => {
    const actor = await getRequestActor(request);
    await assertTicketAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const ticket = await findSupportTicket(actor, idOrKey);
    if (ticket.caseId) throw new HttpError(409, 'Support Ticket already has a Case');
    const draft = await generateCaseDraftFromTicket(actor, ticket.id);
    if (!draft) {
      throw new HttpError(503, 'AI Case draft is unavailable; create the Case manually', {
        code: 'SUPPORT_AI_DRAFT_UNAVAILABLE'
      });
    }
    const updated = await prisma.supportTicket.updateMany({
      where: {
        id: ticket.id,
        workspaceId: actor.workspace.id,
        version: ticket.version
      },
      data: { title: draft.title, version: { increment: 1 } }
    });
    if (!updated.count) {
      throw new HttpError(409, 'Support Ticket changed while generating its AI title', {
        code: 'SUPPORT_TICKET_VERSION_CONFLICT'
      });
    }
    return { draft, ticket: serializeSupportTicket(await findSupportTicket(actor, ticket.id)) };
  });

  app.patch('/support/tickets/:idOrKey/case', async (request) => {
    const actor = await getRequestActor(request);
    await assertTicketAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = updateCaseSchema.parse(request.body);
    await updateCaseFromTicket(actor, idOrKey, input);
    const ticket = await findSupportTicket(actor, idOrKey);
    if (!ticket.caseId) throw new HttpError(409, 'Support Ticket has no Case yet');
    const caseDetail = await findSupportCaseForAccess(actor, ticket.caseId);
    return {
      ticket: serializeSupportTicket(ticket),
      case: serializeSupportCase(caseDetail.supportCase, caseDetail.access)
    };
  });

  app.patch('/support/tickets/:idOrKey', async (request) => {
    const actor = await getRequestActor(request);
    await assertTicketAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = ticketPatchSchema.parse(request.body);
    const ticket = await findSupportTicket(actor, idOrKey);
    const { baseVersion, ...changes } = input;
    const updated = await prisma.supportTicket.updateMany({
      where: {
        id: ticket.id,
        workspaceId: actor.workspace.id,
        ...(baseVersion === undefined ? {} : { version: baseVersion })
      },
      data: { ...changes, version: { increment: 1 } }
    });
    if (!updated.count) {
      throw new HttpError(409, 'Support Ticket version is stale', { code: 'SUPPORT_TICKET_VERSION_CONFLICT' });
    }
    return serializeSupportTicket(await findSupportTicket(actor, ticket.key));
  });
}

async function assertTicketAccess(actor: Awaited<ReturnType<typeof getRequestActor>>) {
  const access = await resolveSupportAccess(actor);
  if (access.workspaceWide || access.triager) return access;
  throw new HttpError(403, 'Support Ticket access required');
}
