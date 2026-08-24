export const workspaceModes = ['TEAM', 'SUPPORT'] as const;

export type WorkspaceMode = (typeof workspaceModes)[number];

export const workspaceCapabilities = [
   'common.members',
   'common.settings',
   'common.inbox',
   'common.knowledge',
   'team.tasks',
   'team.projects',
   'team.teams',
   'team.milestones',
   'team.daily-reports',
   'team.manager-os',
   'team.communications',
   'support.cases',
   'support.departments',
   'support.triage',
   'support.recovery',
   'support.reports',
] as const;

export type WorkspaceCapability = (typeof workspaceCapabilities)[number];

export const supportPermissions = [
   'support.setup',
   'support.cases.create',
   'support.triage.read',
   'support.department-inbox.read',
   'support.cases.mine.read',
   'support.recovery.read',
   'support.departments.manage',
   'support.reports.read',
] as const;

export type SupportPermission = (typeof supportPermissions)[number];

const knownCapabilities = new Set<string>(workspaceCapabilities);

const defaultCapabilities: Record<WorkspaceMode, readonly WorkspaceCapability[]> = {
   TEAM: [
      'common.members',
      'common.settings',
      'common.inbox',
      'common.knowledge',
      'team.tasks',
      'team.projects',
      'team.teams',
      'team.milestones',
      'team.daily-reports',
      'team.manager-os',
      'team.communications',
   ],
   SUPPORT: [
      'common.members',
      'common.settings',
      'common.inbox',
      'common.knowledge',
      'support.cases',
      'support.departments',
      'support.triage',
      'support.recovery',
      'support.reports',
   ],
};

/**
 * Missing mode is the additive-rollout compatibility case and therefore means TEAM. An unknown
 * value is different: it must not accidentally bootstrap Team providers for a future product mode.
 */
export function normalizeWorkspaceMode(value: unknown): WorkspaceMode | null {
   if (value === undefined || value === null || value === '') return 'TEAM';
   return value === 'TEAM' || value === 'SUPPORT' ? value : null;
}

/** Missing capabilities support an API/web rolling deploy. A present list is authoritative. */
export function resolveWorkspaceCapabilities(
   mode: WorkspaceMode,
   values: readonly string[] | null | undefined
): ReadonlySet<WorkspaceCapability> {
   const source = values === undefined || values === null ? defaultCapabilities[mode] : values;
   return new Set(source.filter((value): value is WorkspaceCapability => knownCapabilities.has(value)));
}

export function workspaceHasCapability(
   capabilities: ReadonlySet<WorkspaceCapability>,
   capability: WorkspaceCapability | undefined
): boolean {
   return !capability || capabilities.has(capability);
}

export function isWorkspaceAdminRole(role: string | null | undefined): boolean {
   return role === 'OWNER' || role === 'ADMIN';
}

export type WorkspaceProviderPolicy = {
   taskSync: boolean;
   supportMemoryStore: boolean;
   inboxPersistence: 'local' | 'memory';
};

export function workspaceProviderPolicy(mode: WorkspaceMode): WorkspaceProviderPolicy {
   return mode === 'TEAM'
      ? { taskSync: true, supportMemoryStore: false, inboxPersistence: 'local' }
      : { taskSync: false, supportMemoryStore: true, inboxPersistence: 'memory' };
}
