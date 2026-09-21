import { fa } from '@/lib/fa-copy';
import {
   isWorkspaceAdminRole,
   normalizeWorkspaceMode,
   resolveWorkspaceCapabilities,
   workspaceHasCapability,
   type SupportPermission,
   type WorkspaceCapability,
   type WorkspaceMode,
} from '@/lib/workspace-mode';

export type WorkspaceNavigationIcon =
   | 'attention'
   | 'cases'
   | 'communications'
   | 'daily-report'
   | 'departments'
   | 'inbox'
   | 'knowledge'
   | 'manager'
   | 'members'
   | 'milestones'
   | 'overview'
   | 'projects'
   | 'reports'
   | 'settings'
   | 'tasks'
   | 'teams'
   | 'triage';

export type WorkspaceNavigationRuntime = {
   mode: WorkspaceMode;
   role?: string | null;
   capabilities: ReadonlySet<WorkspaceCapability>;
   permissions: ReadonlySet<string>;
   support?: {
      needsSetup?: boolean;
   };
};

export const workspaceSidebarGroupIds = ['work', 'insights', 'manage', 'workspace'] as const;
export type WorkspaceSidebarGroupId = (typeof workspaceSidebarGroupIds)[number];

type RuntimeAudience = {
   permission?: SupportPermission;
   permissions?: readonly SupportPermission[];
   roles?: readonly string[];
};

export type WorkspaceRouteDefinition = {
   id: string;
   mode: WorkspaceMode | 'COMMON';
   capability?: WorkspaceCapability;
   audience?: RuntimeAudience;
   path: (workspaceSlug: string, runtime: WorkspaceNavigationRuntime) => string;
   matches: (relativeParts: readonly string[]) => boolean;
   label: string;
   description: string;
   icon: WorkspaceNavigationIcon;
   sidebar?: 'primary' | 'common';
   sidebarGroup?: WorkspaceSidebarGroupId;
   sidebarRoles?: readonly string[];
   sidebarOrder?: number;
   command?: boolean;
   commandDefault?: boolean | 'manager' | 'member';
   defaultPriority?: number;
};

const teamRoute = (
   definition: Omit<WorkspaceRouteDefinition, 'mode'>
): WorkspaceRouteDefinition => ({ ...definition, mode: 'TEAM' });

const supportRoute = (
   definition: Omit<WorkspaceRouteDefinition, 'mode'>
): WorkspaceRouteDefinition => ({ ...definition, mode: 'SUPPORT' });

const commonRoute = (
   definition: Omit<WorkspaceRouteDefinition, 'mode'>
): WorkspaceRouteDefinition => ({ ...definition, mode: 'COMMON' });

const firstPart = (name: string) => (parts: readonly string[]) => parts[0] === name;
const oneOfFirstParts = (...names: string[]) => (parts: readonly string[]) => names.includes(parts[0] || '');

