import { z } from 'zod';

export const taskStatuses = [
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'BLOCKED',
  'DONE',
  'CANCELED'
] as const;

export const taskPriorities = [
  'NO_PRIORITY',
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT'
] as const;

export const taskViewLayouts = ['list', 'board'] as const;
export const taskViewGroupings = ['status', 'assignee', 'project', 'priority'] as const;
export const taskViewOrderings = ['priority', 'updatedAt', 'createdAt', 'dueAt', 'title'] as const;
export const taskViewSubGroupings = ['none', 'status', 'assignee', 'project', 'priority'] as const;
export const taskViewCompletedIssues = ['all', 'week', 'month', 'none'] as const;
export const taskViewDisplayProperties = [
  'id',
  'status',
  'assignee',
  'priority',
  'project',
  'dueAt',
  'labels',
  'milestone',
  'links',
  'timeInStatus',
  'createdAt',
  'updatedAt'
] as const;

export const projectStatuses = ['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
export const workspaceRoles = ['OWNER', 'ADMIN', 'MEMBER', 'GUEST', 'AGENT'] as const;

export type TaskStatusValue = (typeof taskStatuses)[number];
export type TaskPriorityValue = (typeof taskPriorities)[number];
export type WorkspaceRoleValue = (typeof workspaceRoles)[number];
export type TaskViewLayoutValue = (typeof taskViewLayouts)[number];
export type TaskViewGroupingValue = (typeof taskViewGroupings)[number];
export type TaskViewOrderingValue = (typeof taskViewOrderings)[number];
export type TaskViewSubGroupingValue = (typeof taskViewSubGroupings)[number];
export type TaskViewCompletedIssuesValue = (typeof taskViewCompletedIssues)[number];
export type TaskViewDisplayPropertyValue = (typeof taskViewDisplayProperties)[number];

export const taskStatusSchema = z.enum(taskStatuses);
export const taskPrioritySchema = z.enum(taskPriorities);
export const projectStatusSchema = z.enum(projectStatuses);
export const workspaceRoleSchema = z.enum(workspaceRoles);
export const taskViewLayoutSchema = z.enum(taskViewLayouts);
export const taskViewGroupingSchema = z.enum(taskViewGroupings);
export const taskViewOrderingSchema = z.enum(taskViewOrderings);
export const taskViewSubGroupingSchema = z.enum(taskViewSubGroupings);
export const taskViewCompletedIssuesSchema = z.enum(taskViewCompletedIssues);
export const taskViewDisplayPropertySchema = z.enum(taskViewDisplayProperties);

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(160),
  mattermostUsername: z.string().trim().toLowerCase().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/).optional(),
  avatarUrl: z.string().trim().url().optional(),
  role: workspaceRoleSchema.default('MEMBER')
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  mattermostUsername: z.string().trim().toLowerCase().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/).nullable().optional(),
  avatarUrl: z.string().trim().url().nullable().optional()
});

export const setWorkspaceRoleSchema = z.object({
  role: workspaceRoleSchema
});

export const userListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  role: workspaceRoleSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

export const passwordSchema = z.string().min(8).max(160);

export const authLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(160),
  workspaceSlug: z.string().trim().toLowerCase().min(2).max(48).regex(/^[a-z0-9-]+$/).optional()
});

export const authRegisterSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema
});

export const createAuthWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().min(2).max(48).regex(/^[a-z0-9-]+$/),
  description: z.string().trim().max(2000).optional()
});

export const authOnboardingSchema = createAuthWorkspaceSchema;

export const createWorkspaceInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(160).optional(),
  role: workspaceRoleSchema.default('MEMBER'),
  expiresInDays: z.coerce.number().int().min(1).max(90).default(14)
});

export const acceptWorkspaceInviteSchema = z.object({
  name: z.string().trim().min(1).max(160),
  password: passwordSchema
});

export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().min(2).max(32).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().trim().max(2000).optional()
});

export const addTeamMemberSchema = z.object({
  userId: z.string().uuid(),
  role: workspaceRoleSchema.default('MEMBER')
});

export const setTeamMemberRoleSchema = z.object({
  role: workspaceRoleSchema
});

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(160),
  keyPrefix: z.string().trim().toUpperCase().min(2).max(12).regex(/^[A-Z][A-Z0-9]*$/),
  description: z.string().trim().max(5000).optional(),
  teamId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional()
});

export const updateProjectSchema = createProjectSchema.partial().extend({
  teamId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  status: projectStatusSchema.optional()
});

export const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  parentId: z.string().uuid().optional(),
  cycleId: z.string().uuid().optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(15000).optional(),
  status: taskStatusSchema.default('TODO'),
  priority: taskPrioritySchema.default('NO_PRIORITY'),
  assigneeId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  labels: z.array(z.string().min(1).max(40)).max(12).default([]),
  source: z.enum(['WEB', 'API', 'MATTERMOST', 'CODEX', 'AGENT', 'SYSTEM']).default('API')
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(15000).nullable().optional(),
  projectId: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  cycleId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  labels: z.array(z.string().min(1).max(40)).max(12).optional()
});

