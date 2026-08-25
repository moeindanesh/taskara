import { taskaraRequest } from '@/lib/taskara-client';
import type {
   CreateLinkedTeamTaskInput,
   LinkExistingTeamTaskInput,
   SupportCaseHandoffOptions,
   SupportCaseTaskLinkList,
   SupportCaseTaskLinkMutationResult,
   SupportCaseWorkTarget,
   SupportDepartmentWorkTarget,
   SupportHandoffProjectOption,
   SupportHandoffTaskOption,
   SupportTaskRelationType,
   SupportWorkspaceConnection,
   SupportWorkspaceConnectionStatus,
   TeamTaskSupportLinkProjection,
} from '@/lib/support-handoff-types';

function segment(value: string): string {
   return encodeURIComponent(value);
}

export function supportCaseTaskLinksPath(idOrKey: string): string {
   return `/support/cases/${segment(idOrKey)}/task-links`;
}

export function teamTaskSupportLinksPath(idOrKey: string): string {
   return `/tasks/${segment(idOrKey)}/support-case-links`;
}

export function supportCaseHandoffOptionsPath(idOrKey: string): string {
   return `/support/cases/${segment(idOrKey)}/handoff-options`;
}

export function supportHandoffTaskSearchPath(workTargetId: string, query: string, limit = 20): string {
   const params = new URLSearchParams({ q: query, limit: String(limit) });
   return `/support/department-work-targets/${segment(workTargetId)}/tasks?${params.toString()}`;
}

export const supportHandoffClient = {
   listConnections: async () => normalizeConnectionList(await taskaraRequest<unknown>('/workspace-connections')),
   createConnection: async (teamWorkspaceId: string) => {
      const result = asRecord(await taskaraRequest<unknown>('/support/workspace-connections', {
         method: 'POST',
         body: JSON.stringify({ teamWorkspaceId }),
      }));
      return { connection: normalizeWorkspaceConnection(result.connection), replayed: result.replayed === true };
   },
   approveConnection: async (connectionId: string, side: 'SUPPORT' | 'TEAM') =>
      normalizeWorkspaceConnection(await taskaraRequest<unknown>(`/workspace-connections/${segment(connectionId)}/approve`, {
         method: 'POST',
         body: JSON.stringify({ side }),
      })),
   revokeConnection: async (connectionId: string, reason: string) =>
      normalizeWorkspaceConnection(await taskaraRequest<unknown>(`/workspace-connections/${segment(connectionId)}/revoke`, {
         method: 'POST',
         body: JSON.stringify({ reason }),
      })),
   listConnectionProjects: async (connectionId: string) => {
      const result = asRecord(await taskaraRequest<unknown>(`/support/workspace-connections/${segment(connectionId)}/projects`));
      return asArray(result.items).map(normalizeProjectOption);
   },
   createWorkTarget: async (input: {
      connectionId: string;
      departmentId: string;
      projectId: string;
      allowCreateTasks: boolean;
      allowLinkTasks: boolean;
   }) => {
      const result = asRecord(await taskaraRequest<unknown>('/support/department-work-targets', {
         method: 'POST',
         body: JSON.stringify(input),
      }));
      return { target: normalizeDepartmentWorkTarget(result.target), replayed: result.replayed === true };
   },
   updateWorkTarget: async (targetId: string, input: { active?: boolean; allowCreateTasks?: boolean; allowLinkTasks?: boolean }) =>
      normalizeDepartmentWorkTarget(await taskaraRequest<unknown>(`/support/department-work-targets/${segment(targetId)}`, {
         method: 'PATCH',
         body: JSON.stringify(input),
      })),
   listCaseLinks: async (idOrKey: string) => normalizeTaskLinkList(await taskaraRequest<unknown>(supportCaseTaskLinksPath(idOrKey))),
   getCaseHandoffOptions: async (idOrKey: string) => normalizeHandoffOptions(await taskaraRequest<unknown>(supportCaseHandoffOptionsPath(idOrKey))),
   searchTargetTasks: async (workTargetId: string, query: string) =>
      normalizeTaskOptions(await taskaraRequest<unknown>(supportHandoffTaskSearchPath(workTargetId, query))),
   linkExistingTask: async (idOrKey: string, input: LinkExistingTeamTaskInput) =>
      normalizeTaskLinkMutation(await taskaraRequest<unknown>(supportCaseTaskLinksPath(idOrKey), {
         method: 'POST',
         body: JSON.stringify(input),
      })),
   createLinkedTask: async (idOrKey: string, input: CreateLinkedTeamTaskInput) =>
      normalizeTaskLinkMutation(await taskaraRequest<unknown>(`/support/cases/${segment(idOrKey)}/team-tasks`, {
         method: 'POST',
         body: JSON.stringify(input),
      })),
   unlinkTask: async (idOrKey: string, linkId: string, input: { reason: string; baseVersion: number }) =>
      normalizeTaskLinkMutation(await taskaraRequest<unknown>(`${supportCaseTaskLinksPath(idOrKey)}/${segment(linkId)}`, {
         method: 'DELETE',
         body: JSON.stringify(input),
      })),
   listTaskSupportLinks: async (idOrKey: string) => normalizeTeamTaskSupportLinks(await taskaraRequest<unknown>(teamTaskSupportLinksPath(idOrKey))),
};

