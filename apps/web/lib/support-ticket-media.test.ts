import { describe, expect, test } from 'bun:test';
import { formatAudioTime, ticketMediaReferences, ticketMediaUrl, ticketVoiceTranscript } from './support-ticket-media';

describe('Support Ticket media references', () => {
   test('reads an uploaded voice message and uses its CDN URL', () => {
      const audio = ticketMediaReferences({
         audio: [{ name: 'voice.weba', object: 'support/voice.weba', url: 'https://cdn.example.test/v1/media/support/voice.weba', durationSeconds: 23 }],
      }, 'audio');

      expect(audio).toEqual([{
         name: 'voice.weba',
         object: 'support/voice.weba',
         url: 'https://cdn.example.test/v1/media/support/voice.weba',
         durationSeconds: 23,
      }]);
      expect(ticketMediaUrl(audio[0]!)).toBe('https://cdn.example.test/v1/media/support/voice.weba');
   });

   test('resolves object-only media through the public redirect route', () => {
      expect(ticketMediaUrl({ object: 'support/voice.weba' }, 'https://api.example.test/')).toBe(
         'https://api.example.test/public/support/media/support%2Fvoice.weba'
      );
      expect(ticketMediaUrl({ documentId: 'file-id' }, 'https://api.example.test')).toBe(
         'https://api.example.test/public/support/media/file-id'
      );
   });

   test('ignores malformed fields and formats playback time', () => {
      expect(ticketMediaReferences({ audio: [null, 'invalid', { name: { nested: true }, object: 'voice.weba' }] }, 'audio'))
         .toEqual([{ object: 'voice.weba' }]);
      expect(formatAudioTime(65.7)).toBe('1:05');
      expect(formatAudioTime(Number.POSITIVE_INFINITY)).toBe('0:00');
   });

   test('matches each transcript to its recording and supports older single-voice messages', () => {
      const metadata = {
         audio: [{ object: 'one.webm' }, { object: 'two.webm' }],
         processing: {
            transcripts: [
               { status: 'COMPLETED', transcript: 'پیام اول' },
               { status: 'COMPLETED', transcript: 'پیام دوم' },
            ],
         },
      };
      expect(ticketVoiceTranscript(metadata, 0).transcript).toBe('پیام اول');
      expect(ticketVoiceTranscript(metadata, 1).transcript).toBe('پیام دوم');
      expect(ticketVoiceTranscript({
         audio: [{ object: 'legacy.webm' }],
         processing: { transcription: 'COMPLETED', transcript: 'متن قبلی' },
      }, 0)).toEqual({ status: 'COMPLETED', transcript: 'متن قبلی' });
   });

   test('does not expose invalid output or associate a combined legacy transcript with the wrong voice', () => {
      expect(ticketVoiceTranscript({ processing: 'invalid' }, 0).status).toBe('NOT_REQUESTED');
      expect(ticketVoiceTranscript({
         processing: { transcripts: [{ status: 'COMPLETED', transcript: { malicious: true } }] },
      }, 0)).toEqual({ status: 'UNAVAILABLE', transcript: null });
      expect(ticketVoiceTranscript({
         audio: [{ object: 'one.webm' }, { object: 'two.webm' }],
         processing: { transcript: 'combined text' },
      }, 0).transcript).toBeNull();
   });
});
