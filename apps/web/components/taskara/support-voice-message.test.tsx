import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportVoiceMessage } from './support-voice-message';

describe('Support voice message transcript', () => {
   const media = { name: 'voice.webm', url: 'https://cdn.example.test/voice.webm' };

   test.each(['dark', 'light'] as const)('renders AI text under the custom voice player in %s mode', (tone) => {
      const html = renderToStaticMarkup(
         <SupportVoiceMessage media={media} tone={tone}
            transcription={{ status: 'COMPLETED', transcript: 'سفارش ثبت نمی‌شود.\nخطای پرداخت می‌بینم.' }} />
      );
      expect(html).toContain('aria-label="پخش پیام صوتی"');
      expect(html).toContain('متن پیام صوتی');
      expect(html).toContain('هوش مصنوعی');
      expect(html).toContain('سفارش ثبت نمی‌شود.');
      expect(html.indexOf('<audio')).toBeLessThan(html.indexOf('<section'));
      expect(html).not.toContain(' controls=');
   });

   test('shows a failure message without inventing a transcript', () => {
      const html = renderToStaticMarkup(
         <SupportVoiceMessage media={media} transcription={{ status: 'UNAVAILABLE', transcript: null }} />
      );
      expect(html).toContain('تبدیل این پیام صوتی به متن ناموفق بود.');
      expect(html).toContain('aria-label="پخش پیام صوتی"');
   });

   test('escapes model output rather than rendering it as HTML', () => {
      const html = renderToStaticMarkup(
         <SupportVoiceMessage media={media} transcription={{ status: 'COMPLETED', transcript: '<script>alert(1)</script>' }} />
      );
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
   });
});
