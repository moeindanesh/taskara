import { describe, expect, test } from 'bun:test';
import {
   normalizeCaseWorkTargets,
   normalizeConnectionList,
   normalizeHandoffOptions,
   normalizeTeamTaskSupportLinks,
   normalizeTaskLinkProjection,
   supportCaseHandoffOptionsPath,
   supportCaseTaskLinksPath,
   supportHandoffTaskSearchPath,
   teamTaskSupportLinksPath,
} from './support-handoff-client';

describe('Support handoff client', () => {
   test('encodes Case and Team Task keys for the published handoff endpoints', () => {
      expect(supportCaseTaskLinksPath('HELP/1')).toBe('/support/cases/HELP%2F1/task-links');
      expect(supportCaseHandoffOptionsPath('HELP/1')).toBe('/support/cases/HELP%2F1/handoff-options');
      expect(teamTaskSupportLinksPath('CORE/1')).toBe('/tasks/CORE%2F1/support-case-links');
      const search = new URL(supportHandoffTaskSearchPath('target/id', 'ورود مشتری'), 'https://taskara.test');
      expect(search.pathname).toBe('/support/department-work-targets/target%2Fid/tasks');
      expect(search.searchParams.get('q')).toBe('ورود مشتری');
   });

   test('keeps the exact Support projection and discards raw opposite aggregate ids', () => {
      const projection = normalizeTaskLinkProjection({
         linkId: 'opaque-link',
         version: 1,
         connectionId: 'raw-connection-id',
         workTargetId: 'raw-target-id',
         teamWorkspaceId: 'raw-team-workspace-id',
         caseId: 'raw-case-id',
         taskId: 'raw-task-id',
         teamWorkspaceName: 'تیم محصول',
         taskKey: 'CORE-42',
         title: 'اصلاح ورود',
         status: 'IN_PROGRESS',
         lastSignalAt: '2026-08-23T12:00:00.000Z',
         tombstone: { taskDeletedAt: null, connectionRevokedAt: null, unlinkedAt: null },
         projectionVersion: 1,
      });

      expect(projection).toEqual({
         projectionVersion: 1,
         linkId: 'opaque-link',
         teamWorkspaceName: 'تیم محصول',
         taskKey: 'CORE-42',
         title: 'اصلاح ورود',
         status: 'IN_PROGRESS',
         lastSignalAt: '2026-08-23T12:00:00.000Z',
         tombstone: { taskDeletedAt: null, connectionRevokedAt: null, unlinkedAt: null },
      });
      expect(JSON.stringify(projection)).not.toContain('raw-task-id');
      expect(JSON.stringify(projection)).not.toContain('secret-slug');
   });

   test('normalizes safe work-target and Team-side projections without raw workspace ids', () => {
      expect(normalizeCaseWorkTargets([{
         workTargetId: 'opaque-target', teamWorkspaceName: 'تیم تحویل',
         project: { name: 'هسته', keyPrefix: 'CORE', status: 'ACTIVE' },
         allowCreateTasks: true, allowLinkTasks: false,
         teamWorkspaceId: 'raw-team-id', projectId: 'raw-project-id',
      }])).toEqual([{
         actionRef: 'opaque-target', teamWorkspaceName: 'تیم تحویل',
         project: { name: 'هسته', keyPrefix: 'CORE', status: 'ACTIVE' },
         allowCreateTasks: true, allowLinkTasks: false,
      }]);

      const links = normalizeTeamTaskSupportLinks([{
         linkId: 'link', supportWorkspaceName: 'پشتیبانی', caseKey: 'SUP-1',
         title: 'خلاصه امن', status: 'OPEN', lastSignalAt: '2026-08-23T12:00:00.000Z',
         tombstone: { connectionRevokedAt: null, unlinkedAt: null },
         projectionVersion: 1, caseId: 'raw-case-id', supportWorkspaceId: 'raw-support-id',
      }]);
      expect(links[0]?.title).toBe('خلاصه امن');
      expect(JSON.stringify(links)).not.toContain('raw-case-id');
      expect(JSON.stringify(links)).not.toContain('raw-support-id');
   });

   test('normalizes the admin connection and per-Case action contracts separately', () => {
      const connections = normalizeConnectionList({ items: [{
         id: 'connection-action', status: 'PENDING', currentWorkspaceSide: 'SUPPORT',
         currentApproved: false, otherApproved: false, otherWorkspace: { name: 'تیم محصول', id: 'raw-team-id' },
         targets: [{
            id: 'target-action', department: { id: 'department-id', name: 'فنی', slug: 'technical' },
            project: { name: 'هسته', keyPrefix: 'CORE', status: 'ACTIVE' },
            allowCreateTasks: true, allowLinkTasks: true, active: true,
         }], revokedAt: null, createdAt: '2026-08-23T12:00:00.000Z', updatedAt: '2026-08-23T12:00:00.000Z',
      }] });
      expect(connections.items[0]?.otherWorkspace).toEqual({ name: 'تیم محصول' });
      expect(JSON.stringify(connections)).not.toContain('raw-team-id');

      const options = normalizeHandoffOptions({
         caseVersion: 7,
         accessEpoch: '3',
         items: [{
            workTargetId: 'opaque-target', teamWorkspaceName: 'تیم محصول',
            project: { name: 'هسته', keyPrefix: 'CORE', status: 'ACTIVE', id: 'raw-project-id' },
            allowCreateTasks: true, allowLinkTasks: false,
         }],
      });
      expect(options.caseVersion).toBe(7);
      expect(options.items[0]?.actionRef).toBe('opaque-target');
      expect(JSON.stringify(options)).not.toContain('raw-project-id');
   });
});