export function normalizeConnectionList(value: unknown): { items: SupportWorkspaceConnection[] } {
   const record = asRecord(value);
   const rows = Array.isArray(value) ? value : asArray(record.items);
   return { items: rows.map(normalizeWorkspaceConnection) };
}

export function normalizeWorkspaceConnection(value: unknown): SupportWorkspaceConnection {
   const record = asRecord(value);
   const otherWorkspace = asRecord(record.otherWorkspace);
   return {
      id: requiredString(record.id),
      status: connectionStatus(record.status),
      currentWorkspaceSide: record.currentWorkspaceSide === 'TEAM' ? 'TEAM' : 'SUPPORT',
      currentApproved: record.currentApproved === true,
      otherApproved: record.otherApproved === true,
      otherWorkspace: { name: requiredString(otherWorkspace.name) },
      revokedAt: optionalString(record.revokedAt),
      targets: asArray(record.targets).map((value) => {
         const target = asRecord(value);
         const department = asRecord(target.department);
         const project = asRecord(target.project);
         return {
            id: requiredString(target.id),
            department: {
               id: optionalString(department.id) || undefined,
               name: requiredString(department.name),
               slug: optionalString(department.slug) || undefined,
            },
            project: {
               ...normalizeProjectSummary(project),
               actionRef: optionalString(project.id) || undefined,
            },
            allowCreateTasks: target.allowCreateTasks === true,
            allowLinkTasks: target.allowLinkTasks === true,
            active: target.active === true,
         };
      }),
      createdAt: requiredString(record.createdAt),
      updatedAt: requiredString(record.updatedAt),
   };
}

export function normalizeDepartmentWorkTarget(value: unknown): SupportDepartmentWorkTarget {
   const record = asRecord(value);
   const department = asRecord(record.department);
   const project = asRecord(record.project);
   return {
      id: requiredString(record.id),
      connectionId: requiredString(record.connectionId),
      allowCreateTasks: record.allowCreateTasks === true,
      allowLinkTasks: record.allowLinkTasks === true,
      active: record.active !== false,
      connectionStatus: connectionStatus(record.connectionStatus),
      department: {
         id: requiredString(department.id),
         name: requiredString(department.name),
         slug: requiredString(department.slug),
      },
      teamWorkspace: { name: requiredString(asRecord(record.teamWorkspace).name) },
      project: normalizeProjectSummary(project),
      createdAt: requiredString(record.createdAt),
      updatedAt: requiredString(record.updatedAt),
   };
}

export function normalizeCaseWorkTarget(value: unknown): SupportCaseWorkTarget {
   const record = asRecord(value);
   const project = asRecord(record.project);
   return {
      actionRef: requiredString(record.workTargetId ?? record.actionRef ?? record.id),
      teamWorkspaceName: requiredString(record.teamWorkspaceName),
      project: normalizeProjectSummary(project),
      allowCreateTasks: record.allowCreateTasks === true,
      allowLinkTasks: record.allowLinkTasks === true,
   };
}

export function normalizeCaseWorkTargets(value: unknown): SupportCaseWorkTarget[] {
   const record = asRecord(value);
   return (Array.isArray(value) ? value : asArray(record.items)).map(normalizeCaseWorkTarget);
}

export function normalizeHandoffOptions(value: unknown): SupportCaseHandoffOptions {
   const record = asRecord(value);
   return {
      items: asArray(record.items).map(normalizeCaseWorkTarget),
      caseVersion: numberValue(record.caseVersion),
      accessEpoch: stringOrNumber(record.accessEpoch),
   };
}

