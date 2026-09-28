import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '@taskara/db';
import { z } from 'zod';
import { config } from '../config';
import { requireWorkspaceBySlug, type RequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import { assertSupportWorkspace } from '../services/workspace-mode';
import { buildMediaUrl } from '../services/media';
import { uploadMultipartMedia } from '../services/media-upload';
import { generatePublicSupportTicketAssessment, transcribePublicSupportAudio, type PublicSupportVoiceTranscript } from '../services/public-support-ai';
import {
  addSupportTicketMessage,
  createSupportTicket,
  findSupportTicket,
  listSupportTicketMessages,
  listSupportTickets,
  normalizeSupportPhone,
  serializeSupportTicket,
  ticketInclude
} from '../services/support-tickets';

const publicMediaSchema = z.object({
  documentId: z.string().trim().min(1).max(300).optional(),
  object: z.string().trim().min(1).max(500).optional(),
  url: z.string().trim().url().max(2_000).optional(),
  name: z.string().trim().min(1).max(300).optional(),
  mimeType: z.string().trim().min(1).max(120).optional(),
  sizeBytes: z.coerce.number().int().positive().max(config.TASKARA_UPLOAD_MAX_BYTES).optional(),
  durationSeconds: z.coerce.number().int().nonnegative().max(3_600).optional()
}).strict().refine((value) => Boolean(value.documentId || value.object || value.url), {
  message: 'A media reference is required'
});

const consoleErrorSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  stack: z.string().max(8_000).optional(),
  source: z.string().max(500).optional(),
  line: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
  column: z.coerce.number().int().nonnegative().max(1_000_000).optional()
}).strict();

const pageContextSchema = z.object({
  url: z.string().url().max(2_000).optional(),
  title: z.string().max(500).optional(),
  route: z.string().max(500).optional(),
  referrer: z.string().max(2_000).optional(),
  userAgent: z.string().max(500).optional(),
  viewport: z.object({
    width: z.coerce.number().int().positive().max(10_000),
    height: z.coerce.number().int().positive().max(10_000)
  }).optional(),
  locale: z.string().max(40).optional(),
  timezone: z.string().max(100).optional()
}).passthrough();

const publicSupportPayloadSchema = z.object({
  text: z.string().trim().max(100_000).optional(),
  phone: z.string().trim().regex(/^\+?\d{7,15}$/).optional(),
  images: z.array(publicMediaSchema).max(8).optional(),
  audio: z.array(publicMediaSchema).max(2).optional(),
  consoleErrors: z.array(consoleErrorSchema).max(50).optional(),
  pageContext: pageContextSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  clientRequestId: z.string().trim().min(8).max(200).optional(),
  contact: z.object({
    name: z.string().trim().min(1).max(160).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: z.string().trim().regex(/^\+?\d{7,15}$/).optional(),
    externalCustomerId: z.string().trim().min(1).max(240).optional()
  }).strict().refine((value) => Object.values(value).some(Boolean), {
    message: 'At least one contact identifier is required'
  }).optional()
}).strict().superRefine((value, context) => {
  const hasContent = Boolean(
    value.text
    || value.images?.length
    || value.audio?.length
    || value.consoleErrors?.length
    || value.pageContext
    || value.metadata && Object.keys(value.metadata).length
  );
  if (!hasContent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one of text, media, diagnostics, page context, or metadata is required'
    });
  }
  for (const media of value.images ?? []) {
    if (media.mimeType && !media.mimeType.toLowerCase().startsWith('image/')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['images'], message: 'Images must use an image MIME type' });
    }
  }
  for (const media of value.audio ?? []) {
    if (media.mimeType && !media.mimeType.toLowerCase().startsWith('audio/')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['audio'], message: 'Audio must use an audio MIME type' });
    }
  }
});