export const workspaceRouteRegistry: readonly WorkspaceRouteDefinition[] = [
   teamRoute({
      id: 'team-overview',
      capability: 'team.tasks',
      path: (slug) => `/${slug}/overview`,
      matches: firstPart('overview'),
      label: fa.nav.teamOverview,
      description: fa.pages.teamOverviewDescription,
      icon: 'overview',
      sidebar: 'primary',
      sidebarOrder: 10,
      defaultPriority: 100,
   }),
   teamRoute({
      id: 'manager-cockpit',
      capability: 'team.manager-os',
      path: (slug) => `/${slug}/cockpit`,
      matches: firstPart('cockpit'),
      label: fa.nav.cockpit,
      description: fa.pages.cockpitDescription,
      icon: 'manager',
      command: true,
      commandDefault: 'manager',
   }),
   teamRoute({
      id: 'decision-queues',
      capability: 'team.manager-os',
      path: (slug) => `/${slug}/queues`,
      matches: firstPart('queues'),
      label: fa.nav.decisionQueues,
      description: fa.pages.decisionQueuesDescription,
      icon: 'triage',
      command: true,
   }),
   teamRoute({
      id: 'reviews',
      capability: 'team.tasks',
      path: (slug) => `/${slug}/reviews`,
      matches: firstPart('reviews'),
      label: fa.nav.reviews,
      description: fa.pages.reviewsDescription,
      icon: 'attention',
      command: true,
   }),
   teamRoute({
      id: 'people-workload',
      capability: 'team.manager-os',
      path: (slug) => `/${slug}/people`,
      matches: firstPart('people'),
      label: fa.nav.peopleWorkload,
      description: fa.pages.peopleWorkloadDescription,
      icon: 'members',
      command: true,
   }),
   teamRoute({
      id: 'daily-report',
      capability: 'team.daily-reports',
      sidebarRoles: ['MEMBER', 'GUEST'],
      path: (slug) => `/${slug}/today`,
      matches: firstPart('today'),
      label: fa.nav.dailyReports,
      description: fa.pages.dailyReportDescription,
      icon: 'daily-report',
      sidebar: 'primary',
      sidebarOrder: 20,
      command: true,
   }),
   teamRoute({
      id: 'daily-reports-digest',
      capability: 'team.daily-reports',
      sidebarRoles: ['OWNER', 'ADMIN'],
      path: (slug) => `/${slug}/daily-reports`,
      matches: firstPart('daily-reports'),
      label: fa.nav.dailyReports,
      description: fa.pages.dailyReportsDigestDescription,
      icon: 'daily-report',
      sidebar: 'primary',
      sidebarOrder: 20,
      command: true,
   }),
   teamRoute({
      id: 'capacity',
      capability: 'team.manager-os',
      path: (slug) => `/${slug}/capacity`,
      matches: firstPart('capacity'),
      label: fa.nav.capacitySettings,
      description: fa.pages.capacitySettingsDescription,
      icon: 'settings',
      command: true,
   }),
   commonRoute({
      id: 'inbox',
      capability: 'common.inbox',
      path: (slug) => `/${slug}/inbox`,
      matches: firstPart('inbox'),
      label: fa.nav.inbox,
      description: fa.pages.inboxDescription,
      icon: 'inbox',
      sidebar: 'common',
      sidebarGroup: 'workspace',
      sidebarOrder: 10,
      command: true,
   }),
   teamRoute({
      id: 'communications',
      capability: 'team.communications',
      path: (slug) => `/${slug}/communications`,
      matches: oneOfFirstParts('communications', 'announcements', 'meetings'),
      label: fa.nav.communications,
      description: fa.pages.communicationsDescription,
      icon: 'communications',
      command: true,
   }),
   commonRoute({
      id: 'knowledge',
      capability: 'common.knowledge',
      path: (slug) => `/${slug}/wiki`,
      matches: firstPart('wiki'),
      label: fa.nav.wiki,
      description: fa.pages.wikiDescription,
      icon: 'knowledge',
      sidebar: 'common',
      sidebarGroup: 'workspace',
      sidebarOrder: 20,
      command: true,
   }),
   teamRoute({
      id: 'team-health',
      capability: 'team.manager-os',
      path: (slug) => `/${slug}/team-health`,
      matches: oneOfFirstParts('team-health', 'leaderboard'),
      label: fa.nav.teamHealth,
      description: fa.pages.teamHealthDescription,
      icon: 'attention',
      command: true,
   }),
   teamRoute({
      id: 'heartbeat',
      capability: 'team.manager-os',
      path: (slug) => `/${slug}/heartbeat`,
      matches: firstPart('heartbeat'),
      label: fa.nav.heartbeat,
      description: fa.pages.heartbeatDescription,
      icon: 'attention',
      command: true,
   }),
   commonRoute({
      id: 'members',
      capability: 'common.members',
      path: (slug) => `/${slug}/members`,
      matches: firstPart('members'),
      label: fa.nav.members,
      description: fa.pages.membersDescription,
      icon: 'members',
      sidebar: 'common',
      sidebarGroup: 'workspace',
      sidebarOrder: 30,
      command: true,
   }),
   teamRoute({
      id: 'team-projects',
      capability: 'team.projects',
      path: (slug) => `/${slug}/projects`,
      matches: (parts) => parts[0] === 'projects' || (parts[0] === 'team' && parts[2] === 'projects'),
      label: fa.nav.projects,
      description: fa.pages.projectsDescription,
      icon: 'projects',
      command: true,
   }),
   teamRoute({
      id: 'milestones',
      capability: 'team.milestones',
      path: (slug) => `/${slug}/milestones`,
      matches: firstPart('milestones'),
      label: fa.nav.milestones,
      description: fa.pages.milestonesDescription,
      icon: 'milestones',
      sidebar: 'primary',
      sidebarOrder: 50,
      command: true,
      commandDefault: true,
   }),
   commonRoute({
      id: 'settings',
      capability: 'common.settings',
      path: (slug) => `/${slug}/settings/profile`,
      matches: firstPart('settings'),
      label: fa.nav.settings,
      description: fa.pages.settingsDescription,
      icon: 'settings',
      sidebar: 'common',
      sidebarGroup: 'workspace',
      sidebarOrder: 40,
      command: true,
   }),
   teamRoute({
      id: 'task-reports',
      capability: 'team.manager-os',
      path: (slug) => `/${slug}/reports`,
      matches: firstPart('reports'),
      label: fa.nav.reports,
      description: fa.pages.reportsDescription,
      icon: 'reports',
   }),
   teamRoute({
      id: 'all-tasks',
      capability: 'team.tasks',
      path: (slug) => `/${slug}/tasks`,
      matches: firstPart('tasks'),
      label: fa.nav.allTasks,
      description: fa.pages.allTasksDescription,
      icon: 'tasks',
      sidebar: 'primary',
      sidebarOrder: 40,
      command: true,
   }),
   teamRoute({
      id: 'my-tasks',
      capability: 'team.tasks',
      path: (slug) => `/${slug}/team/all/all`,
      matches: (parts) => parts[0] === 'team' && parts[2] !== 'projects',
      label: fa.nav.myIssues,
      description: fa.pages.issuesDescription,
      icon: 'cases',
      sidebar: 'primary',
      sidebarOrder: 30,
      command: true,
      commandDefault: 'member',
   }),
   teamRoute({
      id: 'task-detail',
      capability: 'team.tasks',
      path: (slug) => `/${slug}/team/all/all`,
      matches: firstPart('issue'),
      label: fa.nav.issues,
      description: fa.pages.issuesDescription,
      icon: 'tasks',
   }),
   teamRoute({
      id: 'teams',
      capability: 'team.teams',
      path: (slug) => `/${slug}/teams`,
      matches: firstPart('teams'),
      label: fa.nav.teams,
      description: fa.pages.teamsDescription,
      icon: 'teams',
      command: true,
   }),
   supportRoute({
      id: 'support-case-detail',
      capability: 'support.cases',
      audience: {
         permissions: [
            'support.triage.read',
            'support.department-inbox.read',
            'support.cases.mine.read',
            'support.recovery.read',
         ],
      },
      path: (slug) => `/${slug}/support/my-cases`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'cases' && Boolean(parts[2]),
      label: 'پرونده پشتیبانی',
      description: 'جزئیات، ارتباطات، واگذاری و چرخه عمر پرونده.',
      icon: 'cases',
   }),
   supportRoute({
      id: 'support-triage',
      capability: 'support.triage',
      audience: { permission: 'support.triage.read' },
      path: (slug) => `/${slug}/support/triage`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'triage',
      label: fa.support.nav.triage,
      description: fa.support.pages.triage,
      icon: 'triage',
      sidebar: 'primary',
      sidebarGroup: 'work',
      sidebarOrder: 10,
      command: true,
      commandDefault: true,
      defaultPriority: 100,
   }),
   supportRoute({
      id: 'support-department-inbox',
      capability: 'support.cases',
      audience: { permission: 'support.department-inbox.read' },
      path: (slug) => `/${slug}/support/department-inbox`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'department-inbox',
      label: fa.support.nav.departmentInbox,
      description: fa.support.pages.departmentInbox,
      icon: 'inbox',
      sidebar: 'primary',
      sidebarGroup: 'work',
      sidebarOrder: 30,
      command: true,
      defaultPriority: 90,
   }),
   supportRoute({
      id: 'support-my-cases',
      capability: 'support.cases',
      audience: { permission: 'support.cases.mine.read' },
      path: (slug) => `/${slug}/support/my-cases`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'my-cases',
      label: fa.support.nav.myCases,
      description: fa.support.pages.myCases,
      icon: 'cases',
      sidebar: 'primary',
      sidebarGroup: 'work',
      sidebarOrder: 20,
      command: true,
      commandDefault: true,
      defaultPriority: 80,
   }),
   supportRoute({
      id: 'support-attention',
      capability: 'support.recovery',
      audience: { permission: 'support.recovery.read' },
      path: (slug) => `/${slug}/support/attention`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'attention',
      label: fa.support.nav.needsAttention,
      description: fa.support.pages.needsAttention,
      icon: 'attention',
      sidebar: 'primary',
      sidebarGroup: 'work',
      sidebarOrder: 40,
      command: true,
   }),
   supportRoute({
      id: 'support-departments',
      capability: 'support.departments',
      audience: {
         permissions: ['support.departments.manage', 'support.department-inbox.read'],
         roles: ['OWNER', 'ADMIN'],
      },
      path: (slug) => `/${slug}/support/departments`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'departments',
      label: fa.support.nav.departments,
      description: fa.support.pages.departments,
      icon: 'departments',
      sidebar: 'primary',
      sidebarGroup: 'manage',
      sidebarOrder: 50,
      command: true,
   }),
   supportRoute({
      id: 'support-saved-queues',
      capability: 'support.cases',
      audience: {
         permissions: [
            'support.triage.read',
            'support.department-inbox.read',
            'support.cases.mine.read',
            'support.recovery.read',
         ],
         roles: ['OWNER', 'ADMIN'],
      },
      path: (slug) => `/${slug}/support/saved-queues`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'saved-queues',
      label: 'صف‌های ذخیره‌شده',
      description: 'فیلترهای شخصی و مشترک پشتیبانی با ارزیابی دوباره دسترسی در هر اجرا.',
      icon: 'cases',
      sidebar: 'primary',
      sidebarGroup: 'work',
      sidebarOrder: 45,
      command: true,
   }),
   supportRoute({
      id: 'support-routing',
      capability: 'support.departments',
      audience: {
         permissions: ['support.setup', 'support.department-inbox.read'],
         roles: ['OWNER', 'ADMIN'],
      },
      path: (slug) => `/${slug}/support/routing`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'routing',
      label: 'مسیریابی و ظرفیت',
      description: 'نسخه‌های سیاست مسیریابی، ظرفیت، آمادگی و مهارت اعضای دپارتمان.',
      icon: 'departments',
      sidebar: 'primary',
      sidebarGroup: 'manage',
      sidebarOrder: 55,
      command: true,
   }),
   supportRoute({
      id: 'support-maturity',
      capability: 'support.departments',
      audience: {
         permissions: ['support.setup', 'support.department-inbox.read', 'support.reports.read'],
         roles: ['OWNER', 'ADMIN'],
      },
      path: (slug) => `/${slug}/support/maturity`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'maturity',
      label: 'توانمندسازی و کیفیت',
      description: 'نسخه‌های ماکرو و خودکارسازی، مسئله‌های پرتکرار، شکاف دانش و بازبینی کیفیت.',
      icon: 'manager',
      sidebar: 'primary',
      sidebarGroup: 'manage',
      sidebarOrder: 58,
      command: true,
   }),
   supportRoute({
      id: 'support-reports',
      capability: 'support.reports',
      audience: { permission: 'support.reports.read' },
      path: (slug) => `/${slug}/support/reports`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'reports',
      label: fa.support.nav.reports,
      description: fa.support.pages.reports,
      icon: 'reports',
      sidebar: 'primary',
      sidebarGroup: 'insights',
      sidebarOrder: 60,
      command: true,
   }),
   supportRoute({
      id: 'support-operations',
      capability: 'support.departments',
      audience: { permission: 'support.setup', roles: ['OWNER', 'ADMIN'] },
      path: (slug) => `/${slug}/support/operations`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'operations',
      label: 'عملیات و SLA',
      description: 'تقویم‌های کاری و نسخه‌های تغییرناپذیر سیاست‌های SLA.',
      icon: 'settings',
      sidebar: 'primary',
      sidebarGroup: 'manage',
      sidebarOrder: 70,
      command: true,
   }),
   supportRoute({
      id: 'support-intake-admin',
      capability: 'support.triage',
      audience: { permission: 'support.setup', roles: ['OWNER', 'ADMIN'] },
      path: (slug) => `/${slug}/support/intake-admin`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'intake-admin',
      label: 'سلامت ورودی‌ها',
      description: 'سلامت اتصال‌ها، ورودی‌های ناموفق نهایی و تلاش مجدد ایمن.',
      icon: 'attention',
      sidebar: 'primary',
      sidebarGroup: 'manage',
      sidebarOrder: 80,
      command: true,
   }),
   supportRoute({
      id: 'support-setup',
      capability: 'support.departments',
      audience: { permission: 'support.setup', roles: ['OWNER', 'ADMIN'] },
      path: (slug) => `/${slug}/support/setup`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'setup',
      label: fa.support.nav.setup,
      description: fa.support.pages.setup,
      icon: 'settings',
      sidebar: 'primary',
      sidebarGroup: 'manage',
      sidebarOrder: 90,
      command: true,
      defaultPriority: 20,
   }),
   supportRoute({
      id: 'support-no-access',
      path: (slug) => `/${slug}/support/no-access`,
      matches: (parts) => parts[0] === 'support' && parts[1] === 'no-access',
      label: fa.support.nav.noAccess,
      description: fa.support.pages.noAccess,
      icon: 'cases',
      defaultPriority: 0,
   }),
] as const;

