import { describe, expect, test } from 'bun:test';
import {
   workspacePathIsAvailable,
   workspaceRouteForPath,
   workspaceSidebarRoutes,
   type WorkspaceNavigationRuntime,
} from './workspace-navigation';
import { resolveWorkspaceCapabilities } from './workspace-mode';

describe('Support maturity navigation', () => {
   test('offers the unified maturity surface to Department managers and supervisors', () => {
      for (const permissions of [['support.department-inbox.read'], ['support.reports.read']]) {
         const current = runtime(permissions);
         expect(workspacePathIsAvailable('/help/support/maturity', 'help', current)).toBeTrue();
         expect(workspaceSidebarRoutes(current, 'primary').map((route) => route.id)).toContain('support-maturity');
      }
      expect(workspaceRouteForPath('/help/support/maturity', 'help')).toMatchObject({
         id: 'support-maturity', label: 'توانمندسازی و کیفیت',
      });
   });

   test('keeps manager-wide maturity data out of a Case-only member route set', () => {
      const member = runtime(['support.cases.mine.read', 'support.recovery.read']);
      expect(workspacePathIsAvailable('/help/support/maturity', 'help', member)).toBeFalse();
      expect(workspaceSidebarRoutes(member, 'primary').map((route) => route.id)).not.toContain('support-maturity');
   });
});

function runtime(permissions: string[]): WorkspaceNavigationRuntime {
   return {
      mode: 'SUPPORT', role: 'MEMBER', permissions: new Set(permissions),
      capabilities: resolveWorkspaceCapabilities('SUPPORT', undefined),
      support: { needsSetup: false },
   };
}