const publicListQuerySchema = z.object({
  phone: z.string().trim().regex(/^\+?\d{7,15}$/),
  status: z.enum(['NEW', 'OPEN', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'RESOLVED', 'CLOSED']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

const publicStatusSchema = z.object({
  status: z.enum(['OPEN', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']),
  baseVersion: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().max(2_000).optional()
});

const rateBuckets = new Map<string, { startedAt: number; count: number }>();

export async function registerPublicSupportRoutes(app: FastifyInstance): Promise<void> {
  if (!app.hasContentTypeParser('multipart/form-data')) {
    app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.get('/public/support/cases', async (request, reply) => {
    const actor = await publicActor(request, reply);
    const query = publicListQuerySchema.parse(request.query);
    const result = await listSupportTickets(actor, {
      phone: normalizeSupportPhone(query.phone),
      status: query.status === 'CLOSED' ? 'CLOSED' : query.status ? 'OPEN' : undefined,
      priority: query.priority,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit
    });
    return {
      ...result,
      items: result.items.map(publicTicketAsCase)
    };
  });

  app.get('/public/support/cases/:idOrKey', async (request, reply) => {
    const actor = await publicActor(request, reply);
    const { idOrKey } = request.params as { idOrKey: string };
    const ticket = await findSupportTicket(actor, idOrKey);
    const phone = (request.query as { phone?: string }).phone;
    if (phone && ticket.contact?.normalizedPhone !== normalizeSupportPhone(phone)) {
      throw new HttpError(404, 'Support Ticket not found');
    }
    return publicTicketDetail(actor, ticket);
  });

  app.post('/public/support/cases', async (request, reply) => {
    const actor = await publicActor(request, reply);
    const payload = publicSupportPayloadSchema.parse(request.body);
    const phone = payload.phone || payload.contact?.phone;
    if (!phone) throw new HttpError(400, 'Phone number is required');
    const voiceTranscripts = await transcribePublicSupportAudio(payload.audio ?? []);
    const assessment = await generatePublicSupportTicketAssessment({ ...payload, voiceTranscripts });
    const metadata = publicMetadata(payload, voiceTranscripts, assessment);
    const created = await createSupportTicket(actor, {
      title: assessment?.title || publicTitle(payload),
      priority: assessment?.priority ?? 'NORMAL',
      phone,
      contact: payload.contact,
      clientRequestId: payload.clientRequestId,
      metadata,
      text: payload.text,
      authorType: 'CUSTOMER',
      authorId: null
    });
    const detail = await publicTicketDetail(actor, created.ticket);
    return reply.code(created.replayed ? 200 : 201).send({ ...detail, replayed: created.replayed });
  });

  app.post('/public/support/media', async (request, reply) => {
    await publicActor(request, reply);
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string') throw new HttpError(400, 'Multipart content type is required');
    const media = await uploadMultipartMedia(request.body as Buffer, contentType, {
      allowedMimeType: (mimeType) => mimeType.startsWith('image/') || mimeType.startsWith('audio/'),
      // Bun classifies a WebM audio multipart part as video/webm from the filename.
      normalizeMimeType: (mimeType, filename) =>
        mimeType === 'video/webm' && /\.webm$/iu.test(filename) ? 'audio/webm' : mimeType
    });
    return reply.code(201).send(media);
  });

  app.post('/public/support/cases/:idOrKey/messages', async (request, reply) => {
    const actor = await publicActor(request, reply);
    const payload = publicSupportPayloadSchema.parse(request.body);
    const { idOrKey } = request.params as { idOrKey: string };
    const ticket = await findSupportTicket(actor, idOrKey);
    const phone = payload.phone || payload.contact?.phone;
    if (phone && ticket.contact?.normalizedPhone !== normalizeSupportPhone(phone)) {
      throw new HttpError(404, 'Support Ticket not found');
    }
    const voiceTranscripts = await transcribePublicSupportAudio(payload.audio ?? []);
    const result = await addSupportTicketMessage(actor, idOrKey, {
      authorType: 'CUSTOMER',
      authorId: null,
      text: payload.text,
      clientRequestId: payload.clientRequestId,
      metadata: publicMetadata(payload, voiceTranscripts)
    });
    const detail = await publicTicketDetail(actor, result.ticket);
    return reply.code(result.replayed ? 200 : 201).send({ ...detail, replayed: result.replayed });
  });

  app.patch('/public/support/cases/:idOrKey', async (request, reply) => {
    const actor = await publicActor(request, reply);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = publicStatusSchema.parse(request.body);
    const ticket = await findSupportTicket(actor, idOrKey);
    const updated = await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: input.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
        version: { increment: 1 }
      },
      include: ticketInclude
    });
    return publicTicketDetail(actor, updated);
  });

  app.get('/public/support/media/:id', async (request, reply) => {
    await publicActor(request, reply);
    const { id } = request.params as { id: string };
    return reply.redirect(buildMediaUrl(id, { allowAbsolute: false }));
  });
}

async function publicActor(request: FastifyRequest, reply: { header(name: string, value: string): unknown }): Promise<RequestActor> {
  if (!config.TASKARA_PUBLIC_SUPPORT_ENABLED) throw new HttpError(404, 'Public Support integration is disabled');
  const slug = config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG;
  if (!slug) throw new HttpError(503, 'Public Support integration is not configured');
  const workspace = await requireWorkspaceBySlug(slug);
  assertSupportWorkspace(workspace);
  const now = Date.now();
  const ip = request.ip || 'unknown';
  const bucket = rateBuckets.get(ip);
  if (rateBuckets.size > 10_000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.startedAt >= 60_000) rateBuckets.delete(key);
    }
  }
  if (!bucket || now - bucket.startedAt >= 60_000) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
  } else {
    bucket.count += 1;
    if (bucket.count > config.TASKARA_PUBLIC_SUPPORT_RATE_LIMIT_PER_MINUTE) {
      reply.header('retry-after', '60');
      throw new HttpError(429, 'Public Support rate limit exceeded', { code: 'PUBLIC_SUPPORT_RATE_LIMITED' });
    }
  }
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: workspace.id, role: 'OWNER' },
    include: { user: true }
  });
  if (!membership) throw new HttpError(503, 'Public Support workspace has no owner');
  const correlationId = request.headers['x-request-id'];
  reply.header('x-request-id', typeof correlationId === 'string' && correlationId.length <= 160 ? correlationId : randomUUID());
  return {
    workspace,
    user: membership.user,
    role: membership.role,
    actorType: 'USER',
    actorRuntime: null,
    source: 'API'
  };
}

