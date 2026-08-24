export const supportWorkspaceConnectionStatuses = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export type SupportWorkspaceConnectionStatus = (typeof supportWorkspaceConnectionStatuses)[number];

export const supportTaskRelationTypes = ['FIX_WORK', 'INVESTIGATION', 'FOLLOW_UP', 'RELATED'] as const;
export type SupportTaskRelationType = (typeof supportTaskRelationTypes)[number];

export type SupportHandoffProjectSummary = {
   name: string;
   keyPrefix: string;
   status: string;
};

/**
 * An opposite-workspace identifier that may only be submitted by an authorized action form.
 * Components must render the adjacent safe summary, never this value.
 */
export type SupportHandoffActionRef = string;

export interface SupportDepartmentWorkTarget {
   id: string;
   connectionId: string;
   allowCreateTasks: boolean;
   allowLinkTasks: boolean;
   active: boolean;
   connectionStatus?: SupportWorkspaceConnectionStatus;
   department: { id: string; name: string; slug: string };
   teamWorkspace?: { name: string };
   project: SupportHandoffProjectSummary;
   createdAt: string;
   updatedAt: string;
}

export interface SupportHandoffProjectOption extends SupportHandoffProjectSummary {
   actionRef: SupportHandoffActionRef;
}

export interface SupportWorkspaceConnection {
   id: string;
   status: SupportWorkspaceConnectionStatus;
   currentWorkspaceSide: 'SUPPORT' | 'TEAM';
   currentApproved: boolean;
   otherApproved: boolean;
   otherWorkspace: { name: string };
   revokedAt: string | null;
   targets: Array<{
      id: string;
      department: { id?: string; name: string; slug?: string };
      project: SupportHandoffProjectSummary & { actionRef?: SupportHandoffActionRef };
      allowCreateTasks: boolean;
      allowLinkTasks: boolean;
      active: boolean;
   }>;
   createdAt: string;
   updatedAt: string;
}

export interface SupportCaseWorkTarget {
   /** Opaque DepartmentWorkTarget identifier, used only when submitting a handoff. */
   actionRef: SupportHandoffActionRef;
   teamWorkspaceName: string;
   project: SupportHandoffProjectSummary;
   allowCreateTasks: boolean;
   allowLinkTasks: boolean;
}

export interface SupportCaseHandoffOptions {
   items: SupportCaseWorkTarget[];
   caseVersion: number;
   accessEpoch?: string | number;
}

export interface SupportHandoffTaskOption {
   /** Opaque Task identifier, used only when submitting a link/parent action. */
   actionRef: SupportHandoffActionRef;
   key: string;
   title: string;
   status: string;
   parentActionRef?: SupportHandoffActionRef | null;
}

/** Exact Support-side projection. It intentionally has no Case/Task/workspace raw identifier. */
export interface SupportCaseTaskLinkProjection {
   projectionVersion: 1;
   linkId: string;
   teamWorkspaceName: string;
   taskKey: string;
   title: string;
   status: string;
   lastSignalAt: string;
   tombstone: {
      taskDeletedAt: string | null;
      connectionRevokedAt: string | null;
      unlinkedAt: string | null;
   };
}

export interface SupportCaseTaskLinkList {
   items: SupportCaseTaskLinkProjection[];
   caseVersion?: number;
   accessEpoch?: string | number;
}

export interface SupportCaseTaskLinkMutationResult {
   link: SupportCaseTaskLinkProjection;
   caseVersion: number;
   accessEpoch?: string | number;
   replayed: boolean;
}

export interface SupportHandoffBaseInput {
   workTargetId: SupportHandoffActionRef;
   relationType: SupportTaskRelationType;
   handoffTitle: string;
   handoffSummary: string;
   baseVersion: number;
   idempotencyKey: string;
}

export interface LinkExistingTeamTaskInput extends SupportHandoffBaseInput {
   taskId: SupportHandoffActionRef;
}

export interface CreateLinkedTeamTaskInput extends SupportHandoffBaseInput {
   parentTaskId?: SupportHandoffActionRef;
   taskTitle: string;
   taskDescription?: string;
   taskPriority: 'NO_PRIORITY' | 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
}

/** Exact Team-side projection. It does not grant access back into the Support workspace. */
export interface TeamTaskSupportLinkProjection {
   projectionVersion: 1;
   linkId: string;
   supportWorkspaceName: string;
   caseKey: string;
   title: string;
   status: 'OPEN' | 'RESOLVED' | 'CLOSED';
   lastSignalAt: string;
   tombstone: {
      connectionRevokedAt: string | null;
      unlinkedAt: string | null;
   };
}
