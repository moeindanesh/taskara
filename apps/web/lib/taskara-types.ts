export interface TaskaraProject {
   id: string;
   name: string;
   keyPrefix: string;
   description?: string | null;
   status: string;
   parentId?: string | null;
   team?: { id: string; name: string; slug: string } | null;
   lead?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   _count?: { tasks?: number; subprojects?: number };
}

export interface TaskaraTask {
   id: string;
   key: string;
   title: string;
   description?: string | null;
   status: string;
   priority: string;
   weight?: number | null;
   dueAt?: string | null;
   createdAt?: string;
   updatedAt?: string;
   completedAt?: string | null;
   progressStartedAt?: string | null;
   project?: {
      id: string;
      name: string;
      keyPrefix: string;
      team?: { id: string; name: string; slug: string } | null;
   } | null;
   assignee?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   reporter?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   version?: number;
   syncState?: 'pending';
   syncMutationId?: string;
   attachments?: TaskaraAttachment[];
   comments?: TaskaraTaskComment[];
   subtasks?: Array<{ id: string; key: string; title: string; status: string }>;
   blockingDependencies?: Array<{ id: string; blockedByTask?: { id: string; key: string; title: string } }>;
   blockedTasks?: Array<{ id: string; task?: { id: string; key: string; title: string } }>;
   labels?: Array<{ label: { id: string; name: string; color?: string } }>;
   _count?: { comments?: number; subtasks?: number; blockingDependencies?: number; attachments?: number };
}

export interface TaskaraAnnouncement {
   id: string;
   title: string;
   body?: string | null;
   status: string;
   publishedAt?: string | null;
   createdAt: string;
   updatedAt: string;
   creator?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   recipients?: Array<{
      id: string;
      userId: string;
      deliveredAt?: string | null;
      readAt?: string | null;
      createdAt: string;
      user: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null };
   }>;
   _count?: { recipients?: number };
}

export interface TaskaraMeeting {
   id: string;
   title: string;
   description?: string | null;
   status: string;
   scheduledAt?: string | null;
   heldAt?: string | null;
   createdAt: string;
   updatedAt: string;
   team?: { id: string; name: string; slug: string } | null;
   project?: { id: string; name: string; keyPrefix: string; teamId?: string | null } | null;
   owner?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   createdBy?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   participants?: Array<{
      id: string;
      userId: string;
      role: string;
      createdAt: string;
      user: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null };
   }>;
   tasks?: Array<{
      meetingId: string;
      taskId: string;
      createdAt: string;
      task: TaskaraTask;
   }>;
   _count?: { participants?: number; tasks?: number };
}

export type TaskViewLayout = 'list' | 'board';
export type TaskViewGrouping = 'status' | 'assignee' | 'project' | 'priority';
export type TaskViewSubGrouping = 'none' | TaskViewGrouping;
export type TaskViewOrdering = 'priority' | 'updatedAt' | 'createdAt' | 'dueAt' | 'title';
export type TaskViewCompletedIssues = 'all' | 'week' | 'month' | 'none';
export type TaskViewDisplayProperty =
   | 'id'
   | 'status'
   | 'assignee'
   | 'priority'
   | 'project'
   | 'dueAt'
   | 'labels'
   | 'milestone'
   | 'links'
   | 'timeInStatus'
   | 'createdAt'
   | 'updatedAt';

export interface TaskaraTaskViewState {
   scope: 'tasks';
   teamId: string;
   query: string;
   status: string[];
   assigneeIds: string[];
   priority: string[];
   projectIds: string[];
   labels: string[];
   layout: TaskViewLayout;
   groupBy: TaskViewGrouping;
   subGroupBy: TaskViewSubGrouping;
   orderBy: TaskViewOrdering;
   showEmptyGroups: boolean;
   showSubIssues: boolean;
   nestedSubIssues: boolean;
   orderCompletedByRecency: boolean;
   completedIssues: TaskViewCompletedIssues;
   displayProperties: TaskViewDisplayProperty[];
}

export interface TaskaraView {
   id: string;
   workspaceId: string;
   ownerId?: string | null;
   name: string;
   isShared: boolean;
   createdAt: string;
   updatedAt: string;
   state: TaskaraTaskViewState;
}