export function workspaceRouteIsAvailable(
   route: WorkspaceRouteDefinition,
   runtime: WorkspaceNavigationRuntime
): boolean {
   if (route.id === 'daily-report' || route.id === 'daily-reports-digest') return false;
   if (route.mode !== 'COMMON' && route.mode !== runtime.mode) return false;
   if (!workspaceHasCapability(runtime.capabilities, route.capability)) return false;
   if (!route.audience) return true;

   const hasPermission = route.audience.permission
      ? runtime.permissions.has(route.audience.permission)
      : false;
   const hasAnyPermission = route.audience.permissions?.some((permission) =>
      runtime.permissions.has(permission)
   ) || false;
   const hasRole = route.audience.roles?.includes(runtime.role || '') || false;
   return hasPermission || hasAnyPermission || hasRole;
}

export function workspaceRouteForPath(
   pathname: string,
   workspaceSlug: string
): WorkspaceRouteDefinition | undefined {
   const parts = pathname.split('/').filter(Boolean);
   if (parts[0] !== workspaceSlug) return undefined;
   const relativeParts = parts.slice(1);
   return workspaceRouteRegistry.find((route) => route.matches(relativeParts));
}

export function workspaceRouteById(id: string): WorkspaceRouteDefinition | undefined {
   return workspaceRouteRegistry.find((route) => route.id === id);
}

