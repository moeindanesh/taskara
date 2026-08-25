import { describe, expect, test } from 'bun:test';
import {
   supportHandoffIrreversibilityWarning,
   supportHandoffVisibilityWarning,
   supportTaskLinkState,
} from './support-handoff-presenters';
import type { SupportCaseTaskLinkProjection } from './support-handoff-types';

describe('Support handoff presenters', () => {
   test('gives irreversible data-sharing and PII warnings in Persian', () => {
      const warning = supportHandoffVisibilityWarning('تیم محصول', 'هسته');
      expect(warning).toContain('تیم محصول');
      expect(warning).toContain('اطلاعات تماس');
      expect(supportHandoffIrreversibilityWarning).toContain('پس نمی‌گیرد');
   });

   test('keeps revocation, deletion, and unlink tombstones distinct', () => {
      const link = linkProjection();
      expect(supportTaskLinkState(link)).toBe('ACTIVE');
      expect(supportTaskLinkState({ ...link, tombstone: { ...link.tombstone, connectionRevokedAt: link.lastSignalAt } })).toBe('CONNECTION_REVOKED');
      expect(supportTaskLinkState({ ...link, tombstone: { ...link.tombstone, taskDeletedAt: link.lastSignalAt } })).toBe('TASK_DELETED');
      expect(supportTaskLinkState({ ...link, tombstone: { ...link.tombstone, unlinkedAt: link.lastSignalAt } })).toBe('UNLINKED');
   });
});

function linkProjection(): SupportCaseTaskLinkProjection {
   return {
      projectionVersion: 1,
      linkId: 'link',
      teamWorkspaceName: 'تیم محصول',
      taskKey: 'CORE-1',
      title: 'اصلاح',
      status: 'TODO',
      lastSignalAt: '2026-08-23T12:00:00.000Z',
      tombstone: { taskDeletedAt: null, connectionRevokedAt: null, unlinkedAt: null },
   };
}
