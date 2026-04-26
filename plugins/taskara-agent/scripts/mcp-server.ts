#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';

const taskStatuses = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELED'] as const;
const taskPriorities = ['NO_PRIORITY', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const workspaceRoles = ['OWNER', 'ADMIN', 'MEMBER', 'GUEST', 'AGENT'] as const;

const TaskStatus = z.enum(taskStatuses);
const TaskPriority = z.enum(taskPriorities);
const WorkspaceRole = z.enum(workspaceRoles);

type TaskStatusValue = (typeof taskStatuses)[number];
type TaskPriorityValue = (typeof taskPriorities)[number];
type JsonRecord = Record<string, unknown>;

interface Project {
  id: string;
  name: string;
  keyPrefix: string;
  description?: string | null;
  status: string;
  parentId?: string | null;
  _count?: { tasks?: number; subprojects?: number };
  tasks?: Task[];
  subprojects?: Project[];
}

interface Task {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  status: TaskStatusValue;
  priority: TaskPriorityValue;
  dueAt?: string | null;
  updatedAt?: string;
  completedAt?: string | null;
  project?: { id: string; name: string; keyPrefix: string };
  assignee?: { id: string; name: string; email: string } | null;
  labels?: Array<{ label: { id: string; name: string; color?: string } }>;
  attachments?: TaskAttachment[];
  _count?: { comments?: number; subtasks?: number; blockingDependencies?: number; attachments?: number };
  blockingDependencies?: Array<{ blockedByTask: Task }>;
  comments?: Array<{ body: string; createdAt: string; author?: { name: string } | null }>;
}

interface TaskAttachment {
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

interface TaskListResponse {
  items: Task[];
  total: number;
  limit: number;
  offset: number;
}

const apiUrl = requiredEnv('TASKARA_API_URL').replace(/\/$/, '');
const userEmail = requiredEnv('TASKARA_USER_EMAIL');
const workspaceSlug = requiredEnv('TASKARA_WORKSPACE_SLUG');

const server = new McpServer({ name: 'taskara-agent', version: '0.1.0' });

registerTool('check_connection', {
  title: 'Check Taskara API connection',
  description: 'Check the configured Taskara API URL and Codex user context.',
  inputSchema: {}
}, async () => {
  const health = await api<JsonRecord>('/health');
  return { apiUrl, workspaceSlug, userEmail, health };
});

registerTool('list_projects', {
  title: 'List Taskara projects',
  description: 'List projects and subprojects in the current Taskara workspace.',
  inputSchema: {
    includeArchived: z.boolean().default(false).describe('Include archived projects in the result')
  }
}, async ({ includeArchived }) => {
  const projects = await api<Project[]>('/projects');
  const items = includeArchived ? projects : projects.filter((project) => project.status !== 'ARCHIVED');
  return { projects: items.map(projectSummary), total: items.length };
});

registerTool('create_project', {
  title: 'Create Taskara project',
  description: 'Create a project or subproject. keyPrefix must be unique and uppercase, such as CORE or OPS.',
  inputSchema: {
    name: z.string().min(1).max(160),
    keyPrefix: z.string().min(2).max(12).regex(/^[A-Z][A-Z0-9]*$/),
    description: z.string().max(5000).optional(),
    parentId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional()
  }
}, async (input) => {
  const project = await api<Project>('/projects', { method: 'POST', body: input });
  return { project: projectSummary(project) };
});

registerTool('summarize_project', {
  title: 'Summarize Taskara project',
  description: 'Fetch a project and summarize progress, status distribution, priority distribution, overdue tasks, and next suggested work.',
  inputSchema: {
    projectId: z.string().uuid()
  }
}, async ({ projectId }) => {
  const project = await api<Project>(`/projects/${encodeURIComponent(projectId)}`);
  const tasks = project.tasks ?? [];
  const openTasks = tasks.filter((task) => !['DONE', 'CANCELED'].includes(task.status));
  const summary = {
    project: projectSummary(project),
    counts: {
      totalTasks: tasks.length,
      openTasks: openTasks.length,
      subprojects: project.subprojects?.length ?? 0,
      byStatus: countBy(tasks, (task) => task.status),
      byPriority: countBy(tasks, (task) => task.priority)
    },
    overdue: openTasks.filter(isOverdue).map(taskSummary),
    blocked: openTasks.filter((task) => task.status === 'BLOCKED').map(taskSummary),
    suggestedNext: rankTasks(openTasks).slice(0, 8).map(taskSummary)
  };
  return summary;
});

registerTool('search_tasks', {
  title: 'Search Taskara tasks',
  description: 'Search tasks by text, key, status, priority, assignee, or project.',
  inputSchema: {
    query: z.string().max(200).optional(),
    projectId: z.string().uuid().optional(),
    assigneeId: z.string().uuid().optional(),
    status: TaskStatus.optional(),
    priority: TaskPriority.optional(),
    mine: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(50)
  }
}, async (input) => {
  const params = new URLSearchParams();
  if (input.query) params.set('q', input.query);
  if (input.projectId) params.set('projectId', input.projectId);
  if (input.assigneeId) params.set('assigneeId', input.assigneeId);
  if (input.status) params.set('status', input.status);
  if (input.priority) params.set('priority', input.priority);
  if (input.mine) params.set('mine', 'true');
  params.set('limit', String(input.limit));
  const result = await api<TaskListResponse>(`/tasks?${params.toString()}`);
  return { total: result.total, tasks: result.items.map(taskSummary) };
});

registerTool('list_my_tasks', {
  title: 'List my Taskara tasks',
  description: 'List open or filtered tasks assigned to the configured Taskara user.',
  inputSchema: {
    status: TaskStatus.optional(),
    priority: TaskPriority.optional(),
    limit: z.number().int().min(1).max(100).default(50)
  }
}, async (input) => {
  const params = new URLSearchParams({ mine: 'true', limit: String(input.limit) });
  if (input.status) params.set('status', input.status);
  if (input.priority) params.set('priority', input.priority);
  const result = await api<TaskListResponse>(`/tasks?${params.toString()}`);
  return { total: result.total, tasks: result.items.map(taskSummary) };
});

registerTool('get_task', {
  title: 'Get Taskara task',
  description: 'Get a task by UUID or task key, including comments, subtasks, and dependencies.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123')
  }
}, async ({ task }) => {
  const item = await api<Task>(`/tasks/${encodeURIComponent(task)}`);
  return { task: taskDetails(item) };
});

