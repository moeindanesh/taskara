import { describe, expect, test } from 'bun:test';
import {
   workspacePathIsAvailable,
   workspaceSidebarRoutes,
   type WorkspaceNavigationRuntime,
} from './workspace-navigation';
import { resolveWorkspaceCapabilities } from './workspace-mode';

describe('Support Phase 7 navigation', () => {
   test('shows saved queues to scoped Case readers without exposing routing administration', () => {
      const member = runtime(['support.cases.mine.read', 'support.recovery.read']);
      expect(workspacePathIsAvailable('/help/support/saved-queues', 'help', member)).toBeTrue();
      expect(workspacePathIsAvailable('/help/support/routing', 'help', member)).toBeFalse();
      expect(workspaceSidebarRoutes(member, 'primary').map((route) => route.id)).toContain('support-saved-queues');
   });

   test('shows Department routing capacity to managers and policy routing to admins', () => {
      const manager = runtime(['support.department-inbox.read']);
      expect(workspacePathIsAvailable('/help/support/routing', 'help', manager)).toBeTrue();

      const admin = runtime(['support.setup', 'support.department-inbox.read'], 'ADMIN');
      expect(workspaceSidebarRoutes(admin, 'primary').map((route) => route.id)).toEqual(
         expect.arrayContaining(['support-routing', 'support-saved-queues'])
      );
   });
});

function runtime(permissions: string[], role = 'MEMBER'): WorkspaceNavigationRuntime {
   return {
      mode: 'SUPPORT', role, permissions: new Set(permissions),
      capabilities: resolveWorkspaceCapabilities('SUPPORT', undefined),
      support: { needsSetup: false },
   };
}
