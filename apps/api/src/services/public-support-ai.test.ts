import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../config';
import { generatePublicSupportCaseDraft, generatePublicSupportTicketAssessment, transcribePublicSupportAudio } from './public-support-ai';

const originalKey = config.TASKARA_OPENROUTER_API_KEY;
const originalModel = config.TASKARA_AI_MODEL;
const originalFetch = globalThis.fetch;
const originalMediaBase = config.TASKARA_CDN_MEDIA_BASE_URL;

afterEach(() => {
  config.TASKARA_OPENROUTER_API_KEY = originalKey;
  config.TASKARA_AI_MODEL = originalModel;
  config.TASKARA_CDN_MEDIA_BASE_URL = originalMediaBase;
  globalThis.fetch = originalFetch;
});

describe('public ticket AI assessment', () => {
  test('derives title and priority from the initial customer message', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    let prompt = '';
    globalThis.fetch = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<{ text: string }> }> };
      prompt = body.messages[0]?.content[0]?.text ?? '';
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ title: 'Payment failure', priority: 'HIGH' }) } }]
      });
    }, { preconnect: originalFetch.preconnect });

    expect(await generatePublicSupportTicketAssessment({ text: 'Checkout fails after payment.' })).toEqual({
      title: 'Payment failure',
      priority: 'HIGH'
    });
    expect(prompt).toContain('Checkout fails after payment.');
  });

  test('returns no assessment for an invalid provider priority', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    globalThis.fetch = Object.assign(
      async () => Response.json({
        choices: [{ message: { content: JSON.stringify({ title: 'Payment failure', priority: 'CRITICAL' }) } }]
      }),
      { preconnect: originalFetch.preconnect }
    );

    expect(await generatePublicSupportTicketAssessment({ text: 'Checkout fails.' })).toBeNull();
  });

  test('transcribes WebM voice before assessing its text and picture without trusting caller URLs', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    config.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
    let request: { messages: Array<{ content: Array<Record<string, unknown>> }> } | undefined;
    let transcriptionRequest: { max_tokens: number; messages: Array<{ content: unknown }> } | undefined;
    const fetched: string[] = [];
    globalThis.fetch = Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
      fetched.push(String(url));
      if (String(url).includes('/v1/media/')) {
        return new Response(String(url).endsWith('.webm') ? 'voice bytes' : 'image bytes');
      }
      const body = JSON.parse(String(init?.body));
      if (body.messages[0]?.role === 'system') {
        transcriptionRequest = body;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ transcript: 'پرداخت انجام شد اما خطا نمایش داده شد.' }) } }]
        });
      }
      request = body;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          title: 'خطای پرداخت در تصویر و صدا',
          priority: 'HIGH',
          transcript: 'پرداخت انجام شد اما خطا نمایش داده شد.'
        }) } }]
      });
    }, { preconnect: originalFetch.preconnect });

    expect(await generatePublicSupportTicketAssessment({
      text: 'پرداخت مشکل دارد',
      images: [{ object: 'support/screenshot.png', mimeType: 'image/png', url: 'https://untrusted.test/private' }],
      audio: [{ object: 'support/voice.webm', mimeType: 'audio/webm' }]
    })).toMatchObject({
      title: 'خطای پرداخت در تصویر و صدا',
      priority: 'HIGH',
      transcript: 'پرداخت انجام شد اما خطا نمایش داده شد.'
    });
    expect(fetched).toEqual([
      'https://cdn.example.test/v1/media/support/voice.webm',
      'https://openrouter.ai/api/v1/chat/completions',
      'https://cdn.example.test/v1/media/support/screenshot.png',
      'https://openrouter.ai/api/v1/chat/completions'
    ]);
    const parts = request?.messages[0]?.content || [];
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url']);
    expect(parts[0]?.text).toContain('پرداخت انجام شد اما خطا نمایش داده شد.');
    expect((parts[1]?.image_url as { url: string }).url).toStartWith('data:image/png;base64,');
    expect(transcriptionRequest?.max_tokens).toBe(config.TASKARA_AI_TRANSCRIPTION_MAX_OUTPUT_TOKENS);
    const audioPart = (transcriptionRequest?.messages[1]?.content as Array<{ input_audio: unknown }>)[1];
    expect(audioPart?.input_audio).toMatchObject({
      data: Buffer.from('voice bytes').toString('base64'),
      format: 'webm'
    });
  });

  test('does not generate a media-based title if a referenced file is unavailable', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    config.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
    let requests = 0;
    globalThis.fetch = Object.assign(async () => {
      requests += 1;
      return new Response(null, { status: 404 });
    }, { preconnect: originalFetch.preconnect });
    expect(await generatePublicSupportTicketAssessment({
      text: 'Please inspect this picture',
      images: [{ object: 'support/missing.png', mimeType: 'image/png' }]
    })).toBeNull();
    expect(requests).toBe(1);
  });

  test('returns no assessment without AI configuration', async () => {
    config.TASKARA_OPENROUTER_API_KEY = undefined;
    expect(await generatePublicSupportTicketAssessment({ text: 'Checkout fails.' })).toBeNull();
  });
});

