import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceConnectionList } from './support-workspace-connections-settings';
import type { SupportWorkspaceConnection } from '@/lib/support-handoff-types';

describe('workspace connection settings', () => {
   test('renders Team approval without leaking action identifiers', () => {
      const html = renderToStaticMarkup(
         <div dir="rtl">
            <WorkspaceConnectionList connections={[connection()]} side="TEAM" />
         </div>
      );
      expect(html).toContain('تأیید این فضا');
      expect(html).toContain('مرکز پشتیبانی');
      expect(html).toContain('در انتظار تأیید دوطرفه');
      expect(html).not.toContain('connection-action-id');
      expect(html).not.toContain('hidden-target-action-id');
      expect(html).not.toContain('raw-team-workspace-id');
   });
});

function connection(): SupportWorkspaceConnection {
   return {
      id: 'connection-action-id',
      status: 'PENDING',
      currentWorkspaceSide: 'TEAM',
      currentApproved: false,
      otherApproved: true,
      otherWorkspace: { name: 'مرکز پشتیبانی' },
      revokedAt: null,
      targets: [{
         id: 'hidden-target-action-id',
         department: { name: 'پشتیبانی محصول' },
         project: { name: 'هسته', keyPrefix: 'CORE', status: 'ACTIVE' },
         allowCreateTasks: true,
         allowLinkTasks: true,
         active: true,
      }],
      createdAt: '2026-08-23T12:00:00.000Z',
      updatedAt: '2026-08-23T12:00:00.000Z',
   };
}