registerTool('create_task', {
  title: 'Create Taskara task',
  description: 'Create a Taskara task in a project. Use this for single explicit task creation.',
  inputSchema: {
    projectId: z.string().uuid(),
    title: z.string().min(1).max(300),
    description: z.string().max(15000).optional(),
    status: TaskStatus.default('TODO'),
    priority: TaskPriority.default('NO_PRIORITY'),
    assigneeId: z.string().uuid().optional(),
    dueAt: z.string().datetime().optional(),
    labels: z.array(z.string().min(1).max(40)).max(12).default([]),
    parentId: z.string().uuid().optional(),
    cycleId: z.string().uuid().optional()
  }
}, async (input) => {
  const task = await api<Task>('/tasks', { method: 'POST', body: { ...input, source: 'CODEX' } });
  return { task: taskSummary(task) };
});

registerTool('update_task', {
  title: 'Update Taskara task',
  description: 'Update a Taskara task by UUID or key. Use explicit user confirmation before bulk done/canceled changes.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(15000).nullable().optional(),
    status: TaskStatus.optional(),
    priority: TaskPriority.optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    labels: z.array(z.string().min(1).max(40)).max(12).optional(),
    parentId: z.string().uuid().nullable().optional(),
    cycleId: z.string().uuid().nullable().optional()
  }
}, async ({ task, ...patch }) => {
  const body = dropUndefined(patch);
  if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update.');
  const updated = await api<Task>(`/tasks/${encodeURIComponent(task)}`, { method: 'PATCH', body });
  return { task: taskSummary(updated) };
});

registerTool('comment_on_task', {
  title: 'Comment on Taskara task',
  description: 'Add a comment to a Taskara task by UUID or key.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    body: z.string().min(1).max(15000)
  }
}, async ({ task, body }) => {
  const comment = await api<JsonRecord>(`/tasks/${encodeURIComponent(task)}/comments`, {
    method: 'POST',
    body: { body, source: 'CODEX' }
  });
  return { comment };
});

