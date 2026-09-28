import { describe, expect, test } from 'bun:test';

process.env.API_HOST = '127.0.0.1';
process.env.API_PORT = '4000';
process.env.WEB_ORIGIN = 'http://localhost:3005';
process.env.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
process.env.MATTERMOST_SYNTHETIC_EMAIL_DOMAIN = 'mattermost.example.invalid';

const { buildMediaUrl, buildMediaUrlFromBase, normalizeUploadedMediaInput, uploadedMediaInputSchema } = await import('./media');
const { uploadMultipartMedia } = await import('./media-upload');
const { config } = await import('../config');

describe('media URL handling', () => {
  test('builds CDN URLs whether the base is the CDN root or media endpoint', () => {
    expect(buildMediaUrlFromBase('https://cdn.example.test', 'objects/file.png')).toBe(
      'https://cdn.example.test/v1/media/objects/file.png'
    );
    expect(buildMediaUrlFromBase('https://cdn.example.test/v1/media/', 'objects/file.png')).toBe(
      'https://cdn.example.test/v1/media/objects/file.png'
    );
    expect(buildMediaUrlFromBase('https://cdn.example.test/v1/media/', '/v1/media/objects/file.png')).toBe(
      'https://cdn.example.test/v1/media/objects/file.png'
    );
  });

  test('keeps absolute CDN objects unchanged', () => {
    expect(buildMediaUrlFromBase('https://cdn.example.test/v1/media/', 'https://assets.example.test/file.png')).toBe(
      'https://assets.example.test/file.png'
    );
  });

  test('normalizes uploaded media metadata for attachment registration', () => {
    const input = uploadedMediaInputSchema.parse({
      documentId: 'doc-1',
      object: 'objects/file.txt',
      name: 'Public name',
      mimeType: 'text/plain',
      sizeBytes: 5
    });

    expect(normalizeUploadedMediaInput(input)).toEqual({
      documentId: 'doc-1',
      object: 'objects/file.txt',
      url: 'https://cdn.example.test/v1/media/objects/file.txt',
      name: 'Public name',
      mimeType: 'text/plain',
      sizeBytes: 5
    });
  });

  test('uses documentId as the media object when that is all the CDN returns', () => {
    const input = uploadedMediaInputSchema.parse({
      documentId: 'doc-only',
      name: 'Document only'
    });

    expect(normalizeUploadedMediaInput(input)).toMatchObject({
      documentId: 'doc-only',
      object: 'doc-only',
      url: 'https://cdn.example.test/v1/media/doc-only',
      name: 'Document only'
    });
  });

  test('preserves the CDN playback URL when it differs from the storage object', () => {
    expect(normalizeUploadedMediaInput({
      object: 'objects/voice.webm',
      url: 'https://assets.example.test/play/voice.webm',
      name: 'voice.webm',
      mimeType: 'audio/webm'
    })).toMatchObject({
      object: 'objects/voice.webm',
      url: 'https://assets.example.test/play/voice.webm'
    });
  });
});

describe('media upload playback URL', () => {
  test('returns the CDN-provided URL with the uploaded object', async () => {
    const previousUrl = config.TASKARA_CDN_UPLOAD_URL;
    const previousFetch = globalThis.fetch;
    config.TASKARA_CDN_UPLOAD_URL = 'https://upload.example.test';
    try {
      const boundary = 'taskara-voice-test';
      const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.webm"\r\n` +
        `Content-Type: audio/webm\r\n\r\nvoice bytes\r\n--${boundary}--\r\n`
      );
      globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
        expect((init?.body as FormData).get('file')).toBeInstanceOf(File);
        expect(((init?.body as FormData).get('file') as File).type).toBe('audio/webm');
        return Response.json({
          object: 'objects/voice.webm',
          url: 'https://assets.example.test/play/voice.webm'
        });
      }, { preconnect: previousFetch.preconnect });
      const result = await uploadMultipartMedia(body, `multipart/form-data; boundary=${boundary}`, {
        allowedMimeType: (mime) => mime.startsWith('audio/'),
        normalizeMimeType: (mime, filename) =>
          mime === 'video/webm' && filename.endsWith('.webm') ? 'audio/webm' : mime
      });
      expect(result).toMatchObject({
        object: 'objects/voice.webm',
        url: 'https://assets.example.test/play/voice.webm',
        mimeType: 'audio/webm'
      });
    } finally {
      config.TASKARA_CDN_UPLOAD_URL = previousUrl;
      globalThis.fetch = previousFetch;
    }
  });
});

/**
 * A caller-supplied object is not an address.
 *
 * `buildMediaUrl` passes an absolute URL through, which is right for a stored attachment — the CDN
 * hands one back and the row genuinely holds the address. `GET /media/*` takes its object from the
 * request path, so there the same branch lets the caller choose the destination of a redirect
 * served from Taskara's own domain.
 *
 * Written as a property of the two modes rather than as a reproduction: this repository is public,
 * and a test named after the route it abuses is the recipe written down.
 */
describe('media url pass-through is opt-in', () => {
  test('a stored attachment keeps its absolute url', () => {
    expect(buildMediaUrl('https://cdn.example.test/v1/media/stored.png')).toBe(
      'https://cdn.example.test/v1/media/stored.png'
    );
  });

  test('a caller-supplied object may not be an absolute url', () => {
    expect(() => buildMediaUrl('https://elsewhere.example.test/x.png', { allowAbsolute: false })).toThrow(
      /storage key/
    );
  });

  test('a storage key still resolves when pass-through is refused', () => {
    expect(buildMediaUrl('some/object/key.png', { allowAbsolute: false })).toContain('some/object/key.png');
  });
});