export function workspacePathIsAvailable(
   pathname: string,
   workspaceSlug: string,
   runtime: WorkspaceNavigationRuntime
): boolean {
   const route = workspaceRouteForPath(pathname, workspaceSlug);
   return Boolean(route && workspaceRouteIsAvailable(route, runtime));
}

export function workspaceSidebarRoutes(
   runtime: WorkspaceNavigationRuntime,
   group?: WorkspaceRouteDefinition['sidebar']
): WorkspaceRouteDefinition[] {
   return workspaceRouteRegistry
      .filter((route) => route.sidebar && (!group || route.sidebar === group))
      .filter((route) => workspaceRouteIsAvailable(route, runtime))
      .filter((route) => !route.sidebarRoles || route.sidebarRoles.includes(runtime.role || ''))
      .sort((left, right) => (left.sidebarOrder || 0) - (right.sidebarOrder || 0));
}

export type WorkspaceSidebarGroup = {
   id: WorkspaceSidebarGroupId;
   routes: WorkspaceRouteDefinition[];
};

export function workspaceSupportSidebarGroups(
   runtime: WorkspaceNavigationRuntime
): WorkspaceSidebarGroup[] {
   if (runtime.mode !== 'SUPPORT') return [];
   const routes = workspaceSidebarRoutes(runtime);
   return workspaceSidebarGroupIds
      .map((id) => ({ id, routes: routes.filter((route) => route.sidebarGroup === id) }))
      .filter((group) => group.routes.length > 0);
}

