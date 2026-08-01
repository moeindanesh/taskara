import type {
  MilestoneHealthValue,
  MilestoneKindValue,
  MilestoneStatusValue,
  TaskKindValue,
  TaskPriorityValue,
  TaskStatusValue,
  UserKindValue,
  WorkspaceRoleValue
} from '@taskara/shared';

/**
 * The shapes the API returns. Every enum here is imported from `@taskara/shared` rather than
 * re-declared: the plugin used to keep its own copies of the status, priority, role and milestone
 * lists, so adding a status to the API made this surface reject it with a zod error that named no
 * cause. There is now one list per vocabulary and it lives where the server's schemas live.
 */
export type JsonRecord = Record<string, unknown>;

export interface Project {
  id: string;
  name: string;
  keyPrefix: string;
  description?: string | null;
  status: string;
  parentId?: string | null;
  _count?: { tasks?: number; subprojects?: number; milestones?: number };
  tasks?: Task[];
  subprojects?: Project[];
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  name: string;
  documentId?: string | null;
  object: string;
  url: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  createdAt: string;
}

export interface Task {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  /** Bumped by every write. What an optimistic body rewrite quotes back as `baseVersion`. */
  version?: number;
  status: TaskStatusValue;
  priority: TaskPriorityValue;
  kind?: TaskKindValue;
  weight?: number | null;
  dueAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  parentId?: string | null;
  milestoneId?: string | null;
  project?: { id: string; name: string; keyPrefix: string };
  milestone?: { id: string; name: string; kind: string; status: string; projectId?: string } | null;
  assignee?: { id: string; name: string; email: string; kind?: string } | null;
  labels?: Array<{ label: { id: string; name: string; color?: string } }>;
  attachments?: TaskAttachment[];
  _count?: { comments?: number; subtasks?: number; blockingDependencies?: number; attachments?: number };
  blockingDependencies?: Array<{ blockedByTask: Task }>;
  blockedTasks?: Array<{ task: Task }>;
  subtasks?: Task[];
  comments?: Array<{ body: string; createdAt: string; author?: { name: string } | null }>;
}

export interface TaskListResponse {
  items: Task[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * One row of the workspace roster: a User, plus the membership that puts them in this workspace.
 *
 * `kind` is not decoration. Agents are teammates and belong in every list (#37), so a roster shows
 * both — and an agent shown unmarked is an agent indistinguishable from a colleague. `operatorId`
 * says whose machine it is: for an agent it names the human it acts for, and for a person it is
 * always null.
 *
 * The API returns more than this — a phone number, a Mattermost handle, an avatar and lifetime task
 * counts. None of it helps address anybody, so the shells project it away rather than printing it.
 */
export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  kind?: UserKindValue;
  operatorId?: string | null;
  role: WorkspaceRoleValue;
  membershipId?: string;
  phone?: string | null;
  mattermostUsername?: string | null;
  avatarUrl?: string | null;
}

export interface UserListResponse {
  items: WorkspaceMember[];
  total: number;
  limit: number;
  offset: number;
}

export interface MilestoneProgress {
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

export interface Milestone {
  id: string;
  workspaceId: string;
  projectId: string;
  ownerId?: string | null;
  name: string;
  description?: string | null;
  kind: MilestoneKindValue;
  status: MilestoneStatusValue;
  health?: MilestoneHealthValue | null;
  startsOn?: string | null;
  targetOn?: string | null;
  position: number;
  version: number;
  completedAt?: string | null;
  canceledAt?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  project?: { id: string; name: string; keyPrefix: string; team?: { id: string; name: string; slug: string } | null };
  owner?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
  progress: MilestoneProgress;
  attentionReasons?: Array<{ reason: string; count?: number }>;
  readyToComplete?: boolean;
  canManage?: boolean;
}

export interface MilestoneListResponse {
  items: Milestone[];
  total: number;
  limit: number;
  offset: number;
}
