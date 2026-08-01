#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  EFFORT_DESCRIPTION_MAX_CHARS,
  milestoneHealthSchema,
  milestoneKindSchema,
  milestoneStatuses,
  milestoneStatusSchema,
  taskKindSchema,
  taskPrioritySchema,
  taskStatusSchema,
  userKindSchema,
  workspaceRoleSchema
} from '@taskara/shared';
import { z } from 'zod';
import { TaskaraClient } from './core/client';
import { readConfig } from './core/config';
import { mentionNotice } from './core/mentions';
import * as api from './core/operations';
import type { JsonRecord } from './core/types';
import {
  countBy,
  dropUndefined,
  inferLabels,
  inferNextAction,
  inferPriority,
  isOverdue,
  isUnfinished,
  milestoneDetails,
  milestoneSummary,
  projectSummary,
  rankTasks,
  taskDetails,
  taskSummary
} from './mcp/summaries';

/**
 * The MCP shell: the same core the CLI uses, rendered for a conversation.
 *
 * Every enum below comes from `@taskara/shared`. The plugin used to keep private copies of the
 * status, priority, role and milestone lists, so adding a status server-side made this server reject
 * it with a zod error that named no cause — a drift bug that could only be found by reading two
 * files side by side.
 *
 * Tool names follow the same `noun_verb` grammar as the CLI's `taskara <noun> <verb>`, so the two
 * surfaces can be documented as one table rather than two vocabularies for one product.
 */

const MilestoneDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const config = readConfig();
const client = new TaskaraClient(config);
const server = new McpServer({ name: 'taskara-agent', version: '0.1.0' });

/* -------------------------------------------------------------- workspace */

registerTool('workspace_check', {
  title: 'Check the Taskara connection',
  description: 'Check the configured Taskara API URL, workspace and identity.',
  inputSchema: {}
}, async () => {
  const health = await api.getHealth(client);
  return {
    apiUrl: config.apiUrl,
    workspaceSlug: config.workspaceSlug,
    // Never the token itself, only whether one is in use.
    authentication: config.token ? 'agent-credential' : `user-email:${config.userEmail}`,
    runtime: config.runtime ?? null,
    health
  };
});

/* ---------------------------------------------------------------- project */

registerTool('project_list', {
  title: 'List Taskara projects',
  description: 'List projects and subprojects in the current Taskara workspace.',
  inputSchema: {
    includeArchived: z.boolean().default(false).describe('Include archived projects in the result')
  }
}, async ({ includeArchived }) => {
  const projects = await api.listProjects(client);
  const items = includeArchived ? projects : projects.filter((project) => project.status !== 'ARCHIVED');
  return { projects: items.map(projectSummary), total: items.length };
});

registerTool('project_create', {
  title: 'Create a Taskara project',
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
  const project = await api.createProject(client, input);
  return { project: projectSummary(project) };
});

registerTool('project_summarize', {
  title: 'Summarize a Taskara project',
  description: 'Fetch a project and summarize progress, status and priority distribution, overdue tasks, and next suggested work.',
  inputSchema: { projectId: z.string().uuid() }
}, async ({ projectId }) => {
  const project = await api.getProject(client, projectId);
  const tasks = project.tasks ?? [];
  const openTasks = tasks.filter(isUnfinished);
  return {
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
});

/* -------------------------------------------------------------- milestone */

registerTool('milestone_list', {
  title: 'List Taskara milestones',
  description: 'List accessible project-scoped milestones with lifecycle, owner, target date, attention, and server-derived progress.',
  inputSchema: {
    query: z.string().max(200).optional(),
    projectId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    ownerId: z.union([z.string().uuid(), z.literal('none')]).optional(),
    kind: milestoneKindSchema.optional(),
    status: z.array(milestoneStatusSchema).min(1).max(milestoneStatuses.length).optional(),
    health: z.union([milestoneHealthSchema, z.literal('none')]).optional(),
    overdue: z.boolean().optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0)
  }
}, async (input) => {
  const result = await api.listMilestones(client, dropUndefined({
    q: input.query,
    projectId: input.projectId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    kind: input.kind,
    status: input.status?.join(','),
    health: input.health,
    overdue: input.overdue,
    includeArchived: input.includeArchived,
    limit: input.limit,
    offset: input.offset
  }));
  return {
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    milestones: result.items.map(milestoneSummary)
  };
});