registerTool('upload_task_attachment', {
  title: 'Upload Taskara task attachment',
  description: 'Upload a local file and attach it to a Taskara task by UUID or key.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    filePath: z.string().min(1).describe('Absolute or relative path to a local file'),
    name: z.string().min(1).max(300).optional().describe('Display name to store for the attachment')
  }
}, async ({ task, filePath, name }) => {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const filename = basename(filePath);
  const form = new FormData();
  if (name) form.set('name', name);
  form.set('file', Bun.file(filePath), filename);

  const attachment = await apiForm<TaskAttachment>(`/tasks/${encodeURIComponent(task)}/attachments`, form);
  return { attachment };
});

registerTool('propose_tasks_from_text', {
  title: 'Propose Taskara tasks from text',
  description: 'Convert a discussion, plan, or Mattermost thread into proposed Taskara task actions. Does not create tasks until actions are applied.',
  inputSchema: {
    text: z.string().min(1).max(60000),
    projectId: z.string().uuid().optional(),
    sourceTitle: z.string().max(300).optional(),
    sourceUrl: z.string().url().optional()
  }
}, async (input) => {
  const run = await api<JsonRecord>('/agent/thread-to-tasks', { method: 'POST', body: input });
  return { agentRun: run };
});

registerTool('apply_agent_action', {
  title: 'Apply Taskara agent action',
  description: 'Apply a proposed Taskara agent action, such as creating a task from a thread proposal.',
  inputSchema: {
    actionId: z.string().uuid()
  }
}, async ({ actionId }) => {
  const result = await api<JsonRecord>(`/agent/actions/${encodeURIComponent(actionId)}/apply`, { method: 'POST', body: {} });
  return result;
});

registerTool('generate_daily_plan', {
  title: 'Generate Taskara daily plan',
  description: 'Generate today\'s focus list for the configured Taskara user.',
  inputSchema: {}
}, async () => {
  return api<JsonRecord>('/agent/daily-plan', { method: 'POST', body: {} });
});

registerTool('plan_work', {
  title: 'Plan Taskara work',
  description: 'Rank open work by priority, due date, and blocker status for a project or the current user.',
  inputSchema: {
    projectId: z.string().uuid().optional(),
    mine: z.boolean().default(false),
    maxTasks: z.number().int().min(1).max(25).default(8)
  }
}, async ({ projectId, mine, maxTasks }) => {
  const params = new URLSearchParams({ limit: '100' });
  if (projectId) params.set('projectId', projectId);
  if (mine) params.set('mine', 'true');
  const result = await api<TaskListResponse>(`/tasks?${params.toString()}`);
  const openTasks = result.items.filter((task) => !['DONE', 'CANCELED'].includes(task.status));
  return {
    totalOpen: openTasks.length,
    focus: rankTasks(openTasks).slice(0, maxTasks).map(taskSummary),
    blocked: openTasks.filter((task) => task.status === 'BLOCKED' || (task._count?.blockingDependencies ?? 0) > 0).map(taskSummary)
  };
});

registerTool('triage_backlog', {
  title: 'Triage Taskara backlog',
  description: 'Review backlog tasks and produce deterministic triage suggestions for priority, labels, and next action.',
  inputSchema: {
    projectId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).default(40)
  }
}, async ({ projectId, limit }) => {
  const params = new URLSearchParams({ status: 'BACKLOG', limit: String(limit) });
  if (projectId) params.set('projectId', projectId);
  const result = await api<TaskListResponse>(`/tasks?${params.toString()}`);
  return {
    total: result.total,
    suggestions: result.items.map((task) => ({
      task: taskSummary(task),
      suggestedPriority: inferPriority(`${task.title} ${task.description ?? ''}`),
      suggestedLabels: inferLabels(`${task.title} ${task.description ?? ''}`),
      nextAction: inferNextAction(task)
    }))
  };
});

