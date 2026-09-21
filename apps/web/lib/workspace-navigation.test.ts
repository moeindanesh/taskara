import { describe, expect, test } from 'bun:test';
import {
   defaultWorkspacePath,
   workspaceCommandRoutes,
   workspaceCommandEntries,
   workspaceCreateAction,
   workspaceHomeForMembership,
   workspacePathIsAvailable,
   workspaceRouteForPath,
   workspaceSidebarRoutes,
   workspaceSupportSidebarGroups,
   type WorkspaceNavigationRuntime,
} from './workspace-navigation';
import { resolveWorkspaceCapabilities, type WorkspaceMode } from './workspace-mode';

describe('workspace navigation registry', () => {
   test('preserves the Team landing and current member sidebar while excluding Support', () => {
      const runtime = navRuntime('TEAM', 'MEMBER');

      expect(defaultWorkspacePath('acme', runtime)).toBe('/acme/overview');
      expect(workspaceSidebarRoutes(runtime, 'primary').map((route) => route.id)).toEqual([
         'team-overview',
         'my-tasks',
         'all-tasks',
         'milestones',
      ]);
      expect(workspaceCommandRoutes(runtime).some((route) => route.id.startsWith('support-'))).toBeFalse();
      expect(workspaceCreateAction(runtime)?.eventName).toBe('taskara:create-issue');
   });

   test('removes daily reports from manager navigation and direct routes', () => {
      const routes = workspaceSidebarRoutes(navRuntime('TEAM', 'ADMIN'), 'primary');
      expect(routes.filter((route) => route.id.startsWith('daily-')).map((route) => route.id)).toEqual([]);
      expect(workspacePathIsAvailable('/acme/today', 'acme', navRuntime('TEAM', 'ADMIN'))).toBeFalse();
      expect(workspacePathIsAvailable('/acme/daily-reports', 'acme', navRuntime('TEAM', 'MEMBER'))).toBeFalse();
   });

   test('keeps the established Team command ordering and labels', () => {
      const entries = workspaceCommandEntries(navRuntime('TEAM', 'MEMBER'));
      expect(entries.slice(0, 3).map((entry) => entry.id)).toEqual([
         'go-manager-cockpit',
         'go-decision-queues',
         'go-people-workload',
      ]);
      expect(entries.find((entry) => entry.id === 'go-heartbeat')?.label).toBe('رفتن به نبض تیم‌ها');
      expect(entries.find((entry) => entry.id === 'go-today-plan')?.route.id).toBe('heartbeat');
   });

   test('keeps Team routes out of Support and sends an unprovisioned admin to setup', () => {
      const runtime = navRuntime('SUPPORT', 'OWNER');
      const routeIds = workspaceSidebarRoutes(runtime).map((route) => route.id);

      expect(defaultWorkspacePath('help', runtime)).toBe('/help/support/setup');
      expect(routeIds).toContain('support-setup');
      expect(routeIds.some((id) => id.startsWith('team-') || id === 'all-tasks')).toBeFalse();
      expect(workspacePathIsAvailable('/help/tasks', 'help', runtime)).toBeFalse();
      expect(workspacePathIsAvailable('/help/support/setup', 'help', runtime)).toBeTrue();
      expect(workspaceCreateAction(runtime)).toBeNull();
   });

   test('chooses Support landing by permission priority and switches create semantics', () => {
      const runtime = navRuntime('SUPPORT', 'MEMBER', [
         'support.cases.create',
         'support.cases.mine.read',
         'support.department-inbox.read',
         'support.triage.read',
      ]);
      runtime.support = { needsSetup: false };

      expect(defaultWorkspacePath('help', runtime)).toBe('/help/support/triage');
      expect(workspaceCreateAction(runtime)?.eventName).toBe('taskara:create-support-case');
   });

   test('falls back to no-access for a Support member without grants', () => {
      const runtime = navRuntime('SUPPORT', 'MEMBER');
      expect(defaultWorkspacePath('help', runtime)).toBe('/help/support/no-access');
      expect(workspaceHomeForMembership({ slug: 'help', mode: 'SUPPORT' }, 'MEMBER')).toBe(
         '/help/support/no-access'
      );
   });

   test('classifies nested Team project URLs through the same metadata registry', () => {
      expect(workspaceRouteForPath('/acme/team/core/projects', 'acme')?.id).toBe('team-projects');
      expect(workspaceRouteForPath('/acme/team/core/all', 'acme')?.id).toBe('my-tasks');
      expect(workspaceRouteForPath('/acme/support/my-cases', 'acme')?.id).toBe('support-my-cases');
   });

   test('allows common routes in either mode only when their capability is present', () => {
      const support = navRuntime('SUPPORT', 'MEMBER');
      expect(workspacePathIsAvailable('/help/wiki', 'help', support)).toBeTrue();

      const withoutKnowledge = { ...support, capabilities: resolveWorkspaceCapabilities('SUPPORT', []) };
      expect(workspacePathIsAvailable('/help/wiki', 'help', withoutKnowledge)).toBeFalse();
   });

   test('gates operational admin surfaces and scoped reports independently', () => {
      const member = navRuntime('SUPPORT', 'MEMBER', ['support.cases.mine.read']);
      member.support = { needsSetup: false };
      expect(workspacePathIsAvailable('/help/support/operations', 'help', member)).toBeFalse();
      expect(workspacePathIsAvailable('/help/support/intake-admin', 'help', member)).toBeFalse();
      expect(workspacePathIsAvailable('/help/support/reports', 'help', member)).toBeFalse();
      expect(workspacePathIsAvailable('/help/support/maturity', 'help', member)).toBeFalse();

      const supervisor = navRuntime('SUPPORT', 'MEMBER', ['support.reports.read']);
      supervisor.support = { needsSetup: false };
      expect(workspacePathIsAvailable('/help/support/reports', 'help', supervisor)).toBeTrue();
      expect(workspacePathIsAvailable('/help/support/operations', 'help', supervisor)).toBeFalse();

      const admin = navRuntime('SUPPORT', 'ADMIN', ['support.setup', 'support.reports.read']);
      admin.support = { needsSetup: false };
      expect(workspacePathIsAvailable('/help/support/operations', 'help', admin)).toBeTrue();
      expect(workspacePathIsAvailable('/help/support/intake-admin', 'help', admin)).toBeTrue();
      expect(workspaceSidebarRoutes(admin, 'primary').map((route) => route.id)).toContain('support-reports');
      expect(workspaceSidebarRoutes(admin, 'primary').map((route) => route.id)).toContain('support-maturity');
   });

   test('groups Support navigation by workflow and keeps management separate from daily work', () => {
      const admin = navRuntime('SUPPORT', 'ADMIN', [
         'support.triage.read',
         'support.department-inbox.read',
         'support.cases.mine.read',
         'support.recovery.read',
         'support.setup',
         'support.reports.read',
      ]);
      admin.support = { needsSetup: false };

      expect(
         workspaceSupportSidebarGroups(admin).map((group) => ({
            id: group.id,
            routes: group.routes.map((route) => route.id),
         }))
      ).toEqual([
         {
            id: 'work',
            routes: [
               'support-triage',
               'support-my-cases',
               'support-department-inbox',
               'support-attention',
               'support-saved-queues',
            ],
         },
         { id: 'insights', routes: ['support-reports'] },
         {
            id: 'manage',
            routes: [
               'support-departments',
               'support-routing',
               'support-maturity',
               'support-operations',
               'support-intake-admin',
               'support-setup',
            ],
         },
         { id: 'workspace', routes: ['inbox', 'knowledge', 'members', 'settings'] },
      ]);
   });

   test('ordinary Support members see only scoped work and common workspace groups', () => {
      const member = navRuntime('SUPPORT', 'MEMBER', [
         'support.cases.mine.read',
         'support.recovery.read',
      ]);
      member.support = { needsSetup: false };

      const groups = workspaceSupportSidebarGroups(member);
      expect(groups.map((group) => group.id)).toEqual(['work', 'workspace']);
      expect(groups[0]?.routes.map((route) => route.id)).toEqual([
         'support-my-cases',
         'support-attention',
         'support-saved-queues',
      ]);
      expect(groups.flatMap((group) => group.routes).some((route) => route.id === 'support-reports')).toBeFalse();
   });
});

function navRuntime(
   mode: WorkspaceMode,
   role: string,
   permissions: string[] = []
): WorkspaceNavigationRuntime {
   return {
      mode,
      role,
      capabilities: resolveWorkspaceCapabilities(mode, undefined),
      permissions: new Set(permissions),
   };
}