async function publicTicketDetail(
  actor: RequestActor,
  ticket: Awaited<ReturnType<typeof findSupportTicket>>
) {
  const messages = await listSupportTicketMessages(actor, ticket.key);
  const projection = serializeSupportTicket(ticket);
  return {
    ticket: projection,
    // Keep the existing response field for consumers that still read `case`.
    case: publicTicketAsCase(projection),
    timeline: messages.items.map((message) => ({
      id: message.id,
      kind: 'MESSAGE',
      direction: message.authorType === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND',
      occurredAt: message.createdAt,
      receivedAt: message.createdAt,
      content: message.body ? { body: message.body, format: message.format } : null,
      metadata: message.metadata
    })),
    events: []
  };
}

function publicTicketAsCase(ticket: ReturnType<typeof serializeSupportTicket>) {
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    sourceChannel: 'API',
    description: null,
    receivedAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    version: ticket.version,
    department: null,
    assignee: null,
    contact: ticket.contact,
    metadata: null,
    linkedCase: ticket.case
  };
}

function publicTitle(payload: z.infer<typeof publicSupportPayloadSchema>): string {
  const firstLine = payload.text?.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (firstLine) return firstLine.slice(0, 240);
  if (payload.images?.length && payload.audio?.length) return 'درخواست پشتیبانی با تصویر و صدا';
  if (payload.images?.length) return 'درخواست پشتیبانی با تصویر';
  if (payload.audio?.length) return 'درخواست پشتیبانی صوتی';
  return 'درخواست پشتیبانی جدید';
}

function publicMetadata(
  payload: z.infer<typeof publicSupportPayloadSchema>,
  voiceTranscripts: PublicSupportVoiceTranscript[],
  assessment?: Awaited<ReturnType<typeof generatePublicSupportTicketAssessment>> | null
): Record<string, unknown> {
  const metadata = redactAndBound({
    images: payload.images,
    audio: payload.audio,
    consoleErrors: payload.consoleErrors,
    pageContext: payload.pageContext,
    metadata: payload.metadata,
    clientRequestId: payload.clientRequestId
  }) as Record<string, unknown>;
  // Bound caller metadata separately so generated transcripts are not truncated with diagnostics.
  return {
    ...metadata,
    processing: {
      transcription: !voiceTranscripts.length ? 'NOT_REQUESTED'
        : voiceTranscripts.every((entry) => entry.status === 'COMPLETED') ? 'COMPLETED' : 'UNAVAILABLE',
      transcript: voiceTranscripts.map((entry) => entry.transcript).filter(Boolean).join('\n\n') || null,
      transcripts: voiceTranscripts,
      title: assessment === undefined ? 'NOT_REQUESTED'
        : assessment ? 'GENERATED' : payload.text ? 'FALLBACK_FROM_TEXT' : 'FALLBACK_DETERMINISTIC',
      errorCode: voiceTranscripts.some((entry) => entry.status === 'UNAVAILABLE')
        ? config.TASKARA_OPENROUTER_API_KEY ? 'AUDIO_PROCESSING_UNAVAILABLE' : 'TRANSCRIPTION_NOT_CONFIGURED'
        : null
    }
  };
}

function redactAndBound(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return value.length > 2_000 ? `${value.slice(0, 1_997)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactAndBound(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(authorization|cookie|token|password|secret|api[-_]?key)/iu.test(key)) continue;
    output[key] = redactAndBound(entry, depth + 1);
  }
  const serialized = JSON.stringify(output);
  if (serialized.length > 32_000) return { truncated: true, preview: serialized.slice(0, 31_900) };
  return output;
}
