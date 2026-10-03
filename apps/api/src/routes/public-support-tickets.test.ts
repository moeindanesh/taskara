import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config';
import { errorMessage, HttpError, statusCodeFromError } from '../services/http';
import { registerPublicSupportRoutes } from './public-support';
import { registerSupportTicketRoutes } from './support-tickets';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];
const originalFetch = globalThis.fetch;
const originalConfig = {
  enabled: config.TASKARA_PUBLIC_SUPPORT_ENABLED,
  slug: config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG,
  secret: config.TASKARA_SUPPORT_DATA_SECRET,
  aiKey: config.TASKARA_OPENROUTER_API_KEY,
  aiModel: config.TASKARA_AI_MODEL,
  uploadUrl: config.TASKARA_CDN_UPLOAD_URL,
  mediaBase: config.TASKARA_CDN_MEDIA_BASE_URL
};

describe('Public Support Ticket routes', () => {
  beforeAll(async () => {
    config.TASKARA_PUBLIC_SUPPORT_ENABLED = true;
    config.TASKARA_SUPPORT_DATA_SECRET ||= `${crypto.randomUUID()}${crypto.randomUUID()}`;
    config.TASKARA_OPENROUTER_API_KEY = undefined;
    config.TASKARA_AI_MODEL = undefined;
    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.code(400).send({ message: 'Validation failed', issues: error.issues });
      }
      const message = errorMessage(error);
      return reply.code(statusCodeFromError(error, message)).send({
        message,
        ...(error instanceof HttpError ? error.details : undefined)
      });
    });
    await app.register(registerPublicSupportRoutes);
    await app.register(registerSupportTicketRoutes);
    await app.ready();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    config.TASKARA_OPENROUTER_API_KEY = undefined;
    config.TASKARA_AI_MODEL = undefined;
    config.TASKARA_CDN_UPLOAD_URL = originalConfig.uploadUrl;
    config.TASKARA_CDN_MEDIA_BASE_URL = originalConfig.mediaBase;
    const workspaceIds = cleanupWorkspaceIds.splice(0);
    if (workspaceIds.length) {
      await prisma.supportTicket.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.supportCase.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    const userIds = cleanupUserIds.splice(0);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  afterAll(async () => {
    await app.close();
    config.TASKARA_PUBLIC_SUPPORT_ENABLED = originalConfig.enabled;
    config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG = originalConfig.slug;
    config.TASKARA_SUPPORT_DATA_SECRET = originalConfig.secret;
    config.TASKARA_OPENROUTER_API_KEY = originalConfig.aiKey;
    config.TASKARA_AI_MODEL = originalConfig.aiModel;
    config.TASKARA_CDN_UPLOAD_URL = originalConfig.uploadUrl;
    config.TASKARA_CDN_MEDIA_BASE_URL = originalConfig.mediaBase;
    globalThis.fetch = originalFetch;
  });

  test('keeps public paths, scopes lists by normalized phone, and converts chat to a separate Case', async () => {
    const fixture = await createFixture();
    config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG = fixture.workspace.slug;
    const clientRequestId = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: '/public/support/cases',
      payload: {
        phone: '09399569034',
        text: 'Checkout fails after payment.',
        clientRequestId
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().case.key).toStartWith('TKT-');
    expect(created.json().ticket.caseId).toBeNull();
    const ticketKey = created.json().case.key as string;

    const customerPriority = await app.inject({
      method: 'POST',
      url: '/public/support/cases',
      payload: { phone: '09399569034', text: 'Please help.', priority: 'URGENT' }
    });
    expect(customerPriority.statusCode).toBe(400);

    const [local, international, unrelated] = await Promise.all([
      app.inject({ method: 'GET', url: '/public/support/cases?phone=09399569034' }),
      app.inject({ method: 'GET', url: '/public/support/cases?phone=%2B989399569034' }),
      app.inject({ method: 'GET', url: '/public/support/cases?phone=%2B989121234567' })
    ]);
    expect(local.json().items.map((item: { key: string }) => item.key)).toEqual([ticketKey]);
    expect(international.json().items.map((item: { key: string }) => item.key)).toEqual([ticketKey]);
    expect(unrelated.json().items).toEqual([]);

    const reply = await app.inject({
      method: 'POST',
      url: `/public/support/cases/${ticketKey}/messages`,
      payload: {
        phone: '+989399569034',
        text: 'It still fails.',
        clientRequestId: crypto.randomUUID()
      }
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().timeline).toHaveLength(2);

    const unavailable = await app.inject({
      method: 'POST',
      url: `/support/tickets/${ticketKey}/ai-draft`,
      headers: headers(fixture.workspace.slug, fixture.owner.email)
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().code).toBe('SUPPORT_AI_NOT_CONFIGURED');

    const noSilentFallback = await app.inject({
      method: 'POST',
      url: `/support/tickets/${ticketKey}/create-case`,
      headers: headers(fixture.workspace.slug, fixture.owner.email),
      payload: { useAi: true }
    });
    expect(noSilentFallback.statusCode).toBe(503);

    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    globalThis.fetch = Object.assign(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        title: 'Checkout payment failure',
        description: 'The customer cannot complete checkout after payment.',
        priority: 'HIGH',
        impact: 'HIGH'
      }) } }]
    }), { preconnect: originalFetch.preconnect });
    const suggested = await app.inject({
      method: 'POST',
      url: `/support/tickets/${ticketKey}/ai-draft`,
      headers: headers(fixture.workspace.slug, fixture.owner.email)
    });
    expect(suggested.statusCode).toBe(200);
    expect(suggested.json().draft).toMatchObject({
      title: 'Checkout payment failure',
      priority: 'HIGH',
      impact: 'HIGH'
    });
    expect(suggested.json().ticket.title).toBe('Checkout payment failure');
    const generatedTicket = await prisma.supportTicket.findUniqueOrThrow({
      where: { workspaceId_key: { workspaceId: fixture.workspace.id, key: ticketKey } }
    });
    expect(generatedTicket.title).toBe('Checkout payment failure');
    expect(generatedTicket.version).toBe(suggested.json().ticket.version);
    const publicDetail = await app.inject({
      method: 'GET',
      url: `/public/support/cases/${ticketKey}?phone=%2B989399569034`
    });
    expect(publicDetail.statusCode).toBe(200);
    expect(publicDetail.json().ticket.title).toBe('Checkout payment failure');
    config.TASKARA_OPENROUTER_API_KEY = undefined;
    config.TASKARA_AI_MODEL = undefined;
    globalThis.fetch = originalFetch;

    const converted = await app.inject({
      method: 'POST',
      url: `/support/tickets/${ticketKey}/create-case`,
      headers: headers(fixture.workspace.slug, fixture.owner.email),
      payload: { useAi: false, ...suggested.json().draft }
    });
    expect(converted.statusCode).toBe(201);
    expect(converted.json().case.key).toStartWith('TST-');

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { workspaceId_key: { workspaceId: fixture.workspace.id, key: ticketKey } }
    });
    expect(await prisma.supportTicketMessage.count({ where: { ticketId: ticket.id } })).toBe(2);
    expect(await prisma.supportInteraction.count({ where: { caseId: ticket.caseId! } })).toBe(0);
  });

  test('preserves the Ticket title when AI fails or the Ticket changes during generation', async () => {
    const fixture = await createFixture();
    config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG = fixture.workspace.slug;
    const created = await app.inject({
      method: 'POST',
      url: '/public/support/cases',
      payload: { phone: '09399569034', text: 'Checkout fails.' }
    });
    expect(created.statusCode).toBe(201);
    const ticket = created.json().ticket;
    const request = {
      method: 'POST' as const,
      url: `/support/tickets/${ticket.key}/ai-draft`,
      headers: headers(fixture.workspace.slug, fixture.owner.email)
    };
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), {
      preconnect: originalFetch.preconnect
    });
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(503);
    expect(await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      title: ticket.title,
      version: ticket.version
    });

    globalThis.fetch = Object.assign(async () => {
      await prisma.supportTicket.update({
        where: { id: ticket.id },
        data: { title: 'Manually revised title', version: { increment: 1 } }
      });
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ title: 'Generated title', priority: 'HIGH' }) } }]
      });
    }, { preconnect: originalFetch.preconnect });
    const conflict = await app.inject(request);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('SUPPORT_TICKET_VERSION_CONFLICT');
    expect(await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      title: 'Manually revised title',
      version: ticket.version + 1
    });
  });

  test('closes and reopens a ticket, uploads an image, and stores an image-only supporter reply', async () => {
    const fixture = await createFixture();
    config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG = fixture.workspace.slug;
    const created = await app.inject({
      method: 'POST',
      url: '/public/support/cases',
      payload: { phone: '09399569034', text: 'تصویر پیوست می‌شود.' }
    });
    const ticket = created.json().ticket;
    const auth = headers(fixture.workspace.slug, fixture.owner.email);

    const closed = await app.inject({
      method: 'PATCH',
      url: `/support/tickets/${ticket.key}`,
      headers: auth,
      payload: { status: 'CLOSED', baseVersion: ticket.version }
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'CLOSED', version: ticket.version + 1 });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/support/tickets/${ticket.key}`,
      headers: auth,
      payload: { status: 'OPEN', baseVersion: ticket.version }
    });
    expect(stale.statusCode).toBe(409);
    const reopened = await app.inject({
      method: 'PATCH',
      url: `/support/tickets/${ticket.key}`,
      headers: auth,
      payload: { status: 'OPEN', baseVersion: closed.json().version }
    });
    expect(reopened.json().status).toBe('OPEN');
    const reprioritized = await app.inject({
      method: 'PATCH',
      url: `/support/tickets/${ticket.key}`,
      headers: auth,
      payload: { priority: 'HIGH', baseVersion: reopened.json().version }
    });
    expect(reprioritized.statusCode).toBe(200);
    expect(reprioritized.json()).toMatchObject({
      priority: 'HIGH',
      version: reopened.json().version + 1
    });
    const stalePriority = await app.inject({
      method: 'PATCH',
      url: `/support/tickets/${ticket.key}`,
      headers: auth,
      payload: { priority: 'URGENT', baseVersion: reopened.json().version }
    });
    expect(stalePriority.statusCode).toBe(409);
    const customerList = await app.inject({
      method: 'GET',
      url: '/public/support/cases?phone=09399569034&priority=HIGH'
    });
    expect(customerList.json().items[0]).toMatchObject({ key: ticket.key, priority: 'HIGH' });

    config.TASKARA_CDN_UPLOAD_URL = 'https://upload.example.test';
    globalThis.fetch = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(((init?.body as FormData).get('file') as File).type).toBe('image/png');
      return Response.json({ object: 'support/reply.png', url: 'https://cdn.example.test/play/reply.png' });
    }, { preconnect: originalFetch.preconnect });
    const boundary = 'taskara-image-reply';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reply.png"\r\n` +
      `Content-Type: image/png\r\n\r\nimage bytes\r\n--${boundary}--\r\n`
    );
    const uploaded = await app.inject({
      method: 'POST',
      url: `/support/tickets/${ticket.key}/media`,
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({
      object: 'support/reply.png',
      url: 'https://cdn.example.test/play/reply.png',
      mimeType: 'image/png'
    });
    globalThis.fetch = originalFetch;

    const reply = await app.inject({
      method: 'POST',
      url: `/support/tickets/${ticket.key}/messages`,
      headers: auth,
      payload: { images: [uploaded.json()], clientRequestId: crypto.randomUUID() }
    });
    expect(reply.statusCode).toBe(201);
    const detail = await app.inject({
      method: 'GET',
      url: `/support/tickets/${ticket.key}`,
      headers: auth
    });
    expect(detail.json().messages[1]).toMatchObject({
      authorType: 'SUPPORTER',
      body: null,
      metadata: { images: [{ object: 'support/reply.png' }] }
    });
  });

  test('creates a Ticket with a title assessed from text, image, and voice', async () => {
    const fixture = await createFixture();
    config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG = fixture.workspace.slug;
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    config.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
    let parts: Array<{ type: string; text?: string }> = [];
    let transcriptionCalls = 0;
    globalThis.fetch = Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).startsWith('https://cdn.example.test/')) {
        return new Response(String(url).endsWith('.webm') ? 'voice bytes' : 'image bytes');
      }
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
      if (request.messages[0]?.role === 'system') {
        transcriptionCalls += 1;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ transcript: 'هنگام پرداخت خطا می‌بینم.' }) } }]
        });
      }
      parts = request.messages[0]?.content || [];
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          title: 'مشکل ثبت سفارش',
          priority: 'HIGH',
          transcript: 'هنگام پرداخت خطا می‌بینم.'
        }) } }]
      });
    }, { preconnect: originalFetch.preconnect });

    const created = await app.inject({
      method: 'POST',
      url: '/public/support/cases',
      payload: {
        phone: '09399569034',
        text: 'سفارش ثبت نمی‌شود.',
        images: [{ object: 'support/screenshot.png', mimeType: 'image/png' }],
        audio: [{ object: 'support/voice.webm', mimeType: 'audio/webm' }]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().ticket).toMatchObject({ title: 'مشکل ثبت سفارش', priority: 'HIGH' });
    expect(transcriptionCalls).toBe(1);
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url']);
    expect(parts[0]?.text).toContain('هنگام پرداخت خطا می‌بینم.');
    expect(created.json().timeline[0].metadata.processing).toMatchObject({
      transcription: 'COMPLETED',
      title: 'GENERATED',
      transcript: 'هنگام پرداخت خطا می‌بینم.'
    });
  });

  test('uses a voice-only first message for Ticket title/priority and transcribes follow-up voices without changing them', async () => {
    const fixture = await createFixture();
    config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG = fixture.workspace.slug;
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    config.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
    let transcriptions = 0;
    let assessments = 0;
    globalThis.fetch = Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).startsWith('https://cdn.example.test/')) return new Response('voice bytes');
      const body = JSON.parse(String(init?.body));
      if (body.messages[0].role === 'system') {
        transcriptions += 1;
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          transcript: transcriptions === 1 ? 'پرداخت برای همه کاربران قطع شده است.' : 'هنوز همان مشکل را دارم.'
        }) } }] });
      }
      assessments += 1;
      expect(body.messages[0].content[0].text).toContain('پرداخت برای همه کاربران قطع شده است.');
      return Response.json({ choices: [{ message: { content: '{"title":"قطعی پرداخت","priority":"URGENT"}' } }] });
    }, { preconnect: originalFetch.preconnect });
    const created = await app.inject({
      method: 'POST',
      url: '/public/support/cases',
      payload: { phone: '09399569034', audio: [{ object: 'first.webm', mimeType: 'audio/webm' }] }
    });
    expect(created.statusCode).toBe(201);
    const ticket = created.json().ticket;
    expect(ticket).toMatchObject({ title: 'قطعی پرداخت', priority: 'URGENT' });
    expect(created.json().timeline[0].content).toBeNull();
    expect(created.json().timeline[0].metadata.processing.transcripts).toEqual([
      { status: 'COMPLETED', transcript: 'پرداخت برای همه کاربران قطع شده است.' }
    ]);
    const followup = await app.inject({
      method: 'POST',
      url: `/public/support/cases/${ticket.key}/messages`,
      payload: { phone: '09399569034', audio: [{ object: 'second.webm', mimeType: 'audio/webm' }] }
    });
    expect(followup.statusCode).toBe(201);
    expect(followup.json().ticket).toMatchObject({ title: 'قطعی پرداخت', priority: 'URGENT' });
    expect(followup.json().timeline[1].metadata.processing.transcripts).toEqual([
      { status: 'COMPLETED', transcript: 'هنوز همان مشکل را دارم.' }
    ]);
    expect(transcriptions).toBe(2);
    expect(assessments).toBe(1);

    const staff = await app.inject({
      method: 'GET', url: `/support/tickets/${ticket.key}`,
      headers: headers(fixture.workspace.slug, fixture.owner.email)
    });
    expect(staff.statusCode).toBe(200);
    expect(staff.json().messages[1].metadata.processing.transcript).toBe('هنوز همان مشکل را دارم.');
  });

  test('keeps voice text when title assessment fails and preserves audio when transcription fails', async () => {
    const fixture = await createFixture();
    config.TASKARA_PUBLIC_SUPPORT_WORKSPACE_SLUG = fixture.workspace.slug;
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    config.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
    const transcript = 'ثبت سفارش ناموفق است. '.repeat(150).trim();
    globalThis.fetch = Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).startsWith('https://cdn.example.test/')) return new Response('voice bytes');
      const body = JSON.parse(String(init?.body));
      return body.messages[0].role === 'system'
        ? Response.json({ choices: [{ message: { content: JSON.stringify({ transcript }) } }] })
        : new Response(null, { status: 503 });
    }, { preconnect: originalFetch.preconnect });
    const created = await app.inject({
      method: 'POST', url: '/public/support/cases',
      payload: { phone: '09399569034', audio: [{ object: 'voice.webm', mimeType: 'audio/webm' }] }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().ticket).toMatchObject({ title: 'درخواست پشتیبانی صوتی', priority: 'NORMAL' });
    expect(created.json().timeline[0].metadata.processing.transcript).toBe(transcript.trim());

    globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), {
      preconnect: originalFetch.preconnect
    });
    const failed = await app.inject({
      method: 'POST', url: `/public/support/cases/${created.json().ticket.key}/messages`,
      payload: { phone: '09399569034', audio: [{ object: 'next.webm', mimeType: 'audio/webm' }] }
    });
    expect(failed.statusCode).toBe(201);
    expect(failed.json().timeline[1].metadata).toMatchObject({
      audio: [{ object: 'next.webm' }],
      processing: { transcription: 'UNAVAILABLE', transcript: null }
    });
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await prisma.user.create({
    data: { email: `owner-${suffix}@public-support-ticket.test`, name: 'Ticket Owner' }
  });
  const workspace = await prisma.workspace.create({
    data: { name: 'Public Ticket Test', slug: `public-ticket-${suffix}`, mode: 'SUPPORT' }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
  });
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'TST', nextCaseNumber: 1 }
  });
  cleanupWorkspaceIds.push(workspace.id);
  cleanupUserIds.push(owner.id);
  return { owner, workspace };
}

function headers(workspaceSlug: string, email: string) {
  return { 'x-workspace-slug': workspaceSlug, 'x-user-email': email };
}