registerTool('milestone_create', {
  title: 'Create a Taskara milestone',
  description: 'Create a lightweight feature, implementation phase, or other goal inside one project.',
  inputSchema: {
    projectId: z.string().uuid(),
    name: z.string().min(1).max(160),
    kind: milestoneKindSchema,
    status: z.enum(['PLANNED', 'ACTIVE']).default('PLANNED'),
    ownerId: z.string().uuid().nullable().optional(),
    description: z.string().max(15000).nullable().optional(),
    health: milestoneHealthSchema.nullable().optional(),
    startsOn: MilestoneDate.nullable().optional(),
    targetOn: MilestoneDate.nullable().optional()
  }
}, async (input) => {
  const milestone = await api.createMilestone(client, input);
  return { milestone: milestoneDetails(milestone) };
});

registerTool('milestone_update', {
  title: 'Update a Taskara milestone',
  description: 'Update milestone metadata using its current version. Lifecycle changes remain explicit milestone actions in Taskara.',
  inputSchema: {
    milestoneId: z.string().uuid(),
    version: z.number().int().min(1),
    name: z.string().min(1).max(160).optional(),
    kind: milestoneKindSchema.optional(),
    ownerId: z.string().uuid().nullable().optional(),
    description: z.string().max(15000).nullable().optional(),
    health: milestoneHealthSchema.nullable().optional(),
    startsOn: MilestoneDate.nullable().optional(),
    targetOn: MilestoneDate.nullable().optional()
  }
}, async ({ milestoneId, ...patch }) => {
  const body = dropUndefined(patch);
  if (Object.keys(body).every((key) => key === 'version')) {
    throw new Error('Provide at least one milestone field to update.');
  }
  const milestone = await api.updateMilestone(client, milestoneId, body);
  return { milestone: milestoneDetails(milestone) };
});

registerTool('milestone_summarize', {
  title: 'Summarize a Taskara milestone',
  description: 'Summarize a milestone using server-derived progress and its current executable work.',
  inputSchema: {
    milestoneId: z.string().uuid(),
    taskLimit: z.number().int().min(1).max(200).default(100)
  }
}, async ({ milestoneId, taskLimit }) => {
  const [milestone, tasksResult] = await Promise.all([
    api.getMilestone(client, milestoneId),
    api.listTasks(client, { milestoneId, limit: taskLimit })
  ]);
  const openTasks = tasksResult.items.filter(isUnfinished);
  return {
    milestone: milestoneDetails(milestone),
    counts: {
      ...milestone.progress,
      byStatus: countBy(tasksResult.items, (task) => task.status),
      returnedTasks: tasksResult.items.length,
      allAssignedTasks: tasksResult.total
    },
    blocked: openTasks.filter((task) => task.status === 'BLOCKED').map(taskSummary),
    overdue: openTasks.filter(isOverdue).map(taskSummary),
    suggestedNext: rankTasks(openTasks).slice(0, 8).map(taskSummary)
  };
});

/* ------------------------------------------------------------------- task */

