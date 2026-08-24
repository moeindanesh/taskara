import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
   TeamTaskSupportLinkListView,
   teamTaskSupportLinksRefreshPolicy,
} from './team-task-support-links';
import type { TeamTaskSupportLinkProjection } from '@/lib/support-handoff-types';

describe('Team Task Support projection', () => {
   test('refreshes a mounted projection after Support-side lifecycle and link changes', () => {
      expect(teamTaskSupportLinksRefreshPolicy).toMatchObject({
         fireOnMount: false,
         intervalMs: 30_000,
         refreshOnFocus: true,
         refreshOnInterval: true,
         refreshOnOnline: true,
         refreshOnPageShow: true,
         refreshOnVisibility: true,
         refreshOnWorkspaceEvent: true,
      });
   });

   test('shows only the approved coarse Case reference and revocation tombstone', () => {
      const html = renderToStaticMarkup(<TeamTaskSupportLinkListView links={[projection()]} />);
      expect(html).toContain('HELP-14');
      expect(html).toContain('عنوان تحویل تأییدشده');
      expect(html).toContain('در آخرین وضعیت تأییدشده منجمد شده');
      expect(html).not.toContain('raw-case-uuid');
      expect(html).not.toContain('private@example.com');
   });
});

function projection(): TeamTaskSupportLinkProjection {
   return {
      projectionVersion: 1,
      linkId: 'opaque-link',
      supportWorkspaceName: 'پشتیبانی مشتریان',
      caseKey: 'HELP-14',
      title: 'عنوان تحویل تأییدشده',
      status: 'OPEN',
      lastSignalAt: '2026-08-23T12:00:00.000Z',
      tombstone: { connectionRevokedAt: '2026-08-23T13:00:00.000Z', unlinkedAt: null },
   };
}
