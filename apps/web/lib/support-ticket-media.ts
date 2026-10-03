import { taskaraApiBaseUrl } from './taskara-client';

export interface SupportTicketMedia {
   documentId?: string;
   object?: string;
   url?: string;
   name?: string;
   mimeType?: string;
   sizeBytes?: number;
   durationSeconds?: number;
}

export interface SupportVoiceTranscript {
   status: 'COMPLETED' | 'UNAVAILABLE' | 'NOT_REQUESTED';
   transcript: string | null;
}

export function ticketVoiceTranscript(
   metadata: Record<string, unknown> | null | undefined,
   index: number
): SupportVoiceTranscript {
   const processing = metadata?.processing;
   if (!processing || typeof processing !== 'object' || Array.isArray(processing)) {
      return { status: 'NOT_REQUESTED', transcript: null };
   }
   const record = processing as Record<string, unknown>;
   const entry = Array.isArray(record.transcripts) ? record.transcripts[index] : undefined;
   if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const item = entry as Record<string, unknown>;
      const transcript = typeof item.transcript === 'string' ? item.transcript.trim() : '';
      return item.status === 'COMPLETED' && transcript
         ? { status: 'COMPLETED', transcript }
         : { status: 'UNAVAILABLE', transcript: null };
   }
   // Older messages stored one combined transcript. Only associate it with a single recording.
   const transcript = typeof record.transcript === 'string' ? record.transcript.trim() : '';
   if (index === 0 && ticketMediaReferences(metadata, 'audio').length === 1 && transcript) {
      return { status: 'COMPLETED', transcript };
   }
   return {
      status: record.transcription === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'NOT_REQUESTED',
      transcript: null,
   };
}

export function ticketMediaReferences(metadata: Record<string, unknown> | null | undefined, kind: 'audio' | 'images'): SupportTicketMedia[] {
   const entries = metadata?.[kind];
   if (!Array.isArray(entries)) return [];
   return entries.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const media: SupportTicketMedia = {};
      for (const key of ['documentId', 'object', 'url', 'name', 'mimeType'] as const) {
         if (typeof record[key] === 'string') media[key] = record[key];
      }
      if (typeof record.durationSeconds === 'number' && Number.isFinite(record.durationSeconds) && record.durationSeconds >= 0) {
         media.durationSeconds = record.durationSeconds;
      }
      return [media];
   });
}

export function ticketMediaUrl(media: SupportTicketMedia, apiBaseUrl?: string): string | null {
   for (const candidate of [media.url, media.object]) {
      if (typeof candidate !== 'string') continue;
      try {
         const url = new URL(candidate);
         if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
      } catch {
         // Storage keys are resolved by Taskara below.
      }
   }
   const key = media.object || media.documentId;
   return typeof key === 'string' && key.trim()
      ? `${(apiBaseUrl ?? taskaraApiBaseUrl()).replace(/\/$/u, '')}/public/support/media/${encodeURIComponent(key.trim())}`
      : null;
}

export function formatAudioTime(seconds: number): string {
   if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
   const whole = Math.floor(seconds);
   const minutes = Math.floor(whole / 60);
   const remainder = String(whole % 60).padStart(2, '0');
   return `${minutes}:${remainder}`;
}