registerTool('task_search', {
  title: 'Search Taskara tasks',
  description:
    'Search and filter tasks. Carries the whole query vocabulary, so the agent frontier — the unfinished, '
    + 'unassigned, unblocked children of one effort — is: parentId=<effort>, status=unfinished, '
    + 'assigneeId=none, blockers=none, sort=createdAt:asc.',
  inputSchema: {
    query: z.string().max(200).optional(),
    projectId: z.string().uuid().optional(),
    parentId: z.union([z.string().uuid(), z.literal('none')]).optional(),
    assigneeId: z.union([z.string().uuid(), z.literal('none')]).optional(),
    milestoneId: z.union([z.string().uuid(), z.literal('none')]).optional(),
    kind: taskKindSchema.optional().describe('Omitted lists work only; EFFORT lists maps'),
    status: z.string().max(120).optional().describe('A status, a comma-separated list, or "unfinished"'),
    priority: taskPrioritySchema.optional(),
    label: z.string().max(80).optional().describe('A label name, or "none" for unlabelled'),
    blockers: z.enum(['none', 'any']).optional().describe('Whether the task has an OPEN blocker'),
    sort: z.enum([
      'createdAt:asc', 'createdAt:desc',
      'updatedAt:asc', 'updatedAt:desc',
      'dueAt:asc', 'dueAt:desc'
    ]).optional(),
    mine: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0)
  }
}, async (input) => {
  const result = await api.listTasks(client, dropUndefined({
    q: input.query,
    projectId: input.projectId,
    parentId: input.parentId,
    assigneeId: input.assigneeId,
    milestoneId: input.milestoneId,
    kind: input.kind,
    status: input.status,
    priority: input.priority,
    label: input.label,
    blockers: input.blockers,
    sort: input.sort,
    mine: input.mine || undefined,
    limit: input.limit,
    offset: input.offset
  }));
  return { total: result.total, tasks: result.items.map(taskSummary) };
});

registerTool('task_list_mine', {
  title: 'List my Taskara tasks',
  description: 'List open or filtered tasks assigned to the configured Taskara identity.',
  inputSchema: {
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    limit: z.number().int().min(1).max(100).default(50)
  }
}, async (input) => {
  const result = await api.listTasks(client, dropUndefined({
    mine: true,
    status: input.status,
    priority: input.priority,
    limit: input.limit
  }));
  return { total: result.total, tasks: result.items.map(taskSummary) };
});

registerTool('task_view', {
  title: 'View a Taskara task',
  description: 'Get a task by UUID or task key, including comments, subtasks, and dependencies.',
  inputSchema: { task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123') }
}, async ({ task }) => {
  return { task: taskDetails(await api.getTask(client, task)) };
});

registerTool('task_create', {
  title: 'Create a Taskara task',
  description: 'Create a task, or an effort with kind=EFFORT. An effort is the root of a piece of work and holds no assignee, due date, weight, milestone or parent. '
    + 'An @-mention in the description notifies nobody — a mention is a rich-text node the web editor writes, and this tool sends markdown. Set an assignee to reach a person.',
  inputSchema: {
    projectId: z.string().uuid(),
    title: z.string().min(1).max(300),
    // The wider of the two ceilings, deliberately, and the server decides which one actually
    // applies. A client-side cap that is stricter than the server's refuses valid input before the
    // request is even sent -- which is exactly what the hardcoded 15000 here used to do to an
    // effort body, a map being the one description that needs the room.
    description: z.string().max(EFFORT_DESCRIPTION_MAX_CHARS).optional(),
    kind: taskKindSchema.default('WORK'),
    status: taskStatusSchema.default('TODO'),
    priority: taskPrioritySchema.default('NO_PRIORITY'),
    assigneeId: z.string().uuid().optional(),
    dueAt: z.string().datetime().optional(),
    labels: z.array(z.string().min(1).max(40)).max(12).default([]),
    parentId: z.string().uuid().optional(),
    cycleId: z.string().uuid().optional(),
    milestoneId: z.string().uuid().optional()
  }
}, async (input) => {
  return withMentionNotice({ task: taskSummary(await api.createTask(client, input)) }, input.description);
});

registerTool('task_edit', {
  title: 'Edit a Taskara task',
  description:
    'Update a task by UUID or key. Prefer addLabels/removeLabels over labels: labels replaces the whole '
    + 'set and loses a concurrent edit, while the add and remove are applied server-side and commute. '
    + 'A description is a whole-body rewrite and cannot commute, so pass baseVersion — the version that '
    + 'came with the body you edited — and the server refuses the write instead of overwriting someone '
    + 'else. Rewriting an Effort body without it is rejected. An @-mention in the description notifies '
    + 'nobody: a mention is a rich-text node the web editor writes, and this tool sends markdown.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    title: z.string().min(1).max(300).optional(),
    // As in task_create: the permissive ceiling client-side, the per-kind rule server-side. This
    // tool cannot know the target's kind without fetching it, so guessing narrow would refuse a
    // legitimate edit to a map body.
    description: z.string().max(EFFORT_DESCRIPTION_MAX_CHARS).nullable().optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    labels: z.array(z.string().min(1).max(40)).max(12).optional().describe('Replaces the whole set'),
    addLabels: z.array(z.string().min(1).max(40)).max(12).optional(),
    removeLabels: z.array(z.string().min(1).max(40)).max(12).optional(),
    parentId: z.string().uuid().nullable().optional(),
    cycleId: z.string().uuid().nullable().optional(),
    milestoneId: z.string().uuid().nullable().optional(),
    baseVersion: z.number().int().min(1).optional()
      .describe('The version of the task this edit is based on. 409 if the row has moved past it.')
  }
}, async ({ task, baseVersion, ...patch }) => {
  const body = dropUndefined(patch);
  // Counted apart from the fields: `baseVersion` states what the write is applied against, so a
  // request carrying only it asks for nothing and must not report success.
  if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update.');
  const updated = await api.updateTask(client, task, baseVersion === undefined ? body : { ...body, baseVersion });
  return withMentionNotice({ task: taskSummary(updated) }, patch.description);
});