export function normalizeTaskOptions(value: unknown): SupportHandoffTaskOption[] {
   const record = asRecord(value);
   const rows = Array.isArray(value) ? value : asArray(record.items);
   return rows.map((item) => {
      const task = asRecord(item);
      return {
         actionRef: requiredString(task.actionRef ?? task.taskId ?? task.id),
         key: requiredString(task.key),
         title: requiredString(task.title),
         status: requiredString(task.status),
         parentActionRef: optionalString(task.parentId),
      };
   });
}

export function normalizeTaskLinkList(value: unknown): SupportCaseTaskLinkList {
   const record = asRecord(value);
   return {
      items: (Array.isArray(value) ? value : asArray(record.items)).map(normalizeTaskLinkProjection),
      caseVersion: optionalNumber(record.caseVersion),
      accessEpoch: stringOrNumber(record.accessEpoch),
   };
}

export function normalizeTaskLinkMutation(value: unknown): SupportCaseTaskLinkMutationResult {
   const record = asRecord(value);
   return {
      link: normalizeTaskLinkProjection(record.link),
      caseVersion: numberValue(record.caseVersion),
      accessEpoch: stringOrNumber(record.accessEpoch),
      replayed: record.replayed === true,
   };
}

/** Drops every raw opposite-aggregate id even when an older server includes one. */
export function normalizeTaskLinkProjection(value: unknown) {
   const record = asRecord(value);
   const tombstone = asRecord(record.tombstone);
   return {
      projectionVersion: 1 as const,
      linkId: requiredString(record.linkId),
      teamWorkspaceName: requiredString(record.teamWorkspaceName),
      taskKey: requiredString(record.taskKey),
      title: requiredString(record.title),
      status: requiredString(record.status),
      lastSignalAt: requiredString(record.lastSignalAt),
      tombstone: {
         taskDeletedAt: optionalString(tombstone.taskDeletedAt),
         connectionRevokedAt: optionalString(tombstone.connectionRevokedAt),
         unlinkedAt: optionalString(tombstone.unlinkedAt),
      },
   };
}

export function normalizeTeamTaskSupportLinks(value: unknown): TeamTaskSupportLinkProjection[] {
   const record = asRecord(value);
   return (Array.isArray(value) ? value : asArray(record.items)).map((value) => {
      const item = asRecord(value);
      const tombstone = asRecord(item.tombstone);
      return {
         projectionVersion: 1,
         linkId: requiredString(item.linkId),
         supportWorkspaceName: requiredString(item.supportWorkspaceName),
         caseKey: requiredString(item.caseKey),
         title: requiredString(item.title),
         status: coarseCaseStatus(item.status),
         lastSignalAt: requiredString(item.lastSignalAt),
         tombstone: {
            connectionRevokedAt: optionalString(tombstone.connectionRevokedAt),
            unlinkedAt: optionalString(tombstone.unlinkedAt),
         },
      };
   });
}

function normalizeProjectOption(value: unknown): SupportHandoffProjectOption {
   const record = asRecord(value);
   return {
      actionRef: requiredString(record.actionRef ?? record.projectId ?? record.id),
      ...normalizeProjectSummary(record),
   };
}

function normalizeProjectSummary(value: Record<string, unknown>) {
   return {
      name: requiredString(value.name),
      keyPrefix: requiredString(value.keyPrefix),
      status: requiredString(value.status),
   };
}

function connectionStatus(value: unknown): SupportWorkspaceConnectionStatus {
   return value === 'ACTIVE' || value === 'REVOKED' ? value : 'PENDING';
}

function relationType(value: unknown): SupportTaskRelationType {
   return value === 'INVESTIGATION' || value === 'FOLLOW_UP' || value === 'RELATED' ? value : 'FIX_WORK';
}

function coarseCaseStatus(value: unknown): 'OPEN' | 'RESOLVED' | 'CLOSED' {
   if (value === 'RESOLVED' || value === 'CLOSED') return value;
   return 'OPEN';
}

function asRecord(value: unknown): Record<string, unknown> {
   return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
   return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown): string {
   return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | null {
   return typeof value === 'string' && value ? value : null;
}

function numberValue(value: unknown): number {
   return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
   return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrNumber(value: unknown): string | number | undefined {
   return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