export function workspaceCommandRoutes(runtime: WorkspaceNavigationRuntime): WorkspaceRouteDefinition[] {
   return workspaceRouteRegistry.filter(
      (route) => route.command && workspaceRouteIsAvailable(route, runtime)
   );
}

type WorkspaceCommandPresentation = {
   label?: string;
   order: number;
   aliases?: Array<{ id: string; label: string; description: string; order: number }>;
};

const workspaceCommandPresentation: Record<string, WorkspaceCommandPresentation> = {
   'manager-cockpit': { label: fa.command.goCockpit, order: 10 },
   'decision-queues': { label: fa.command.goDecisionQueues, order: 30 },
   'people-workload': { label: fa.command.goPeopleWorkload, order: 40 },
   'daily-report': { label: fa.command.goDailyReport, order: 50 },
   'daily-reports-digest': { label: fa.command.goDailyReportsDigest, order: 60 },
   'team-projects': { label: fa.command.goProjects, order: 70 },
   milestones: { label: fa.command.goMilestones, order: 80 },
   'my-tasks': { label: fa.command.goIssues, order: 110 },
   'all-tasks': { label: fa.command.goAllTasks, order: 120 },
   inbox: { label: fa.command.goInbox, order: 130 },
   communications: { order: 140 },
   knowledge: { label: fa.command.goWiki, order: 150 },
   reviews: { label: fa.command.goReviews, order: 160 },
   capacity: { label: fa.command.goCapacitySettings, order: 170 },
   'team-health': { label: fa.command.goTeamHealth, order: 180 },
   heartbeat: {
      label: fa.command.goHeartbeat,
      order: 190,
      aliases: [{
         id: 'go-today-plan',
         label: fa.command.goTodayPlan,
         description: fa.pages.todayPlanDescription,
         order: 200,
      }],
   },
   members: { label: fa.command.goMembers, order: 210 },
   teams: { label: fa.command.goTeams, order: 220 },
   settings: { label: fa.command.goSettings, order: 230 },
};