registerTool('task_claim', {
  title: 'Claim a Taskara task',
  description:
    'Take a task only if nobody holds it. Fails, and names the holder, when it is already claimed. '
    + 'Use this rather than setting assigneeId when several agents may be working the same effort.',
  inputSchema: { task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123') }
}, async ({ task }) => {
  const outcome = await api.claimTask(client, task);
  if (!outcome.claimed) {
    throw new Error(`${outcome.task.key} is already claimed by ${outcome.heldBy?.name ?? 'someone else'}`);
  }
  return { task: taskSummary(outcome.task) };
});

registerTool('task_set_milestone', {
  title: 'Set a Taskara task milestone',
  description: 'Assign, move, or unassign one task. The API enforces same-project scope and rejects archived or terminal milestone targets.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    milestoneId: z.string().uuid().nullable().describe('Open milestone UUID, or null to unassign')
  }
}, async ({ task, milestoneId }) => {
  return { task: taskSummary(await api.updateTask(client, task, { milestoneId })) };
});

registerTool('task_comment', {
  title: 'Comment on a Taskara task',
  description: 'Add a comment to a Taskara task by UUID or key. The task\'s subscribers are notified; '
    + 'an @-mention in the comment reaches nobody in addition to them, from any client.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    body: z.string().min(1).max(15000)
  }
}, async ({ task, body }) => {
  return withMentionNotice({ comment: await api.commentOnTask(client, task, body) }, body);
});

registerTool('task_attach', {
  title: 'Attach a file to a Taskara task',
  description: 'Upload a local file and attach it to a Taskara task by UUID or key.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    filePath: z.string().min(1).describe('Absolute or relative path to a local file'),
    name: z.string().min(1).max(300).optional().describe('Display name to store for the attachment')
  }
}, async ({ task, filePath, name }) => {
  return { attachment: await api.uploadTaskAttachment(client, task, filePath, name) };
});

registerTool('task_propose', {
  title: 'Propose Taskara tasks from text',
  description: 'Convert a discussion, plan, or Mattermost thread into proposed Taskara task actions. Does not create tasks until actions are applied.',
  inputSchema: {
    text: z.string().min(1).max(60000),
    projectId: z.string().uuid().optional(),
    sourceTitle: z.string().max(300).optional(),
    sourceUrl: z.string().url().optional()
  }
}, async (input) => {
  return { agentRun: await api.proposeTasksFromText(client, input) };
});

