import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportVoicePlayer } from './support-voice-player';

describe('Support voice player', () => {
   test('renders custom playback controls for an uploaded voice message', () => {
      const html = renderToStaticMarkup(
         <SupportVoicePlayer media={{
            name: 'voice.weba',
            url: 'https://cdn.example.test/v1/media/voice.weba',
            durationSeconds: 23,
         }} />
      );

      expect(html).toContain('aria-label="پخش پیام صوتی"');
      expect(html).toContain('aria-label="موقعیت پخش پیام صوتی"');
      expect(html).toContain('0:23');
      expect(html).toContain('voice.weba');
      expect(html).toContain('https://cdn.example.test/v1/media/voice.weba');
      expect(html).not.toContain(' controls=');
      expect(html).toContain('type="range"');
   });

   test('shows an explicit unavailable state when a voice reference has no location', () => {
      const html = renderToStaticMarkup(<SupportVoicePlayer media={{ name: 'voice.weba' }} />);
      expect(html).toContain('نشانی فایل صوتی در دسترس نیست.');
      expect(html).toContain('disabled=""');
   });
});
