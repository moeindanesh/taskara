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
  taskSubscriptionFilterSchema,
  userKindSchema,
  workspaceRoleSchema
} from '@taskara/shared';
import { z } from 'zod';
import { TaskaraClient } from './core/client';
import { readConfig } from './core/config';
import { lineBreakNotice, readInlineBody, type InlineBody } from './core/line-breaks';
import { mentionNotice, type MentionedBody } from './core/mentions';
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
  const description = inlineBody(input.description);
  const project = await api.createProject(client, description ? { ...input, description: description.text } : input);
  // No mention notice: a project body addresses nobody, so `withBodyNotices` would be answering a
  // question this write does not raise.
  const notice = lineBreakNotice(description, LINE_BREAK_REACH);
  return notice ? { project: projectSummary(project), warning: notice } : { project: projectSummary(project) };
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
  const description = inlineBody(input.description);
  const milestone = await api.createMilestone(client, description ? { ...input, description: description.text } : input);
  const notice = lineBreakNotice(description, LINE_BREAK_REACH);
  return notice ? { milestone: milestoneDetails(milestone), warning: notice } : { milestone: milestoneDetails(milestone) };
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
  // As in `task_edit`: a `null` clears the column and must not be read as a body.
  const description = inlineBody(patch.description);
  const body = dropUndefined(description ? { ...patch, description: description.text } : patch);
  if (Object.keys(body).every((key) => key === 'version')) {
    throw new Error('Provide at least one milestone field to update.');
  }
  const milestone = await api.updateMilestone(client, milestoneId, body);
  const notice = lineBreakNotice(description, LINE_BREAK_REACH);
  return notice ? { milestone: milestoneDetails(milestone), warning: notice } : { milestone: milestoneDetails(milestone) };
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
    subscription: taskSubscriptionFilterSchema.optional()
      .describe('The caller\'s own relationship: watching, or deliberately muted'),
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
    subscription: input.subscription,
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
  // MCP's own taskDetails already returns the body and the thread unconditionally — a conversational
  // reader wants both, and there is no flag to gate them behind. The CLI's copy is the one that had
  // to change.
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
  const description = inlineBody(input.description);
  const task = await api.createTask(client, description ? { ...input, description: description.text } : input);
  return withBodyNotices({ task: taskSummary(task) }, description, 'description');
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
  // Only when it is a body. A `null` here is the instruction to clear the column and has to survive
  // as one, so it goes through untouched rather than becoming an undefined the drop below removes.
  const description = inlineBody(patch.description);
  const body = dropUndefined(description ? { ...patch, description: description.text } : patch);
  // Counted apart from the fields: `baseVersion` states what the write is applied against, so a
  // request carrying only it asks for nothing and must not report success.
  if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update.');
  const updated = await api.updateTask(client, task, baseVersion === undefined ? body : { ...body, baseVersion });
  return withBodyNotices({ task: taskSummary(updated) }, description, 'description');
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

registerTool('task_subscribe', {
  title: 'Watch a Taskara task',
  description:
    'Start receiving notifications about a task, and withdraw any earlier decision not to. Not '
    + 'available to an agent credential: an agent has no inbox, so it is not an audience for '
    + 'notifications and finds work by querying the frontier instead.',
  inputSchema: { task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123') }
}, async ({ task }) => api.subscribeToTask(client, task));

registerTool('task_unsubscribe', {
  title: 'Stop watching a Taskara task',
  description:
    'Stop receiving notifications about a task. This sticks: being mentioned in it or assigned it '
    + 'again will not put you back on the list, which is what makes it different from deleting a '
    + 'row. Use task_subscribe to undo it, and task_search with subscription=muted to find what you '
    + 'have silenced.',
  inputSchema: { task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123') }
  // The state comes back from the server rather than being assumed here: an agent credential
  // records no decision and is answered `none`, and a hardcoded `muted` would contradict the next
  // task_search with subscription=muted.
}, async ({ task }) => ({ task, ...await api.unsubscribeFromTask(client, task) }));

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
    + 'an @-mention in the comment reaches nobody in addition to them, from any client — a mention is a '
    + 'rich-text node and nothing writes one into a comment, the web\'s comment box included. Do not ask '
    + 'a human to add the mention in the web; set an assignee to reach a person.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    body: z.string().min(1).max(15000)
  }
}, async ({ task, body }) => {
  const written = readInlineBody(body);
  return withBodyNotices({ comment: await api.commentOnTask(client, task, written.text) }, written, 'comment');
});

