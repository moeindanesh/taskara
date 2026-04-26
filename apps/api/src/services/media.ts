import { z } from 'zod';
import { config } from '../config';
import { HttpError } from './http';

const cdnUploadResponseSchema = z.object({
  documentId: z.string().min(1).optional(),
  object: z.string().min(1)
});

export interface MediaUploadInput {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
  name?: string;
}

export interface UploadedMediaObject {
  documentId?: string;
  object: string;
  url: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
}

export function buildMediaUrl(object: string): string {
  if (/^https?:\/\//i.test(object)) return object;
  if (!config.TASKARA_CDN_MEDIA_BASE_URL) {
    throw new HttpError(503, 'TASKARA_CDN_MEDIA_BASE_URL is required for media URLs');
  }

  const baseUrl = config.TASKARA_CDN_MEDIA_BASE_URL.replace(/\/+$/, '');
  const normalizedObject = object.replace(/^\/+/, '');
  if (normalizedObject.startsWith('v1/media/')) {
    return `${baseUrl}/${normalizedObject}`;
  }

  return `${baseUrl}/v1/media/${normalizedObject}`;
}

export async function uploadMediaToCdn(input: MediaUploadInput): Promise<UploadedMediaObject> {
  if (!config.TASKARA_CDN_UPLOAD_URL) {
    throw new HttpError(503, 'TASKARA_CDN_UPLOAD_URL is required for media uploads');
  }

  const form = new FormData();
  const mimeType = input.mimeType || 'application/octet-stream';
  const name = input.name?.trim() || input.filename;

  form.set('app', config.TASKARA_CDN_APP);
  form.set('name', name);
  form.set('file', new Blob([input.bytes as BlobPart], { type: mimeType }), input.filename);

  const response = await fetch(config.TASKARA_CDN_UPLOAD_URL, {
    method: 'POST',
    body: form
  });
  const text = await response.text();
  const body = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const message =
      typeof body?.message === 'string'
        ? body.message
        : `CDN upload failed with ${response.status} ${response.statusText}`;
    throw new HttpError(response.status >= 500 ? 502 : response.status, message);
  }

  const parsed = cdnUploadResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(502, 'CDN upload response was invalid');
  }

  return {
    documentId: parsed.data.documentId,
    object: parsed.data.object,
    url: buildMediaUrl(parsed.data.object),
    name,
    mimeType,
    sizeBytes: input.bytes.byteLength
  };
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
