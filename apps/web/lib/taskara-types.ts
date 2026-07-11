export interface TaskaraProject {
   id: string;
   name: string;
   keyPrefix: string;
   description?: string | null;
   status: string;
   parentId?: string | null;
   team?: { id: string; name: string; slug: string } | null;
   lead?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   healthUpdates?: TaskaraProjectHealthUpdate[];
   milestones?: TaskaraMilestone[];
   _count?: { tasks?: number; subprojects?: number; milestones?: number };
}

export type TaskaraMilestoneKind = 'FEATURE' | 'PHASE' | 'OTHER';
export type TaskaraMilestoneStatus = 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';
export type TaskaraMilestoneHealth = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK';

export interface TaskaraMilestoneProgress {
   totalTasks: number;
   eligibleTasks: number;
   completedTasks: number;
   canceledTasks: number;
   blockedTasks: number;
   overdueTasks: number;
   totalWeight: number;
   completedWeight: number;
   percentage: number | null;
}

export interface TaskaraMilestoneAttention {
   reason: string;
   label?: string;
   count?: number;
}

export interface TaskaraMilestone {
   id: string;
   workspaceId: string;
   projectId: string;
   ownerId?: string | null;
   name: string;
   description?: string | null;
   kind: TaskaraMilestoneKind;
   status: TaskaraMilestoneStatus;
   health?: TaskaraMilestoneHealth | null;
   startsOn?: string | null;
   targetOn?: string | null;
   position: number;
   version: number;
   completedAt?: string | null;
   canceledAt?: string | null;
   archivedAt?: string | null;
   createdAt: string;
   updatedAt: string;
   project: {
      id: string;
      name: string;
      keyPrefix: string;
      teamId?: string | null;
      leadId?: string | null;
      team?: { id: string; name: string; slug: string } | null;
      lead?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   };
   owner?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   progress: TaskaraMilestoneProgress;
   attentionReasons?: Array<string | TaskaraMilestoneAttention>;
   readyToComplete?: boolean;
   canManage?: boolean;
   tasks?: TaskaraTask[];
   activity?: TaskaraActivity[];
   /** Present only while a local-first mutation is waiting for server acknowledgement. */
   syncState?: 'pending';
   syncMutationId?: string;
}

export interface TaskaraMilestoneCreateInput {
   id?: string;
   projectId: string;
   name: string;
   kind: TaskaraMilestoneKind;
   status: 'PLANNED' | 'ACTIVE';
   ownerId?: string | null;
   description?: string | null;
   health?: TaskaraMilestoneHealth | null;
   startsOn?: string | null;
   targetOn?: string | null;
}

export type TaskaraMilestoneUpdatePatch = Partial<
   Pick<
      TaskaraMilestone,
      'description' | 'health' | 'kind' | 'name' | 'ownerId' | 'startsOn' | 'targetOn'
   >
>;

export interface TaskaraMilestoneReorderInput {
   beforeId?: string | null;
   afterId?: string | null;
}

export type TaskaraMilestoneLifecycleAction =
   | 'activate'
   | 'complete'
   | 'reopen'
   | 'cancel'
   | 'archive'
   | 'restore';

export interface TaskaraMilestoneLifecycleInput {
   unfinishedTaskPolicy?: 'KEEP' | 'MOVE' | 'UNASSIGN';
   targetMilestoneId?: string;
   note?: string | null;
}

export interface TaskaraMilestoneListResponse {
   items: TaskaraMilestone[];
   total: number;
   limit: number;
   offset: number;
}

export type TaskaraProjectUpdateHealth = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK';

export interface TaskaraProjectHealthUpdate {
   id: string;
   workspaceId: string;
   projectId: string;
   authorId?: string | null;
   health: TaskaraProjectUpdateHealth;
   summary: string;
   progress?: string | null;
   risks?: string | null;
   decisionsNeeded?: string | null;
   nextUpdateDueAt?: string | null;
   publishedAt?: string | null;
   createdAt: string;
   updatedAt: string;
   author?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   project?: {
      id: string;
      name: string;
      keyPrefix: string;
      teamId?: string | null;
      leadId?: string | null;
      team?: { id: string; name: string; slug: string } | null;
   };
}