export const createCommentSchema = z.object({
  body: z.string().min(1).max(15000),
  source: z.enum(['WEB', 'API', 'MATTERMOST', 'CODEX', 'AGENT', 'SYSTEM']).default('API'),
  mattermostPostId: z.string().optional()
});

export const taskListQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  teamId: z.string().min(1).default('all'),
  q: z.string().max(200).optional(),
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const taskViewStateSchema = z.object({
  scope: z.literal('tasks').default('tasks'),
  teamId: z.string().min(1).default('all'),
  query: z.string().max(200).default(''),
  status: z.array(taskStatusSchema).max(20).default([]),
  assigneeIds: z.array(z.string().min(1)).max(100).default([]),
  priority: z.array(taskPrioritySchema).max(20).default([]),
  projectIds: z.array(z.string().uuid()).max(100).default([]),
  labels: z.array(z.string().min(1).max(80)).max(100).default([]),
  layout: taskViewLayoutSchema.default('list'),
  groupBy: taskViewGroupingSchema.default('status'),
  subGroupBy: taskViewSubGroupingSchema.default('none'),
  orderBy: taskViewOrderingSchema.default('priority'),
  showEmptyGroups: z.boolean().default(false),
  showSubIssues: z.boolean().default(true),
  nestedSubIssues: z.boolean().default(false),
  orderCompletedByRecency: z.boolean().default(false),
  completedIssues: taskViewCompletedIssuesSchema.default('all'),
  displayProperties: z.array(taskViewDisplayPropertySchema).default([
    'id',
    'status',
    'assignee',
    'priority',
    'project',
    'dueAt',
    'labels'
  ])
});

export const taskViewQuerySchema = z.object({
  scope: z.literal('tasks').default('tasks'),
  teamId: z.string().min(1).default('all')
});

export const createTaskViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isShared: z.boolean().default(true),
  state: taskViewStateSchema
});

export const updateTaskViewSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isShared: z.boolean().optional(),
  state: taskViewStateSchema.optional()
});

export const proposeThreadTasksSchema = z.object({
  projectId: z.string().uuid().optional(),
  text: z.string().min(1).max(60000),
  sourceUrl: z.string().url().optional(),
  sourceTitle: z.string().max(300).optional()
});

export const codexTaskCreateSchema = createTaskSchema.omit({ source: true }).extend({
  source: z.literal('CODEX').default('CODEX')
});

export function normalizeTaskStatus(input: string): TaskStatusValue | null {
  const normalized = input.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, TaskStatusValue> = {
    TODO: 'TODO',
    TO_DO: 'TODO',
    BACKLOG: 'BACKLOG',
    START: 'IN_PROGRESS',
    STARTED: 'IN_PROGRESS',
    IN_PROGRESS: 'IN_PROGRESS',
    PROGRESS: 'IN_PROGRESS',
    REVIEW: 'IN_REVIEW',
    IN_REVIEW: 'IN_REVIEW',
    BLOCK: 'BLOCKED',
    BLOCKED: 'BLOCKED',
    DONE: 'DONE',
    COMPLETE: 'DONE',
    COMPLETED: 'DONE',
    CANCEL: 'CANCELED',
    CANCELED: 'CANCELED',
    CANCELLED: 'CANCELED'
  };
  return aliases[normalized] ?? null;
}

export function normalizeTaskPriority(input: string): TaskPriorityValue | null {
  const normalized = input.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, TaskPriorityValue> = {
    NONE: 'NO_PRIORITY',
    NO_PRIORITY: 'NO_PRIORITY',
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    NORMAL: 'MEDIUM',
    HIGH: 'HIGH',
    URGENT: 'URGENT',
    CRITICAL: 'URGENT'
  };
  return aliases[normalized] ?? null;
}

export function statusLabel(status: TaskStatusValue): string {
  return {
    BACKLOG: 'بک‌لاگ',
    TODO: 'برای انجام',
    IN_PROGRESS: 'در حال انجام',
    IN_REVIEW: 'در بازبینی',
    BLOCKED: 'مسدود',
    DONE: 'انجام شد',
    CANCELED: 'لغو شد'
  }[status];
}

export function priorityLabel(priority: TaskPriorityValue): string {
  return {
    NO_PRIORITY: 'بدون اولویت',
    LOW: 'کم',
    MEDIUM: 'متوسط',
    HIGH: 'زیاد',
    URGENT: 'فوری'
  }[priority];
}

export function workspaceRoleLabel(role: WorkspaceRoleValue): string {
  return {
    OWNER: 'مالک',
    ADMIN: 'مدیر',
    MEMBER: 'عضو',
    GUEST: 'مهمان',
    AGENT: 'عامل'
  }[role];
}