export type WorkspaceCommandEntry = {
   id: string;
   label: string;
   description: string;
   icon: WorkspaceNavigationIcon;
   order: number;
   route: WorkspaceRouteDefinition;
};

export function workspaceCommandEntries(runtime: WorkspaceNavigationRuntime): WorkspaceCommandEntry[] {
   return workspaceCommandRoutes(runtime)
      .flatMap((route) => {
         const presentation = workspaceCommandPresentation[route.id];
         const primary: WorkspaceCommandEntry = {
            id: `go-${route.id}`,
            label: presentation?.label || route.label,
            description: route.description,
            icon: route.icon,
            order: presentation?.order ?? 500 + (route.sidebarOrder || 0),
            route,
         };
         const aliases = (presentation?.aliases || []).map((alias) => ({
            ...alias,
            icon: route.icon,
            route,
         }));
         return [primary, ...aliases];
      })
      .sort((left, right) => left.order - right.order);
}

export function workspaceCommandIsDefault(
   route: WorkspaceRouteDefinition,
   runtime: WorkspaceNavigationRuntime
): boolean {
   if (route.commandDefault === 'manager') return isWorkspaceAdminRole(runtime.role);
   if (route.commandDefault === 'member') return !isWorkspaceAdminRole(runtime.role);
   return route.commandDefault === true;
}

export function defaultWorkspacePath(
   workspaceSlug: string,
   runtime: WorkspaceNavigationRuntime
): string {
   if (runtime.mode === 'SUPPORT' && runtime.support?.needsSetup !== false) {
      const setup = workspaceRouteRegistry.find((candidate) => candidate.id === 'support-setup');
      if (setup && workspaceRouteIsAvailable(setup, runtime)) return setup.path(workspaceSlug, runtime);
      return `/${workspaceSlug}/support/no-access`;
   }

   const route = workspaceRouteRegistry
      .filter((candidate) => candidate.defaultPriority !== undefined)
      .filter((candidate) => workspaceRouteIsAvailable(candidate, runtime))
      .sort((left, right) => (right.defaultPriority || 0) - (left.defaultPriority || 0))[0];

   if (route) return route.path(workspaceSlug, runtime);
   return runtime.mode === 'SUPPORT'
      ? `/${workspaceSlug}/support/no-access`
      : `/${workspaceSlug}/overview`;
}

export function workspaceRuntimeForMembership(workspace: {
   mode?: unknown;
}, role?: string | null): WorkspaceNavigationRuntime | null {
   const mode = normalizeWorkspaceMode(workspace.mode);
   if (!mode) return null;
   return {
      mode,
      role,
      capabilities: resolveWorkspaceCapabilities(mode, undefined),
      permissions: new Set<string>(),
   };
}

export function workspaceHomeForMembership(
   workspace: { slug: string; mode?: unknown },
   role?: string | null
): string {
   const runtime = workspaceRuntimeForMembership(workspace, role);
   if (!runtime) return `/${workspace.slug}/support/no-access`;
   return defaultWorkspacePath(workspace.slug, runtime);
}

export type WorkspaceCreateAction = {
   eventName: 'taskara:create-issue' | 'taskara:create-support-case';
   label: string;
   description: string;
};

export function workspaceCreateAction(runtime: WorkspaceNavigationRuntime): WorkspaceCreateAction | null {
   if (runtime.mode === 'TEAM') {
      if (!runtime.capabilities.has('team.tasks')) return null;
      return {
         eventName: 'taskara:create-issue',
         label: fa.nav.createIssue,
         description: fa.command.createIssueDescription,
      };
   }

   if (!runtime.capabilities.has('support.cases') || !runtime.permissions.has('support.cases.create')) {
      return null;
   }
   return {
      eventName: 'taskara:create-support-case',
      label: fa.support.createCase,
      description: fa.support.createCaseDescription,
   };
}