registerTool('detect_blockers', {
  title: 'Detect Taskara blockers',
  description: 'Find blocked tasks and tasks with explicit blocking dependencies.',
  inputSchema: {
    projectId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).default(50)
  }
}, async ({ projectId, limit }) => {
  const blockedParams = new URLSearchParams({ status: 'BLOCKED', limit: String(limit) });
  if (projectId) blockedParams.set('projectId', projectId);
  const blocked = await api<TaskListResponse>(`/tasks?${blockedParams.toString()}`);

  const allParams = new URLSearchParams({ limit: String(limit) });
  if (projectId) allParams.set('projectId', projectId);
  const all = await api<TaskListResponse>(`/tasks?${allParams.toString()}`);
  const dependencyBlocked = all.items.filter((task) => (task._count?.blockingDependencies ?? 0) > 0);

  return {
    statusBlocked: blocked.items.map(taskSummary),
    dependencyBlocked: dependencyBlocked.map(taskSummary),
    total: new Set([...blocked.items, ...dependencyBlocked].map((task) => task.id)).size
  };
});

registerTool('generate_weekly_report', {
  title: 'Generate Taskara weekly report',
  description: 'Generate a weekly status report from project/task state and recent activity.',
  inputSchema: {
    projectId: z.string().uuid().optional()
  }
}, async ({ projectId }) => {
  const params = new URLSearchParams({ limit: '100' });
  if (projectId) params.set('projectId', projectId);
  const [tasksResult, activity] = await Promise.all([
    api<TaskListResponse>(`/tasks?${params.toString()}`),
    api<JsonRecord[]>('/activity')
  ]);
  const tasks = tasksResult.items;
  const done = tasks.filter((task) => task.status === 'DONE');
  const open = tasks.filter((task) => !['DONE', 'CANCELED'].includes(task.status));
  const report = {
    scope: projectId ? { projectId } : { workspace: workspaceSlug },
    generatedAt: new Date().toISOString(),
    summary: {
      totalTasks: tasks.length,
      done: done.length,
      open: open.length,
      blocked: open.filter((task) => task.status === 'BLOCKED').length,
      inReview: open.filter((task) => task.status === 'IN_REVIEW').length,
      byStatus: countBy(tasks, (task) => task.status),
      byPriority: countBy(tasks, (task) => task.priority)
    },
    completed: done.slice(0, 20).map(taskSummary),
    needsAttention: rankTasks(open).slice(0, 12).map(taskSummary),
    recentActivity: activity.slice(0, 15)
  };
  return report;
});

registerTool('list_users', {
  title: 'List Taskara users',
  description: 'Admin-only: list users in the current workspace.',
  inputSchema: {
    query: z.string().max(200).optional(),
    role: WorkspaceRole.optional(),
    limit: z.number().int().min(1).max(200).default(100)
  }
}, async ({ query, role, limit }) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set('q', query);
  if (role) params.set('role', role);
  return api<JsonRecord>(`/users?${params.toString()}`);
});

registerTool('create_user', {
  title: 'Create Taskara user',
  description: 'Admin-only: create or update a user and add them to the current workspace.',
  inputSchema: {
    email: z.string().email().max(254),
    name: z.string().min(1).max(160),
    role: WorkspaceRole.default('MEMBER'),
    mattermostUsername: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/).optional(),
    avatarUrl: z.string().url().optional()
  }
}, async (input) => {
  const user = await api<JsonRecord>('/users', { method: 'POST', body: input });
  return { user };
});

registerTool('update_user_role', {
  title: 'Update Taskara user role',
  description: 'Admin-only: change a workspace user role. The API prevents demoting the last owner.',
  inputSchema: {
    userId: z.string().uuid(),
    role: WorkspaceRole
  }
}, async ({ userId, role }) => {
  const user = await api<JsonRecord>(`/users/${encodeURIComponent(userId)}/role`, { method: 'PATCH', body: { role } });
  return { user };
});

function registerTool<T extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: T },
  handler: (input: z.output<z.ZodObject<T>>) => Promise<unknown>
): void {
  server.registerTool(name, config as never, async (input: unknown) => {
    try {
      const data = await handler(input as z.output<z.ZodObject<T>>);
      return jsonResult(data);
    } catch (error) {
      return errorResult(error);
    }
  });
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-user-email': userEmail,
      'x-workspace-slug': workspaceSlug,
      'x-actor-type': 'CODEX'
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

async function apiForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'x-user-email': userEmail,
      'x-workspace-slug': workspaceSlug,
      'x-actor-type': 'CODEX'
    },
    body: form
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

function jsonResult(data: unknown): CallToolResult {
  const structuredContent = makeStructuredContent(data);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent
  };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true
  };
}

function makeStructuredContent(data: unknown): JsonRecord {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as JsonRecord;
  return { result: data };
}