/* --------------------------------------------------- agent runs and plans */

registerTool('agent_action_apply', {
  title: 'Apply a Taskara agent action',
  description: 'Apply a proposed Taskara agent action, such as creating a task from a thread proposal.',
  inputSchema: { actionId: z.string().uuid() }
}, async ({ actionId }) => api.applyAgentAction(client, actionId));

registerTool('plan_daily', {
  title: 'Generate a Taskara daily plan',
  description: "Generate today's focus list for the configured Taskara identity.",
  inputSchema: {}
}, async () => api.generateDailyPlan(client));

registerTool('plan_work', {
  title: 'Plan Taskara work',
  description: 'Rank open work by priority, due date, and blocker status for a project or the current identity.',
  inputSchema: {
    projectId: z.string().uuid().optional(),
    mine: z.boolean().default(false),
    maxTasks: z.number().int().min(1).max(25).default(8)
  }
}, async ({ projectId, mine, maxTasks }) => {
  const result = await api.listTasks(client, dropUndefined({ projectId, mine: mine || undefined, limit: 100 }));
  const openTasks = result.items.filter(isUnfinished);
  return {
    totalOpen: openTasks.length,
    focus: rankTasks(openTasks).slice(0, maxTasks).map(taskSummary),
    blocked: openTasks
      .filter((task) => task.status === 'BLOCKED' || (task._count?.blockingDependencies ?? 0) > 0)
      .map(taskSummary)
  };
});

registerTool('backlog_triage', {
  title: 'Triage the Taskara backlog',
  description: 'Review backlog tasks and produce deterministic triage suggestions for priority, labels, and next action.',
  inputSchema: {
    projectId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).default(40)
  }
}, async ({ projectId, limit }) => {
  const result = await api.listTasks(client, dropUndefined({ projectId, status: 'BACKLOG', limit }));
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

registerTool('blocker_detect', {
  title: 'Detect Taskara blockers',
  description: 'Find tasks with an open blocking dependency, and tasks a person has marked BLOCKED. These are different things in Taskara.',
  inputSchema: {
    projectId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).default(50)
  }
}, async ({ projectId, limit }) => {
  const [statusBlocked, dependencyBlocked] = await Promise.all([
    api.listTasks(client, dropUndefined({ projectId, status: 'BLOCKED', limit })),
    // The server-side predicate, which asks whether a blocker is still unfinished. Counting edges
    // client-side — what this tool used to do — calls a task blocked by a DONE blocker.
    api.listTasks(client, dropUndefined({ projectId, blockers: 'any' as const, status: 'unfinished', limit }))
  ]);
  return {
    statusBlocked: statusBlocked.items.map(taskSummary),
    dependencyBlocked: dependencyBlocked.items.map(taskSummary),
    total: new Set([...statusBlocked.items, ...dependencyBlocked.items].map((task) => task.id)).size
  };
});

/* ---------------------------------------------------------------- reports */

registerTool('report_daily_draft', {
  title: 'Get a Taskara daily report draft',
  description: "Fetch prefill material for today's daily report: completed/unexpected/plan candidates from real activity, plus yesterday's plan.",
  inputSchema: { dateKey: z.string().optional() }
}, async ({ dateKey }) => api.getDailyReportDraft(client, dateKey));

registerTool('report_daily_submit', {
  title: 'Submit a Taskara daily report',
  description: "File or update the configured identity's daily report for the current day. Draft the text with report_daily_draft and confirm it with the human before calling this.",
  inputSchema: {
    completedText: z.string().optional(),
    unplannedText: z.string().optional(),
    planText: z.string().optional(),
    blockersText: z.string().optional(),
    helpText: z.string().optional()
  }
}, async (input) => api.submitDailyReport(client, input));

