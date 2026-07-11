import type { TaskaraMilestone, TaskaraTask, TaskaraTaskReview } from '@/lib/taskara-types';
import type { WorkspaceDataState } from '@/lib/workspace-data/store';
import { workspaceEntityList } from '@/lib/workspace-data/store';

const activeTaskStatuses = new Set(['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']);

export function selectCommandSearchItems(state: WorkspaceDataState) {
   return {
      tasks: state.tasks,
      milestones: state.milestones,
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
      milestones: state.milestones,
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
   const myOverdueMilestoneCount = currentUserId
      ? state.milestones.filter((milestone) => isOwnedOverdueMilestone(milestone, currentUserId)).length
      : 0;

   return {
      activeAttentionCount,
      reviewCount,
      activeTaskCount,
      myActiveTaskCount,
      myOpenActionItemCount,
      myOverdueMilestoneCount,
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

function isOwnedOverdueMilestone(milestone: TaskaraMilestone, currentUserId: string): boolean {
   if (milestone.ownerId !== currentUserId && milestone.owner?.id !== currentUserId) return false;
   if (milestone.archivedAt || milestone.status === 'COMPLETED' || milestone.status === 'CANCELED') return false;
   if (!milestone.targetOn) return false;
   return milestone.targetOn.slice(0, 10) < localDateKey(new Date(Date.now()));
}

function localDateKey(date: Date): string {
   const year = date.getFullYear();
   const month = String(date.getMonth() + 1).padStart(2, '0');
   const day = String(date.getDate()).padStart(2, '0');
   return `${year}-${month}-${day}`;
}

function compareRecentTask(left: TaskaraTask, right: TaskaraTask): number {
   const leftDate = Date.parse(left.updatedAt || '') || Date.parse(left.createdAt || '') || 0;
   const rightDate = Date.parse(right.updatedAt || '') || Date.parse(right.createdAt || '') || 0;
   return rightDate - leftDate;
}
