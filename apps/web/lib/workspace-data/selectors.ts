import type { TaskaraTask, TaskaraTaskReview } from '@/lib/taskara-types';
import type { WorkspaceDataState } from '@/lib/workspace-data/store';
import { workspaceEntityList } from '@/lib/workspace-data/store';

const activeTaskStatuses = new Set(['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']);

export function selectCommandSearchItems(state: WorkspaceDataState) {
   return {
      tasks: state.tasks,
      projects: state.projects,
      teams: state.teams,
      users: state.users,
      views: state.views,
   };
}

export function selectIssueDetail(state: WorkspaceDataState, idOrKey: string | null | undefined) {
   const task = idOrKey
      ? state.tasks.find((item) => item.key === idOrKey || item.id === idOrKey) || null
      : null;
   const reviews = task ? selectTaskReviews(state, task.id) : [];

   return {
      task,
      reviews,
      users: state.users,
      projects: state.projects,
   };
}

export function selectSidebarCounts(state: WorkspaceDataState, currentUserId?: string | null) {
   const activeAttentionCount = workspaceEntityList(state.attention).filter((item) =>
      item.status === 'OPEN' ||
      (item.status === 'SNOOZED' && item.snoozedUntil && Date.parse(item.snoozedUntil) <= Date.now())
   ).length;
   const reviewCount = workspaceEntityList(state.reviews).filter((review) => review.status === 'REQUESTED').length;
   const activeTaskCount = state.tasks.filter(isActiveTask).length;
   const myActiveTaskCount = currentUserId
      ? state.tasks.filter((task) => isActiveTask(task) && task.assignee?.id === currentUserId).length
      : 0;
   const myOpenActionItemCount = workspaceEntityList(state.meetingActionItems).filter((item) => item.status === 'OPEN').length;

   return {
      activeAttentionCount,
      reviewCount,
      activeTaskCount,
      myActiveTaskCount,
      myOpenActionItemCount,
   };
}

export function selectTaskReviews(state: WorkspaceDataState, taskId: string): TaskaraTaskReview[] {
   return workspaceEntityList(state.reviews)
      .filter((review) => review.taskId === taskId)
      .sort((left, right) => Date.parse(right.requestedAt) - Date.parse(left.requestedAt));
}

export function selectTasksAssignedToUser(state: WorkspaceDataState, userId: string): TaskaraTask[] {
   return state.tasks
      .filter((task) => task.assignee?.id === userId)
      .sort(compareRecentTask);
}

function isActiveTask(task: TaskaraTask): boolean {
   return activeTaskStatuses.has(task.status);
}

function compareRecentTask(left: TaskaraTask, right: TaskaraTask): number {
   const leftDate = Date.parse(left.updatedAt || '') || Date.parse(left.createdAt || '') || 0;
   const rightDate = Date.parse(right.updatedAt || '') || Date.parse(right.createdAt || '') || 0;
   return rightDate - leftDate;
}