describe('public Support voice transcription', () => {
  test('keeps separate transcripts in recording order, including a failed recording', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    config.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
    globalThis.fetch = Object.assign(async (url: URL | RequestInfo) => {
      if (String(url).endsWith('missing.webm')) return new Response(null, { status: 404 });
      if (String(url).includes('/v1/media/')) return new Response('voice bytes');
      return Response.json({
        choices: [{ message: { content: '```json\n{"transcript":"ثبت سفارش خطا می‌دهد."}\n```' } }]
      });
    }, { preconnect: originalFetch.preconnect });
    expect(await transcribePublicSupportAudio([
      { object: 'support/voice.webm', mimeType: 'audio/webm;codecs=opus' },
      { object: 'support/missing.webm', mimeType: 'audio/webm' }
    ])).toEqual([
      { status: 'COMPLETED', transcript: 'ثبت سفارش خطا می‌دهد.' },
      { status: 'UNAVAILABLE', transcript: null }
    ]);
  });

  test.each([
    { choices: [{ message: { content: '{"transcript":""}' } }] },
    { choices: [{ message: { content: '{"transcript":123}' } }] },
    { choices: [{ message: { content: 'invalid JSON' } }] },
    { choices: [{ finish_reason: 'length', message: { content: '{"transcript":"partial"}' } }] }
  ])('does not label empty, invalid, or truncated output as a completed transcript', async (response) => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    config.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
    globalThis.fetch = Object.assign(async (url: URL | RequestInfo) => {
      if (String(url).includes('/v1/media/')) return new Response('voice bytes');
      return Response.json(response);
    }, { preconnect: originalFetch.preconnect });
    expect(await transcribePublicSupportAudio([{ object: 'voice.webm', mimeType: 'audio/webm' }]))
      .toEqual([{ status: 'UNAVAILABLE', transcript: null }]);
  });

  test('does not fetch untrusted URLs or absolute object references', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    let fetched = false;
    globalThis.fetch = Object.assign(async () => {
      fetched = true;
      return new Response('should not be read');
    }, { preconnect: originalFetch.preconnect });
    expect(await transcribePublicSupportAudio([
      { url: 'http://127.0.0.1/private', mimeType: 'audio/webm' },
      { object: 'http://127.0.0.1/private', mimeType: 'audio/webm' }
    ])).toEqual([
      { status: 'UNAVAILABLE', transcript: null },
      { status: 'UNAVAILABLE', transcript: null }
    ]);
    expect(fetched).toBeFalse();
  });

  test('does not assess an untranscribed voice as if it had been read', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    expect(await generatePublicSupportTicketAssessment({
      text: 'Please inspect this recording',
      voiceTranscripts: [{ status: 'UNAVAILABLE', transcript: null }]
    })).toBeNull();
  });
});

describe('support Case AI draft', () => {
  const conversation = {
    ticketTitle: 'Checkout failure',
    ticketPriority: 'NORMAL',
    messages: [
      { authorType: 'CUSTOMER', body: 'Checkout fails after payment.', metadata: { metadata: { password: 'must-not-send' } } },
      { authorType: 'SUPPORTER', body: 'Which browser are you using?' },
      { authorType: 'CUSTOMER', body: 'Firefox. It affects everyone on our team.' }
    ]
  };

  test('accepts a fenced JSON draft and includes the bounded conversation', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    let request: { max_tokens: number; messages: Array<{ role: string; content: string }> } | undefined;
    globalThis.fetch = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{ message: {
          content: '```json\n{"title":"Checkout payment failure","description":"Payment succeeds but checkout does not complete for the team.","priority":"HIGH","impact":"HIGH","urgency":"MEDIUM"}\n```'
        } }]
      });
    }, { preconnect: originalFetch.preconnect });

    expect(await generatePublicSupportCaseDraft(conversation)).toEqual({
      title: 'Checkout payment failure',
      description: 'Payment succeeds but checkout does not complete for the team.',
      priority: 'HIGH',
      impact: 'HIGH',
      urgency: 'MEDIUM',
      typeKey: 'public-web'
    });
    expect(request?.max_tokens).toBe(config.TASKARA_AI_CASE_MAX_OUTPUT_TOKENS);
    expect(request?.messages[1]?.content).toContain('Firefox. It affects everyone on our team.');
    expect(request?.messages[1]?.content).toContain('supporter');
    expect(request?.messages[1]?.content).not.toContain('must-not-send');
  });

  test('does not claim an AI draft when the provider fails or returns invalid JSON', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), {
      preconnect: originalFetch.preconnect
    });
    expect(await generatePublicSupportCaseDraft(conversation)).toBeNull();

    globalThis.fetch = Object.assign(async () => Response.json({
      choices: [{ message: { content: '{"title":"Checkout","priority":"CRITICAL"}' } }]
    }), { preconnect: originalFetch.preconnect });
    expect(await generatePublicSupportCaseDraft(conversation)).toBeNull();
  });

  test('does not silently create a fallback when AI is unconfigured', async () => {
    config.TASKARA_OPENROUTER_API_KEY = undefined;
    expect(await generatePublicSupportCaseDraft(conversation)).toBeNull();
  });

  test('includes a saved voice-only transcript in the Case draft context', async () => {
    config.TASKARA_OPENROUTER_API_KEY = 'test-key';
    config.TASKARA_AI_MODEL = 'test-model';
    let context = '';
    globalThis.fetch = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
      context = JSON.parse(String(init?.body)).messages[1].content;
      return Response.json({
        choices: [{ message: { content: '{"title":"خطای سفارش","priority":"HIGH"}' } }]
      });
    }, { preconnect: originalFetch.preconnect });
    await generatePublicSupportCaseDraft({
      ...conversation,
      messages: [{
        authorType: 'CUSTOMER',
        body: null,
        metadata: { audio: [{ object: 'voice.webm' }], processing: { transcript: 'سفارش ثبت نمی‌شود.' } }
      }]
    });
    expect(context).toContain('سفارش ثبت نمی‌شود.');
  });
});