// Beside `task_comment`, the other tool that speaks to a person, and deliberately not beside
// `task_subscribe`/`task_unsubscribe`, which it must not be read as a member of.
//
// No `.default()` and no `.optional()` on `about`: a defaulted selector on a tool that reaches
// somebody's phone would let a model send one of the two messages without ever having chosen it.
// The names come from the core map rather than being retyped here, for the reason at the top of this
// file — a private copy of a vocabulary is a drift bug findable only by reading two files side by
// side.
registerTool('task_sms', {
  title: 'Text a Taskara task assignee',
  description:
    "Send the task's assignee a text message on their phone. The audience is the assignee and cannot "
    + 'be chosen, and the Persian wording is composed server-side from the task title, its priority '
    + 'and its URL plus your own name — no parameter carries your words, and anything you actually '
    + 'want to say belongs in task_comment, which reaches the subscribers and leaves a record. '
    + 'about=new-task says there is work waiting; about=follow-up asks them to update the status. '
    + 'This is not the in-app notification task_subscribe governs and does not obey one: somebody who '
    + 'muted the task still gets it, and it cannot be recalled. Confirm the task AND which of the two '
    + 'messages with the human before calling this, and do not chase the same task twice in a day. '
    + 'Fails when the task has no assignee, when the assignee has no phone number on file — both '
    + 'paths that create an agent User leave the number unset, so work handed to an agent teammate '
    + 'lands here — or when the workspace has no SMS sender configured.',
  inputSchema: {
    task: z.string().min(1).describe('Task UUID or key, e.g. CORE-123'),
    about: z.enum(api.taskSmsMessageNames).describe(
      'new-task: "you have a new task in Taskara". follow-up: "update the status of this task". '
      + "The sentences are the server's, and there is no third option."
    )
  }
  // The caller's input is echoed beside the server's answer, as `task_unsubscribe` does: the two
  // routes answer byte-identically, and `{sent, receptor}` alone cannot say which task or which
  // sentence a conversation is now looking at.
}, async ({ task, about }) => ({ task, about, ...await api.taskSmsMessages[about](client, task) }));

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
 * A body a conversation wrote, read the way this toolkit reads every inline body.
 *
 * There is no `--body-file` here, so every body MCP receives is inline by construction and there is
 * nothing to decide. `null` is not a body — on `task_edit` it is the instruction to clear the
 * column — so it comes back undefined and the caller keeps the null it was handed.
 */
function inlineBody(text: string | null | undefined): InlineBody | undefined {
  return typeof text === 'string' ? readInlineBody(text) : undefined;
}

/** The way out on a surface with no file route to point at: the field itself already carries one. */
const LINE_BREAK_REACH = 'This field carries real line breaks; write one rather than escaping it.';

/**
 * The result, plus what the write did other than what it was asked.
 *
 * The same rules the CLI prints to stderr, carried where a conversation can see them. A tool
 * description says them before the call and this says them after, because a model that has already
 * written `@Robin please look` needs to be told that Robin was not told — and a model that escaped
 * its line breaks needs to be told that this field never needed it to.
 *
 * The mention pointer names uuid rather than email: MCP's `assigneeId` is a uuid by #49's decision,
 * since a conversation holds state and has just called `user_list` while a shell caller has nowhere
 * to keep a resolved id between invocations. The line-break pointer names no file route for the same
 * kind of reason — there is none on this surface, and telling a conversation about `--body-file -`
 * would send it looking for a flag it cannot reach.
 *
 * `into` is the body the tool wrote, because a description's mention has a writer to point at and a
 * comment's has none (#56) — and this is the shell where getting that wrong costs most, since a
 * model told «the web editor writes those» will helpfully suggest a human go and do it.
 */
function withBodyNotices<T extends JsonRecord>(
  result: T,
  body: InlineBody | undefined,
  into: MentionedBody
): T {
  const notices = [
    lineBreakNotice(body, LINE_BREAK_REACH),
    mentionNotice(
      body?.text,
      'Hand work over with task_edit assigneeId; user_list finds the person and their id.',
      into
    )
  ].filter(Boolean);

  return notices.length ? { ...result, warning: notices.join(' ') } : result;
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