export interface TaskaraProjectHealthUpdateListResponse {
   items: TaskaraProjectHealthUpdate[];
   total: number;
   limit: number;
   offset: number;
}

export interface TaskaraTask {
   id: string;
   key: string;
   title: string;
   description?: string | null;
   status: string;
   priority: string;
   parentId?: string | null;
   weight?: number | null;
   dueAt?: string | null;
   createdAt?: string;
   updatedAt?: string;
   completedAt?: string | null;
   progressStartedAt?: string | null;
   activeReviewRequest?: {
      id: string;
      reviewerId: string;
      requestedAt: string;
      dueAt?: string | null;
   };
   triageState?: {
      id: string;
      status: 'OPEN' | 'WAITING_FOR_INFO' | 'SNOOZED';
      requestedInfo?: string | null;
      snoozedUntil?: string | null;
      reason?: string | null;
      decidedById?: string | null;
      createdAt?: string;
      updatedAt?: string;
   } | null;
   project?: {
      id: string;
      name: string;
      keyPrefix: string;
      team?: { id: string; name: string; slug: string } | null;
   } | null;
   milestoneId?: string | null;
   milestone?: {
      id: string;
      name: string;
      kind: TaskaraMilestoneKind;
      status: TaskaraMilestoneStatus;
      archivedAt?: string | null;
      projectId?: string;
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

export interface TaskaraTaskReview {
   id: string;
   workspaceId: string;
   taskId: string;
   requesterId?: string | null;
   reviewerId: string;
   status: 'REQUESTED' | 'CHANGES_REQUESTED' | 'APPROVED' | 'CANCELED';
   requestedAt: string;
   respondedAt?: string | null;
   dueAt?: string | null;
   comment?: string | null;
   createdAt: string;
   updatedAt: string;
   requester?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   reviewer?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   task?: TaskaraTask;
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
   poll?: {
      id: string;
      question: string;
      allowMultiple: boolean;
      createdAt: string;
      updatedAt: string;
      options: Array<{
         id: string;
         label: string;
         position: number;
         createdAt: string;
         _count?: { votes?: number };
      }>;
   } | null;
   pollVoteOptionIds?: string[];
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

export interface TaskaraCheckInMissingResponse {
   items: Array<{
      user: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null };
      lastCheckInAt: string | null;
      hoursSinceLastCheckIn: number | null;
   }>;
   total: number;
   thresholdHours: number;
   generatedAt: string;
}

export interface TaskaraCheckInResponse {
   id: string;
   workspaceId: string;
   userId: string;
   authorId?: string | null;
   completedText?: string | null;
   blockersText?: string | null;
   planText?: string | null;
   helpText?: string | null;
   submittedFor: string;
   createdAt: string;
   updatedAt: string;
   user?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   author?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
}

export interface TaskaraOneOnOneSeries {
   id: string;
   workspaceId: string;
   managerId: string;
   participantId: string;
   title?: string | null;
   cadenceDays: number;
   nextScheduledAt?: string | null;
   lastMeetingId?: string | null;
   active: boolean;
   createdAt: string;
   updatedAt: string;
   manager?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   participant?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   lastMeeting?: { id: string; title: string; scheduledAt?: string | null; heldAt?: string | null; status: string } | null;
   _count?: { agendaItems?: number };
}

export interface TaskaraOneOnOneAgendaItem {
   id: string;
   workspaceId?: string;
   seriesId?: string;
   meetingId?: string | null;
   createdById?: string | null;
   sourceType?: string | null;
   sourceId?: string | null;
   title: string;
   notes?: string | null;
   status: 'OPEN' | 'DONE' | 'CANCELED';
   position?: number;
   createdAt: string;
   updatedAt?: string;
   createdBy?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   meeting?: { id: string; title: string; scheduledAt?: string | null; heldAt?: string | null; status?: string } | null;
}

export interface TaskaraOneOnOneAgendaResponse {
   series: TaskaraOneOnOneSeries;
   items: TaskaraOneOnOneAgendaItem[];
   generated: Array<{
      sourceType: 'attention' | 'blocked_task' | 'overdue_task' | 'check_in' | 'action_item';
      sourceId: string;
      title: string;
      notes?: string | null;
      severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
   }>;
   generatedAt: string;
}

export interface TaskaraMeetingActionItem {
   id: string;
   workspaceId: string;
   meetingId: string;
   taskId?: string | null;
   assigneeId?: string | null;
   createdById?: string | null;
   title: string;
   notes?: string | null;
   status: 'OPEN' | 'DONE' | 'CANCELED';
   dueAt?: string | null;
   createdAt: string;
   updatedAt: string;
   assignee?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   createdBy?: { id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null } | null;
   task?: { id: string; key: string; title: string; status: TaskaraTask['status'] } | null;
   meeting?: {
      id: string;
      title: string;
      status?: string;
      scheduledAt?: string | null;
      heldAt?: string | null;
      projectId?: string | null;
      project?: { id: string; name: string; keyPrefix: string; teamId?: string | null } | null;
   } | null;
}

export interface TaskaraMeetingActionItemListResponse {
   items: TaskaraMeetingActionItem[];
   total: number;
   limit: number;
   offset: number;
}

export interface TaskaraKnowledgeSpace {
   id: string;
   workspaceId: string;
   type: 'WORKSPACE' | 'TEAM' | 'PROJECT';
   teamId?: string | null;
   projectId?: string | null;
   key: string;
   name: string;
   description?: string | null;
   icon?: string | null;
   createdAt: string;
   updatedAt: string;
   team?: { id: string; name: string; slug: string } | null;
   project?: { id: string; name: string; keyPrefix: string; teamId?: string | null } | null;
   createdBy?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   updatedBy?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   _count?: { pages?: number };
}

export interface TaskaraKnowledgePage {
   id: string;
   workspaceId: string;
   spaceId: string;
   parentId?: string | null;
   slug: string;
   path: string;
   title: string;
   summary?: string | null;
   icon?: string | null;
   content: unknown;
   contentText: string;
   status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
   ownerId?: string | null;
   verifiedAt?: string | null;
   verifiedById?: string | null;
   verificationExpiresAt?: string | null;
   verified?: boolean;
   archivedAt?: string | null;
   position: number;
   version: number;
   createdAt: string;
   updatedAt: string;
   space?: TaskaraKnowledgeSpace;
   parent?: { id: string; title: string; slug: string; path: string } | null;
   owner?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   createdBy?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   updatedBy?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   verifiedBy?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   labels?: Array<{ label: { id: string; name: string; color?: string } }>;
   attachments?: TaskaraKnowledgeAttachment[];
   _count?: { children?: number; comments?: number; attachments?: number; references?: number };
}

export interface TaskaraKnowledgeAttachment {
   id: string;
   pageId: string;
   commentId?: string | null;
   name: string;
   documentId?: string | null;
   object: string;
   url: string;
   mimeType?: string | null;
   sizeBytes?: number | null;
   createdAt: string;
}

export interface TaskaraKnowledgeComment {
   id: string;
   workspaceId: string;
   pageId: string;
   authorId?: string | null;
   body: string;
   anchor?: unknown;
   resolvedAt?: string | null;
   resolvedById?: string | null;
   createdAt: string;
   updatedAt: string;
   author?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   resolvedBy?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
   attachments?: TaskaraKnowledgeAttachment[];
}

export interface TaskaraKnowledgePageVersion {
   id: string;
   pageId: string;
   version: number;
   title: string;
   content: unknown;
   contentText: string;
   reason?: string | null;
   createdAt: string;
   author?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
}

export interface TaskaraKnowledgeReference {
   id: string;
   workspaceId: string;
   pageId: string;
   type: 'PAGE' | 'TASK' | 'PROJECT' | 'MEETING' | 'ANNOUNCEMENT' | 'EXTERNAL_URL';
   targetId?: string | null;
   url?: string | null;
   title?: string | null;
   createdAt: string;
   page: TaskaraKnowledgePage;
}

export type TaskViewLayout = 'list' | 'board';
export type TaskViewGrouping = 'status' | 'assignee' | 'project' | 'milestone' | 'priority';
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
   milestoneIds: string[];
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

export interface WorkHealthSummary {
   generatedAt: string;
   scope: {
      workspaceWide: boolean;
      teamIds: string[];
      projectIds: string[];
   };
   thresholds: {
      dailyWeightLimit: number;
      staleAfterHours: number;
      blockedSlaHours: number;
      reviewSlaHours: number;
      dueSoonHours: number;
   };
   overview: {
      activeTasks: number;
      loadedActiveTasks: number;
      truncated: boolean;
      overdueTasks: number;
      blockedTasks: number;
      reviewTasks: number;
      staleTasks: number;
      unassignedActiveTasks: number;
      backlogTasks: number;
      statusCounts: Record<'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'BLOCKED' | 'DONE' | 'CANCELED', number>;
      overloadedPeople: number;
      peopleWithoutActiveWork: number;
   };
   attention: WorkHealthAttentionItem[];
   people: WorkHealthPerson[];
   queues: {
      overdue: TaskaraTask[];
      blocked: TaskaraTask[];
      review: TaskaraTask[];
      stale: TaskaraTask[];
      unassigned: TaskaraTask[];
      backlog: TaskaraTask[];
   };
   projects: WorkHealthProject[];
}

export interface WorkHealthAttentionItem {
   id: string;
   reason:
      | 'overdue_task'
      | 'blocked_task'
      | 'review_waiting'
      | 'backlog_triage'
      | 'stale_task'
      | 'unassigned_due_soon'
      | 'overloaded_person'
      | 'person_without_active_work'
      | 'project_at_risk'
      | 'project_update_due';
   severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
   title: string;
   description: string;
   actionLabel: string;
   entityType: 'task' | 'user' | 'project';
   task?: TaskaraTask;
   user?: {
      id: string;
      name: string;
      email: string;
      phone?: string | null;
      mattermostUsername?: string | null;
      avatarUrl?: string | null;
   };
   project?: TaskaraProject;
   ageHours?: number;
   dueAt?: string | null;
}

export interface WorkHealthPerson {
   user: {
      id: string;
      name: string;
      email: string;
      phone?: string | null;
      mattermostUsername?: string | null;
      avatarUrl?: string | null;
   };
   activeCount: number;
   activeWeight: number;
   todayWeight: number;
   reviewCount: number;
   blockedCount: number;
   overdueCount: number;
   staleCount: number;
   capacity: number;
   capacityActive?: boolean;
   loadRatio: number;
   status: 'idle' | 'balanced' | 'busy' | 'overloaded';
   tasks: TaskaraTask[];
}

export interface WorkHealthProject {
   project: TaskaraProject;
   activeCount: number;
   activeWeight: number;
   blockedCount: number;
   overdueCount: number;
   reviewCount: number;
   staleCount: number;
   unassignedCount: number;
   health: 'healthy' | 'needs_attention' | 'at_risk';
}

export interface TaskaraUserCapacity {
   id?: string;
   workspaceId: string;
   userId: string;
   dailyWeightLimit: number;
   weeklyWeightLimit?: number | null;
   active: boolean;
   note?: string | null;
   createdAt?: string;
   updatedAt?: string;
}

export interface TaskaraCapacityUser {
   membershipId: string;
   role: string;
   joinedAt: string;
   user: {
      id: string;
      name: string;
      email: string;
      phone?: string | null;
      mattermostUsername?: string | null;
      avatarUrl?: string | null;
   };
   capacity: TaskaraUserCapacity;
}

export interface TaskaraCapacityUserListResponse {
   items: TaskaraCapacityUser[];
   total: number;
}

export interface TaskaraTeamWorkingAgreement {
   id: string;
   workspaceId: string;
   teamId?: string | null;
   scopeKey: string;
   activeWipLimit?: number | null;
   reviewWipLimit?: number | null;
   reviewSlaHours: number;
   blockedSlaHours: number;
   staleAfterHours: number;
   createdAt: string;
   updatedAt: string;
   team?: { id: string; name: string; slug: string } | null;
}

export interface TaskaraTeamWorkingAgreementListResponse {
   items: TaskaraTeamWorkingAgreement[];
   total: number;
}

export interface TaskaraAssignmentRecommendation {
   user: {
      id: string;
      name: string;
      email: string;
      phone?: string | null;
      mattermostUsername?: string | null;
      avatarUrl?: string | null;
   };
   capacity: number;
   activeCount: number;
   activeWeight: number;
   projectedWeight: number;
   loadRatio: number;
   projectedLoadRatio: number;
   reviewCount: number;
   blockedCount: number;
   overdueCount: number;
   dueSoonCount: number;
   projectActiveCount: number;
   score: number;
   status: 'available' | 'busy' | 'overloaded' | 'unavailable';
   reasons: Array<{
      code: string;
      tone: 'positive' | 'neutral' | 'warning';
      message: string;
   }>;
}

export interface TaskaraAssignmentRecommendationResponse {
   generatedAt: string;
   project: {
      id: string;
      name: string;
      keyPrefix: string;
      teamId?: string | null;
      team?: { id: string; name: string; slug: string } | null;
   };
   task?: { id: string; key: string; title: string; assigneeId?: string | null } | null;
   context: {
      weight: number;
      priority: string;
      dueAt?: string | null;
      activeWipLimit?: number | null;
      reviewWipLimit?: number | null;
   };
   recommendations: TaskaraAssignmentRecommendation[];
   excluded: {
      inactive: number;
      unsupportedRole: number;
      outsideProjectMembership: number;
   };
}

export interface TaskaraAttentionResponse {
   items: TaskaraAttentionItem[];
   total: number;
   limit: number;
   offset: number;
   generatedAt: string | null;
}

export interface TaskaraAttentionItem {
   id: string;
   workspaceId: string;
   assigneeId: string | null;
   managerId: string | null;
   entityType: 'task' | 'user' | string;
   entityId: string;
   reason:
      | 'overdue_task'
      | 'blocked_task'
      | 'review_waiting'
      | 'stale_task'
      | 'unassigned_due_soon'
      | 'overloaded_person'
      | 'person_without_active_work'
      | 'project_at_risk'
      | 'project_update_due'
      | 'missing_check_in'
      | 'one_on_one_due'
      | 'stale_meeting_action_item'
      | string;
   severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
   status: 'OPEN' | 'SNOOZED' | 'RESOLVED' | 'DISMISSED';
   firstSeenAt: string;
   lastSeenAt: string;
   snoozedUntil: string | null;
   resolvedAt: string | null;
   dismissedAt: string | null;
   dismissalReason: string | null;
   payload: TaskaraAttentionPayload;
   createdAt: string;
   updatedAt: string;
}

export interface TaskaraAttentionPayload {
   version?: 1;
   title?: string;
   description?: string;
   actionLabel?: string;
   reason?: string;
   severity?: TaskaraAttentionItem['severity'];
   entity?: {
      type: string;
      id: string;
   };
   signal?: {
      conditionKey?: string;
      generatedAt?: string;
      ageHours?: number;
      dueAt?: string | null;
   };
   task?: {
      id: string;
      key: string;
      title: string;
      status: TaskaraTask['status'];
      priority: TaskaraTask['priority'];
      dueAt: string | null;
      assigneeId: string | null;
      projectId: string | null;
      projectName: string | null;
   };
   user?: {
      id: string;
      name: string;
      email: string;
      avatarUrl?: string | null;
   };
   project?: {
      id: string;
      name: string;
      keyPrefix: string;
      teamId?: string | null;
      teamName?: string | null;
      leadId?: string | null;
      healthUpdate?: {
         id: string;
         health: TaskaraProjectUpdateHealth;
         summary: string;
         nextUpdateDueAt?: string | null;
         createdAt: string;
      } | null;
   };
   oneOnOne?: {
      id: string;
      title?: string | null;
      participantId: string;
      participantName: string;
      managerId: string;
      managerName: string;
      nextScheduledAt?: string | null;
   };
   actionItem?: {
      id: string;
      title: string;
      dueAt?: string | null;
      createdAt: string;
      assigneeId?: string | null;
      assigneeName?: string | null;
      meetingId: string;
      meetingTitle: string;
   };
   lifecycle?: {
      lastClearedAt?: string;
      manuallyResolvedAt?: string;
      dismissedAt?: string;
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
   knowledgePage?: {
      id: string;
      title: string;
      path: string;
      status: string;
      updatedAt?: string;
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
      aiModel?: string | null;
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