registerTool('report_weekly', {
  title: 'Generate a Taskara weekly report',
  description: 'Generate a weekly status report from project/task state and recent activity.',
  inputSchema: { projectId: z.string().uuid().optional() }
}, async ({ projectId }) => {
  const [tasksResult, activity] = await Promise.all([
    api.listTasks(client, dropUndefined({ projectId, limit: 100 })),
    api.listActivity(client)
  ]);
  const tasks = tasksResult.items;
  const done = tasks.filter((task) => task.status === 'DONE');
  const open = tasks.filter(isUnfinished);
  return {
    scope: projectId ? { projectId } : { workspace: config.workspaceSlug },
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
});

/* ------------------------------------------------------------------ users */

// The description used to say "Admin-only … not reachable with an agent credential", and it was
// simply wrong: `GET /users` goes through `getRequestActor`, not `requireWorkspaceAdmin`, so any
// member reads it and always could. Its two neighbours below are genuinely admin-only, which is how
// the mistake spread across all three. A tool that understates its own reach is a tool a caller
// routes around.
registerTool('user_list', {
  title: 'List Taskara users',
  description:
    'List the members of the current workspace, agents included and marked by `kind`. Readable by '
    + 'any member, including an agent credential. This is how you find the id or email of somebody '
    + 'who holds no task. A name is not an identifier — `User.name` has no unique constraint.',
  inputSchema: {
    query: z.string().max(200).optional(),
    kind: userKindSchema.optional(),
    role: workspaceRoleSchema.optional(),
    limit: z.number().int().min(1).max(200).default(100)
  }
}, async ({ query, kind, role, limit }) => api.listUsers(client, dropUndefined({ q: query, kind, role, limit })));

registerTool('user_create', {
  title: 'Create a Taskara user',
  description: 'Admin-only: create or update a user and add them to the current workspace. Not reachable with an agent credential.',
  inputSchema: {
    email: z.string().email().max(254),
    name: z.string().min(1).max(160),
    role: workspaceRoleSchema.default('MEMBER'),
    mattermostUsername: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/).optional(),
    avatarUrl: z.string().url().optional()
  }
}, async (input) => ({ user: await api.createUser(client, input) }));

registerTool('user_set_role', {
  title: 'Set a Taskara user role',
  description: 'Admin-only: change a workspace user role. The API prevents demoting the last owner. Not reachable with an agent credential.',
  inputSchema: {
    userId: z.string().uuid(),
    role: workspaceRoleSchema
  }
}, async ({ userId, role }) => ({ user: await api.updateUserRole(client, userId, role) }));

/* ------------------------------------------------------------------ plumbing */

function registerTool<T extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: T },
  handler: (input: z.output<z.ZodObject<T>>) => Promise<unknown>
): void {
  server.registerTool(name, config as never, async (input: unknown) => {
    try {
      return jsonResult(await handler(input as z.output<z.ZodObject<T>>));
    } catch (error) {
      return errorResult(error);
    }
  });
}

/**
 * The result, plus the one thing a body full of names did not do.
 *
 * The same rule the CLI prints to stderr, carried where a conversation can see it. A tool
 * description says it before the call and this says it after, because a model that has already
 * written `@Robin please look` needs to be told that Robin was not told.
 *
 * The pointer names uuid rather than email: MCP's `assigneeId` is a uuid by #49's decision, since a
 * conversation holds state and has just called `user_list` while a shell caller has nowhere to keep
 * a resolved id between invocations.
 */
function withMentionNotice<T extends JsonRecord>(result: T, body: string | null | undefined): T {
  const notice = mentionNotice(
    body,
    'Hand work over with task_edit assigneeId; user_list finds the person and their id.'
  );
  return notice ? { ...result, warning: notice } : result;
}

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: makeStructuredContent(data)
  };
}

function errorResult(error: unknown): CallToolResult {
  // The exit code the core computed is dropped here on purpose: a conversation has no exit status,
  // and a number in the text is noise a model has to learn to ignore. The message carries the cause.
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true
  };
}

function makeStructuredContent(data: unknown): JsonRecord {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as JsonRecord;
  return { result: data };
}

const transport = new StdioServerTransport();
await server.connect(transport);
