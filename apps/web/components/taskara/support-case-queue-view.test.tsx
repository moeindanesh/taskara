import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportQueueEmptyState } from './support-case-queue-view';

describe('Support queue surface', () => {
   test('renders a Persian RTL empty state with responsive spacing', () => {
      const html = renderToStaticMarkup(<SupportQueueEmptyState queue="MY_CASES" />);
      expect(html).toContain('dir="rtl"');
      expect(html).toContain('پرونده‌ی بازی به شما سپرده نشده است');
      expect(html).toContain('sm:min-h-[360px]');
      expect(html).toContain('سایر اعضا');
   });
});