function projectSummary(project: Project): JsonRecord {
  return {
    id: project.id,
    name: project.name,
    keyPrefix: project.keyPrefix,
    status: project.status,
    parentId: project.parentId ?? null,
    description: project.description ?? null,
    taskCount: project._count?.tasks ?? project.tasks?.length ?? 0,
    subprojectCount: project._count?.subprojects ?? project.subprojects?.length ?? 0
  };
}

function taskSummary(task: Task): JsonRecord {
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt ?? null,
    project: task.project ? { id: task.project.id, name: task.project.name, keyPrefix: task.project.keyPrefix } : null,
    assignee: task.assignee ? { id: task.assignee.id, name: task.assignee.name, email: task.assignee.email } : null,
    labels: task.labels?.map(({ label }) => label.name) ?? [],
    comments: task._count?.comments ?? task.comments?.length ?? 0,
    attachments: task._count?.attachments ?? task.attachments?.length ?? 0,
    blockingDependencies: task._count?.blockingDependencies ?? task.blockingDependencies?.length ?? 0
  };
}

function taskDetails(task: Task): JsonRecord {
  return {
    ...taskSummary(task),
    description: task.description ?? null,
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    comments: task.comments?.map((comment) => ({
      body: comment.body,
      createdAt: comment.createdAt,
      author: comment.author?.name ?? null
    })) ?? [],
    attachments: task.attachments?.map(attachmentSummary) ?? [],
    blockingDependencies: task.blockingDependencies?.map((dependency) => taskSummary(dependency.blockedByTask)) ?? []
  };
}

function attachmentSummary(attachment: TaskAttachment): JsonRecord {
  return {
    id: attachment.id,
    name: attachment.name,
    object: attachment.object,
    url: attachment.url,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    createdAt: attachment.createdAt
  };
}

function rankTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const blockedDelta = blockerPenalty(a) - blockerPenalty(b);
    if (blockedDelta !== 0) return blockedDelta;
    const priorityDelta = priorityScore(b.priority) - priorityScore(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return dueScore(a) - dueScore(b);
  });
}

function blockerPenalty(task: Task): number {
  return task.status === 'BLOCKED' || (task._count?.blockingDependencies ?? 0) > 0 ? 1 : 0;
}

function priorityScore(priority: TaskPriorityValue): number {
  return { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NO_PRIORITY: 0 }[priority] ?? 0;
}

function dueScore(task: Task): number {
  if (!task.dueAt) return Number.MAX_SAFE_INTEGER;
  return new Date(task.dueAt).getTime();
}

function isOverdue(task: Task): boolean {
  return Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
}

function countBy<T extends string>(items: Task[], getKey: (task: Task) => T): Record<T, number> {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

function inferPriority(text: string): TaskPriorityValue {
  if (/urgent|critical|asap|incident|فوری|بحرانی/i.test(text)) return 'URGENT';
  if (/block|blocked|security|payment|production|مسدود|امنیت|پرداخت/i.test(text)) return 'HIGH';
  if (/cleanup|polish|nice to have|بهبود/i.test(text)) return 'LOW';
  return 'MEDIUM';
}

function inferLabels(text: string): string[] {
  const labels = new Set<string>();
  const checks: Array<[RegExp, string]> = [
    [/api|backend|server|database|postgres|prisma/i, 'backend'],
    [/ui|react|frontend|rtl|jalali/i, 'frontend'],
    [/mattermost|slash|bot|channel/i, 'mattermost'],
    [/codex|mcp|plugin|agent/i, 'codex'],
    [/bug|fix|error|crash|issue/i, 'bug'],
    [/security|auth|permission|role/i, 'security']
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) labels.add(label);
  }
  return [...labels];
}

function inferNextAction(task: Task): string {
  if (!task.description) return 'Add acceptance criteria and enough context for an assignee.';
  if (task.priority === 'NO_PRIORITY') return 'Assign an explicit priority.';
  if (!task.assignee) return 'Assign an owner.';
  return 'Move to TODO or IN_PROGRESS when ready to execute.';
}

function dropUndefined<T extends Record<string, unknown>>(value: T): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

const transport = new StdioServerTransport();
await server.connect(transport);

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (value) return value;
  throw new Error(`${name} is required`);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}
