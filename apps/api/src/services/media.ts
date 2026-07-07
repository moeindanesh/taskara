import { z } from 'zod';
import { config } from '../config';
import { HttpError } from './http';

export const uploadedMediaInputSchema = z.object({
  documentId: z.string().trim().min(1).optional(),
  object: z.string().trim().min(1).optional(),
  url: z.string().trim().url().optional(),
  name: z.string().trim().min(1).optional(),
  mimeType: z.string().trim().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().max(2147483647).optional()
}).refine((input) => input.documentId || input.object || input.url, {
  message: 'documentId, object, or url is required'
});

export type UploadedMediaInput = z.infer<typeof uploadedMediaInputSchema>;

export interface UploadedMediaObject {
  documentId?: string;
  object: string;
  url: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

export function buildMediaUrl(object: string): string {
  if (/^https?:\/\//i.test(object)) return object;
  if (!config.TASKARA_CDN_MEDIA_BASE_URL) {
    throw new HttpError(503, 'TASKARA_CDN_MEDIA_BASE_URL is required for media URLs');
  }

  return buildMediaUrlFromBase(config.TASKARA_CDN_MEDIA_BASE_URL, object);
}

export function buildMediaUrlFromBase(baseUrl: string, object: string): string {
  if (/^https?:\/\//i.test(object)) return object;

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1\/media$/i, '');
  const normalizedObject = object.replace(/^\/+/, '');
  if (normalizedObject.startsWith('v1/media/')) {
    return `${normalizedBaseUrl}/${normalizedObject}`;
  }

  return `${normalizedBaseUrl}/v1/media/${normalizedObject}`;
}

export function normalizeUploadedMediaInput(input: UploadedMediaInput): UploadedMediaObject {
  const object = input.object || input.documentId || input.url;
  if (!object) throw new HttpError(400, 'documentId, object, or url is required');

  return {
    ...(input.documentId ? { documentId: input.documentId } : {}),
    object,
    url: buildMediaUrl(object),
    name: input.name || 'upload',
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes })
  };
}
