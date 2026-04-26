import type { FastifyRequest } from 'fastify';
import { HttpError } from './http';
import type { MediaUploadInput } from './media';

export async function readMultipartMediaUpload(request: FastifyRequest): Promise<MediaUploadInput> {
  const file = await request.file();
  if (!file) throw new HttpError(400, 'Missing file field');

  const bytes = await file.toBuffer();
  return {
    bytes,
    filename: cleanFilename(file.filename),
    mimeType: file.mimetype,
    name: getMultipartFieldValue(file.fields.name)
  };
}

function getMultipartFieldValue(field: unknown): string | undefined {
  if (!field) return undefined;
  if (Array.isArray(field)) return getMultipartFieldValue(field[0]);
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && 'value' in field) {
    const value = (field as { value?: unknown }).value;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function cleanFilename(filename: string): string {
  return filename.split(/[\\/]/).pop()?.trim() || 'upload';
}
