import type {
   TaskaraAttentionItem,
   TaskaraCheckInResponse,
   TaskaraMeetingActionItem,
   TaskaraMilestone,
   TaskaraOneOnOneAgendaItem,
   TaskaraOneOnOneSeries,
   TaskaraProject,
   TaskaraProjectHealthUpdate,
   TaskaraTask,
   TaskaraTaskReview,
   TaskaraTeam,
   TaskaraUser,
   TaskaraView,
} from '@/lib/taskara-types';

export type WorkspaceEntityMap<T extends { id: string }> = Record<string, T>;

export interface WorkspaceDataEntities {
   attention: WorkspaceEntityMap<TaskaraAttentionItem>;
   reviews: WorkspaceEntityMap<TaskaraTaskReview>;
   checkIns: WorkspaceEntityMap<TaskaraCheckInResponse>;
   oneOnOnes: WorkspaceEntityMap<TaskaraOneOnOneSeries>;
   oneOnOneAgendaItems: WorkspaceEntityMap<TaskaraOneOnOneAgendaItem>;
   meetingActionItems: WorkspaceEntityMap<TaskaraMeetingActionItem>;
   projectHealthUpdates: WorkspaceEntityMap<TaskaraProjectHealthUpdate>;
}

export interface WorkspaceDataState extends WorkspaceDataEntities {
   tasks: TaskaraTask[];
   milestones: TaskaraMilestone[];
   projects: TaskaraProject[];
   teams: TaskaraTeam[];
   users: TaskaraUser[];
   views: TaskaraView[];
}

export type WorkspaceDataResources = Pick<
   WorkspaceDataState,
   'tasks' | 'milestones' | 'projects' | 'teams' | 'users' | 'views'
>;

export function emptyWorkspaceDataEntities(): WorkspaceDataEntities {
   return {
      attention: {},
      reviews: {},
      checkIns: {},
      oneOnOnes: {},
      oneOnOneAgendaItems: {},
      meetingActionItems: {},
      projectHealthUpdates: {},
   };
}

export function createWorkspaceDataState(
   resources: WorkspaceDataResources,
   entities: WorkspaceDataEntities = emptyWorkspaceDataEntities()
): WorkspaceDataState {
   return {
      ...resources,
      attention: entities.attention,
      reviews: entities.reviews,
      checkIns: entities.checkIns,
      oneOnOnes: entities.oneOnOnes,
      oneOnOneAgendaItems: entities.oneOnOneAgendaItems,
      meetingActionItems: entities.meetingActionItems,
      projectHealthUpdates: entities.projectHealthUpdates,
   };
}

export function workspaceEntityList<T extends { id: string }>(map: WorkspaceEntityMap<T>): T[] {
   return Object.values(map);
}
