import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportCaseTaskLinkListView, SupportHandoffPreview } from './support-case-handoff-card';
import type { SupportCaseTaskLinkProjection, SupportCaseWorkTarget } from '@/lib/support-handoff-types';

describe('Support Case handoff UI', () => {
   test('renders only the exact sanitized Case-side projection and a deletion tombstone', () => {
      const html = renderToStaticMarkup(<SupportCaseTaskLinkListView links={[link()]} />);
      expect(html).toContain('CORE-42');
      expect(html).toContain('عنوان پاک‌سازی‌شده');
      expect(html).toContain('کار تیمی حذف شده');
      expect(html).not.toContain('raw-task-uuid');
      expect(html).not.toContain('raw-team-workspace-uuid');
   });

   test('requires an explicit visibility and PII confirmation in preview', () => {
      const html = renderToStaticMarkup(
         <SupportHandoffPreview
            confirmed={false}
            mode="CREATE"
            target={target()}
            draft={{
               targetActionRef: 'hidden-target-id',
               relationType: 'FIX_WORK',
               handoffTitle: 'اصلاح ورود',
               handoffSummary: 'مسئله را بازتولید و رفع کنید.',
               taskActionRef: '',
               taskTitle: 'اصلاح ورود در وب',
               taskDescription: '',
               taskPriority: 'HIGH',
               parentTaskActionRef: '',
            }}
         />
      );
      expect(html).toContain('اطلاعات تماس');
      expect(html).toContain('داده حساس مشتری ندارد');
      expect(html).toContain('تیم محصول');
      expect(html).not.toContain('hidden-target-id');
   });
});

function link(): SupportCaseTaskLinkProjection {
   return {
      projectionVersion: 1,
      linkId: 'opaque-link-id',
      teamWorkspaceName: 'تیم محصول',
      taskKey: 'CORE-42',
      title: 'عنوان پاک‌سازی‌شده',
      status: 'TODO',
      lastSignalAt: '2026-08-23T12:00:00.000Z',
      tombstone: {
         taskDeletedAt: '2026-08-23T12:00:00.000Z',
         connectionRevokedAt: null,
         unlinkedAt: null,
      },
   };
}

function target(): SupportCaseWorkTarget {
   return {
      actionRef: 'hidden-target-id',
      teamWorkspaceName: 'تیم محصول',
      project: { name: 'هسته', keyPrefix: 'CORE', status: 'ACTIVE' },
      allowCreateTasks: true,
      allowLinkTasks: true,
   };
}