export interface TaskaraTaskComment {
   id: string;
   taskId: string;
   authorId?: string | null;
   body: string;
   source: string;
   mattermostPostId?: string | null;
   createdAt: string;
   updatedAt: string;
   author?: {
      id: string;
      name: string;
      email: string;
      mattermostUsername?: string | null;
      avatarUrl?: string | null;
   } | null;
   attachments?: TaskaraAttachment[];
}

export interface TaskaraAttachment {
   id: string;
   taskId: string;
   commentId?: string | null;
   name: string;
   documentId?: string | null;
   object: string;
   url: string;
   mimeType?: string | null;
   sizeBytes?: number | null;
   createdAt: string;
}

export interface TaskaraUser {
   id: string;
   membershipId: string;
   email: string;
   name: string;
   phone?: string | null;
   role: string;
   joinedAt: string;
   mattermostUsername?: string | null;
   avatarUrl?: string | null;
   _count?: {
      assignedTasks: number;
      reportedTasks: number;
      comments: number;
   };
}

export interface TaskaraTeam {
   id: string;
   name: string;
   slug: string;
   description?: string | null;
   _count?: {
      members?: number;
      projects?: number;
   };
}

export interface TaskaraTeamMember {
   membershipId: string;
   teamId: string;
   userId: string;
   role: string;
   joinedAt: string;
   user: {
      id: string;
      email: string;
      name: string;
      phone?: string | null;
      mattermostUsername?: string | null;
      avatarUrl?: string | null;
   };
}

export interface TaskaraWorkspaceMembership {
   membershipId: string;
   role: string;
   joinedAt: string;
   workspace: {
      id: string;
      name: string;
      slug: string;
      description?: string | null;
   };
}

export interface TaskaraNotification {
   id: string;
   type: string;
   title: string;
   body?: string | null;
   deliveredAt?: string | null;
   readAt?: string | null;
   createdAt: string;
   task?: {
      id: string;
      key: string;
      title: string;
      status: string;
      priority: string;
   } | null;
   announcement?: {
      id: string;
      title: string;
      status: string;
      publishedAt?: string | null;
   } | null;
   meeting?: {
      id: string;
      title: string;
      status: string;
      scheduledAt?: string | null;
      heldAt?: string | null;
   } | null;
}

export interface TaskaraActivity {
   id: string;
   action: string;
   entityType: string;
   entityId: string;
   actorType?: string;
   source?: string;
   before?: Record<string, unknown> | null;
   after?: Record<string, unknown> | null;
   createdAt: string;
   actor?: {
      id: string;
      name: string;
      email: string;
      avatarUrl?: string | null;
   } | null;
}

export interface TaskaraMe {
   workspace: {
      id: string;
      name: string;
      slug: string;
      description?: string | null;
   };
   user: {
      id: string;
      name: string;
      email: string;
      phone?: string | null;
      mattermostUsername?: string | null;
      avatarUrl?: string | null;
   };
   role?: string | null;
   unreadNotifications: number;
}

export interface TaskaraAuthSession {
   token: string;
   expiresAt: string;
   workspace?: TaskaraMe['workspace'] | null;
   user: TaskaraMe['user'];
   role?: string | null;
}

export interface TaskaraOnboardingStatus {
   needsOnboarding: boolean;
   workspace?: TaskaraMe['workspace'] | null;
   workspaces?: TaskaraWorkspaceMembership[];
}

export interface TaskaraAuthWorkspacesResponse {
   items: TaskaraWorkspaceMembership[];
   total: number;
   user: TaskaraMe['user'];
}

export interface TaskaraWorkspaceInvite {
   id: string;
   email: string;
   name?: string | null;
   role: string;
   createdAt: string;
   expiresAt: string;
   invitedBy?: {
      id: string;
      name: string;
      email: string;
      avatarUrl?: string | null;
      mattermostUsername?: string | null;
   } | null;
   inviteUrl?: string | null;
   workspace?: TaskaraMe['workspace'];
}

export interface PaginatedResponse<T> {
   items: T[];
   total: number;
   limit: number;
   offset: number;
}

export interface NotificationsResponse extends PaginatedResponse<TaskaraNotification> {
   unreadCount: number;
}

export interface AnnouncementsResponse extends PaginatedResponse<TaskaraAnnouncement> {
   unreadCount: number;
}

export interface SmsSendSummary {
   sent: number;
   skippedNoPhone: number;
   failed: number;
}

export interface NotificationSyncResponse {
   items: TaskaraNotification[];
   unreadCount: number;
   nextCursor?: string | null;
}
