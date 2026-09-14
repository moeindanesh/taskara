import { config } from '../config';
import { HttpError } from './http';
import { normalizeUploadedMediaInput, type UploadedMediaObject } from './media';

/** Called only after the route has resolved the authenticated actor and readable task. */
export async function uploadMultipartMedia(body: Buffer, contentType: string): Promise<UploadedMediaObject> {
  let input: FormData;
  try {
    input = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new HttpError(400, 'Invalid multipart upload');
  }
  const file = input.get('file');
  const name = input.get('name');
  if (!(file instanceof File) || input.getAll('file').length !== 1) {
    throw new HttpError(400, 'Exactly one file is required');
  }
  if (file.size === 0) throw new HttpError(400, 'File must not be empty');
  if (file.size > config.TASKARA_UPLOAD_MAX_BYTES) throw new HttpError(413, 'File exceeds upload limit');
  if (name !== null && (typeof name !== 'string' || !name.trim() || name.length > 300)) {
    throw new HttpError(400, 'Attachment name must contain 1–300 characters');
  }
  if (!config.TASKARA_CDN_UPLOAD_URL) throw new HttpError(503, 'TASKARA_CDN_UPLOAD_URL is required for uploads');
  const displayName = typeof name === 'string' ? name.trim() : file.name;
  const form = new FormData();
  form.set('file', file, file.name);
  form.set('name', displayName);
  form.set('app', config.TASKARA_CDN_APP);
  let response: Response;
  try {
    response = await fetch(config.TASKARA_CDN_UPLOAD_URL, {
      method: 'POST', body: form, signal: AbortSignal.timeout(60_000)
    });
  } catch {
    throw new HttpError(502, 'Media upload service is unreachable');
  }
  if (!response.ok) throw new HttpError(502, `Media upload service returned ${response.status}`);
  const data: unknown = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(502, 'Invalid media upload response');
  }
  const record = data as Record<string, unknown>;
  const value = (key: string) => typeof record[key] === 'string' ? record[key].trim() || undefined : undefined;
  const documentId = value('documentId') || value('id');
  const object = value('object') || documentId || value('url');
  if (!object) throw new HttpError(502, 'Media upload response is missing an object');
  return normalizeUploadedMediaInput({ documentId, object, name: displayName, mimeType: file.type, sizeBytes: file.size });
}
