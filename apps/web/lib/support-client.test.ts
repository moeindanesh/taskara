import { describe, expect, test } from 'bun:test';
import { supportCaseListPath, supportSearchPath, supportSyncPullPath } from './support-client';

describe('Support API client', () => {
   test('serializes repeated list filters and Persian search safely', () => {
      const path = supportCaseListPath({
         queue: 'NEEDS_ATTENTION',
         status: ['OPEN', 'WAITING_ON_CUSTOMER'],
         priority: ['HIGH', 'URGENT'],
         q: 'قطع تماس مشتری',
         limit: 25,
      });
      const url = new URL(path, 'https://taskara.test');

      expect(url.pathname).toBe('/support/cases');
      expect(url.searchParams.get('queue')).toBe('NEEDS_ATTENTION');
      expect(url.searchParams.getAll('status')).toEqual(['OPEN', 'WAITING_ON_CUSTOMER']);
      expect(url.searchParams.getAll('priority')).toEqual(['HIGH', 'URGENT']);
      expect(url.searchParams.get('q')).toBe('قطع تماس مشتری');
      expect(url.searchParams.get('limit')).toBe('25');
   });

   test('does not serialize absent filters', () => {
      expect(supportCaseListPath({ q: '', cursor: undefined })).toBe('/support/cases');
   });

   test('serializes the privacy-scoped global search query', () => {
      const url = new URL(supportSearchPath('قطع تماس', 12), 'https://taskara.test');
      expect(url.pathname).toBe('/support/search');
      expect(url.searchParams.get('q')).toBe('قطع تماس');
      expect(url.searchParams.get('limit')).toBe('12');
   });

   test('binds a Support pull to the current access epoch and opaque cursor', () => {
      const url = new URL(supportSyncPullPath('epoch/7', 'ssc1.private/cursor', 75), 'https://taskara.test');
      expect(url.pathname).toBe('/support/sync/pull');
      expect(url.searchParams.get('accessEpoch')).toBe('epoch/7');
      expect(url.searchParams.get('cursor')).toBe('ssc1.private/cursor');
      expect(url.searchParams.get('limit')).toBe('75');
   });
});
