import {
  taskKinds,
  taskPriorities,
  taskStatuses,
  taskSubscriptionFilters,
  userKinds,
  workspaceRoles
} from '@taskara/shared';
import type { TaskaraClient } from '../core/client';
import { TaskaraError, usageError } from '../core/errors';
import { mentionNotice, type MentionedBody } from '../core/mentions';
import {
  addTaskBlocker,
  claimTask,
  commentOnTask,
  createProject,
  createTask,
  getTask,
  listProjects,
  listTasks,
  listUsers,
  removeTaskBlocker,
  resolveProjectId,
  resolveTaskId,
  resolveUserId,
  subscribeToTask,
  unsubscribeFromTask,
  updateTask,
  type CreateProjectInput,
  type CreateTaskInput,
  type TaskListFilters,
  type UpdateTaskInput,
  type UserListFilters
} from '../core/operations';
import { isRedactedTaskRef } from '../core/types';
import type { Project, Task, WorkspaceMember } from '../core/types';
import { Flags, parseArgs, readBody, splitValues } from './args';

export interface CommandResult {
  /** The JSON written to stdout. */
  data: unknown;
  /** A human line for stderr. Absent when the JSON says everything. */
  note?: string;
}

type Handler = (client: TaskaraClient, flags: Flags, positionals: string[]) => Promise<CommandResult>;

const taskVerbs: Record<string, Handler> = {
  create: taskCreate,
  view: taskView,
  list: taskList,
  edit: taskEdit,
  claim: taskClaim,
  comment: taskComment,
  close: taskClose,
  subscribe: taskSubscribe,
  unsubscribe: taskUnsubscribe
};

const projectVerbs: Record<string, Handler> = {
  list: projectList,
  create: projectCreate
};

/**
 * `list` and no more, and the omissions are the decision.
 *
 * `POST /users` and `PATCH /users/:id/role` both go through `requireWorkspaceAdmin`, which #29
 * taught to refuse **any** credential-authenticated request whatever role its agent holds. So a
 * `user create` verb on this surface could never succeed for the caller the surface exists for, and
 * #28 already settled what to do with a string like that: in a contract whose commands are pasted
 * verbatim, one that never works is worse than prose. MCP keeps both, because a human in
 * conversation may well be an admin.
 */
const userVerbs: Record<string, Handler> = {
  list: userList
};

const nouns: Record<string, Record<string, Handler>> = {
  task: taskVerbs,
  project: projectVerbs,
  user: userVerbs
};

export const usage = `taskara <noun> <verb> [arguments]

  login         [--api-url <url>] [--workspace <slug>] [--email <address>]

  task create   --project <keyPrefix|id> --title <s> [--body <s> | --body-file <path|->]
                [--kind WORK|EFFORT] [--parent <key|id>] [--status S] [--priority P]
                [--label a,b] [--assignee <id|email>] [--due-at <iso>] [--milestone <id>]
                [--weight n]
  task view     <key|id> [--comments]   # body always; --comments adds the thread
  task list     [--parent <key|id|none>] [--status unfinished|S,S]
                [--assignee <id|email>|none|me]
                [--blockers none|any] [--label <name>|none] [--kind WORK|EFFORT]
                [--subscription watching|muted]
                [--project <keyPrefix|id>] [--sort createdAt:asc] [--query <s>] [--team <slug>]
                [--limit n] [--offset n]
  task edit     <key|id> [--add-label L] [--remove-label L] [--add-blocker K] [--remove-blocker K]
                [--add-assignee <id|email>] [--title <s>] [--body <s> | --body-file <path|->]
                [--status S] [--priority P] [--due-at <iso>] [--milestone <id>] [--weight n]
                [--base-version n]
  task claim    <key|id>
  task comment  <key|id> [--body <s> | --body-file <path|->]
  task close    <key|id> [--reason completed|canceled]
  task subscribe   <key|id>
  task unsubscribe <key|id>

  project list   [--include-archived]
  project create --name <s> --key-prefix <CORE> [--body <s> | --body-file <path|->]
                 [--parent <keyPrefix|id>]

  user list     [--query <s>] [--kind HUMAN|AGENT] [--role R] [--limit n] [--offset n]

A person is addressed by id or by email — never by name, which carries no unique constraint.
"user list" is how you find either. Agents are in the roster too, marked by their kind.

An @-mention in a body reaches nobody. A mention is a rich-text node and every body sent from here
is markdown, so address a person with a flag, not in prose. The web editor writes those nodes into a
description; nothing writes one into a comment, whose box in the web is plain text too — so a
comment mention has no writer in any client. A body that looks like it tried is written as given,
with a line on stderr naming who was not told.

"task unsubscribe" sticks: being mentioned or assigned again will not put you back on the list.
"task subscribe" is how you undo it. Find either set with "task list --subscription watching|muted".
An agent may unsubscribe — it changes nothing, since agents receive no notifications — but may not
subscribe, and is told so rather than quietly succeeding.

--base-version is the version that came back with the body you edited. A write the row has already
moved past exits 5 instead of overwriting it, and the current row comes back on stdout. Required to
rewrite an Effort's body, which several sessions append to at once.

Exit codes: 0 ok, 1 usage, 2 config, 3 auth, 4 not found, 5 conflict, 6 rejected,
            7 server error, 8 unreachable.`;

export async function runCommand(client: TaskaraClient, argv: string[]): Promise<CommandResult> {
  const [noun, verb, ...rest] = argv;
  if (!noun) throw usageError(usage);

  const verbs = nouns[noun];
  if (!verbs) throw usageError(`Unknown noun "${noun}". Nouns: ${Object.keys(nouns).join(', ')}\n\n${usage}`);

  if (!verb) throw usageError(`"${noun}" needs a verb. Verbs: ${Object.keys(verbs).join(', ')}`);
  const handler = verbs[verb];
  if (!handler) {
    throw usageError(`Unknown verb "${noun} ${verb}". Verbs: ${Object.keys(verbs).join(', ')}`);
  }

  const parsed = parseArgs(rest);
  const flags = new Flags(parsed);
  const result = await handler(client, flags, parsed.positionals);
  return result;
}

async function taskCreate(client: TaskaraClient, flags: Flags): Promise<CommandResult> {
  const body = await readBody(flags);
  const input: CreateTaskInput = {
    projectId: await resolveProjectId(client, flags.require('project')),
    title: flags.require('title'),
    description: body,
    kind: flags.oneOf('kind', taskKinds),
    status: flags.oneOf('status', taskStatuses),
    priority: flags.oneOf('priority', taskPriorities),
    assigneeId: await optionalUserId(client, flags.get('assignee')),
    dueAt: flags.get('due-at'),
    milestoneId: flags.get('milestone'),
    weight: flags.number('weight'),
    labels: optionalList(splitValues(flags.all('label')))
  };

  const parent = flags.get('parent');
  if (parent) input.parentId = await resolveTaskId(client, parent);

  flags.assertNoUnknown();
  const task = await createTask(client, dropUndefined(input));
  return { data: taskSummary(task), note: noted(`Created ${task.key}`, body, 'description') };
}

async function taskView(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task view');
  const withComments = flags.bool('comments');
  flags.assertNoUnknown();

  const task = await getTask(client, key);
  // The body comes back either way. `--comments` used to be the only way to see a description,
  // which reads as a flag about the comment thread and is one — so reading a task meant asking for
  // something you did not want and hoping the thing you did want rode along. That cost a real
  // session an entire step during the map migration, on the one command whose whole job is "show me
  // this task".
  return { data: taskDetails(task, { withComments }) };
}

async function taskList(client: TaskaraClient, flags: Flags): Promise<CommandResult> {
  const project = flags.get('project');
  const filters: TaskListFilters = {
    projectId: project === undefined ? undefined : await resolveProjectId(client, project),
    status: flags.get('status'),
    priority: flags.oneOf('priority', taskPriorities),
    kind: flags.oneOf('kind', taskKinds),
    label: flags.get('label'),
    blockers: flags.oneOf('blockers', ['none', 'any'] as const),
    subscription: flags.oneOf('subscription', taskSubscriptionFilters),
    sort: flags.get('sort'),
    teamId: flags.get('team'),
    q: flags.get('query'),
    limit: flags.number('limit'),
    offset: flags.number('offset')
  };

  // `none` is the absence sentinel across every id filter (#21), so it must survive the key-to-uuid
  // resolution rather than being looked up as if it were a task.
  const parent = flags.get('parent');
  if (parent) filters.parentId = parent === 'none' ? 'none' : await resolveTaskId(client, parent);

  // `me` needs no id: the list endpoint already answers "mine" without one, which is the only way to
  // ask when the caller is a credential that never learned its own user id. `none` is #21's absence
  // sentinel and must reach the server as itself; both go past the resolver untouched.
  const assignee = flags.get('assignee');
  if (assignee === 'me') filters.mine = true;
  else if (assignee === 'none') filters.assigneeId = 'none';
  else if (assignee) filters.assigneeId = await resolveUserId(client, assignee);

  flags.assertNoUnknown();
  const result = await listTasks(client, dropUndefined(filters));
  return {
    data: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      tasks: result.items.map(taskSummary)
    }
  };
}

async function taskEdit(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task edit');

  const body = await readBody(flags);
  const patch: UpdateTaskInput = {
    title: flags.get('title'),
    description: body,
    status: flags.oneOf('status', taskStatuses),
    priority: flags.oneOf('priority', taskPriorities),
    dueAt: flags.get('due-at'),
    milestoneId: flags.get('milestone'),
    weight: flags.number('weight'),
    // Taskara holds at most one assignee, so this sets rather than appends. The flag keeps `gh`'s
    // name because the docs are read in two columns; the semantics are Taskara's, and `task claim`
    // is the verb for taking unheld work.
    assigneeId: await optionalUserId(client, flags.get('add-assignee')),
    addLabels: optionalList(splitValues(flags.all('add-label'))),
    removeLabels: optionalList(splitValues(flags.all('remove-label')))
  };

  const parent = flags.get('parent');
  if (parent) patch.parentId = parent === 'none' ? null : await resolveTaskId(client, parent);

  // Not a change — a condition the changes are applied under, so it is counted separately below.
  // Deliberately taken from the caller rather than fetched here: the version has to be the one that
  // came with the body the caller edited, and a version this command looked up at write time would
  // be fresher than that and would wave through exactly the stale write it exists to catch.
  const baseVersion = flags.number('base-version');

  const addBlockers = splitValues(flags.all('add-blocker'));
  const removeBlockers = splitValues(flags.all('remove-blocker'));
  flags.assertNoUnknown();

  const fields = dropUndefined(patch);
  if (Object.keys(fields).length === 0 && addBlockers.length === 0 && removeBlockers.length === 0) {
    throw usageError('task edit needs at least one change');
  }

  // Fields, then blockers. Blocker edges are separate rows on separate endpoints, so an edit that
  // touches both is not one atomic write — a failure part-way leaves the earlier half applied. Doing
  // the PATCH first means the reported task reflects every field change that succeeded.
  if (Object.keys(fields).length > 0) {
    await patchTask(client, key, baseVersion === undefined ? fields : { ...fields, baseVersion });
  }
  for (const blocker of removeBlockers) await removeTaskBlocker(client, key, blocker);
  for (const blocker of addBlockers) await addTaskBlocker(client, key, blocker);

  const task = await getTask(client, key);
  return { data: taskSummary(task), note: noted(`Updated ${task.key}`, body, 'description') };
}

async function taskClaim(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task claim');
  flags.assertNoUnknown();

  const outcome = await claimTask(client, key);
  if (outcome.claimed) {
    return { data: taskSummary(outcome.task), note: `Claimed ${outcome.task.key}` };
  }

  // Non-zero, and the holder is on stdout as well as in the message. A caller that reads this as
  // "close enough, it is mine" is the failure that produced two parallel implementations of #33, so
  // the exit code is the loud part and the name is the actionable part.
  const holder = outcome.heldBy?.name ?? 'someone else';
  throw new ClaimLostError(`${outcome.task.key} is already claimed by ${holder}`, taskSummary(outcome.task));
}

async function taskComment(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task comment');
  const body = await readBody(flags);
  flags.assertNoUnknown();
  if (!body?.trim()) throw usageError('task comment needs --body or --body-file');

  const comment = await commentOnTask(client, key, body);
  return { data: comment, note: noted(`Commented on ${key}`, body, 'comment') };
}

const closeReasons = { completed: 'DONE', canceled: 'CANCELED' } as const;

async function taskClose(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task close');
  const reason = flags.oneOf('reason', Object.keys(closeReasons) as Array<keyof typeof closeReasons>) ?? 'completed';
  flags.assertNoUnknown();

  const task = await updateTask(client, key, { status: closeReasons[reason] });
  return { data: taskSummary(task), note: `Closed ${task.key} as ${reason}` };
}

/**
 * Watching a task, and deliberately not watching it.
 *
 * Two verbs rather than `task edit --watch true|false`, because this is the caller's own
 * relationship to the task and not a field on the shared row: two people hold different answers at
 * the same moment, and `task edit` writes what everybody sees.
 *
 * `unsubscribe` **sticks**. It is not "remove my row" but "I have decided not to watch this", and
 * the next mention or assignment will not undo it — otherwise it would be a verb that reports
 * success and stops working an hour later. `subscribe` is the withdrawal of that decision.
 */
async function taskSubscribe(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task subscribe');
  flags.assertNoUnknown();

  const result = await subscribeToTask(client, key);
  return { data: result, note: `Watching ${key}` };
}

async function taskUnsubscribe(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task unsubscribe');
  flags.assertNoUnknown();

  // Relayed, never assumed. Under an agent credential the server records no decision and answers
  // `none`; printing a hardcoded `muted` would be this surface claiming something it did not do,
  // and the very next `task list --subscription muted` would disagree with it.
  const result = await unsubscribeFromTask(client, key);
  return { data: result, note: `No longer watching ${key}` };
}

/**
 * The read that breaks the bootstrap circle.
 *
 * `task create --project` needs a project, and before this verb the only shell-side source of one
 * was an existing Task's `project.id` — so an agent needed a project to create a task and a task to
 * learn a project, and an empty workspace could not be started from a shell at all.
 */
async function projectList(client: TaskaraClient, flags: Flags): Promise<CommandResult> {
  const includeArchived = flags.bool('include-archived');
  flags.assertNoUnknown();

  const projects = await listProjects(client);
  const items = includeArchived ? projects : projects.filter((project) => project.status !== 'ARCHIVED');
  return { data: { total: items.length, projects: items.map(projectSummary) } };
}

/**
 * The write that breaks it in a workspace holding no project either.
 *
 * `--team` and `--lead` are deliberately absent. `createProjectSchema.teamId` is a uuid while
 * `task list --team` takes a **slug**, and one flag name meaning two different things across two
 * commands of one grammar is the drift #25 was written to stop. A project created without a team is
 * visible workspace-wide, which is the right default for an agent bootstrapping one; MCP's
 * `project_create` still carries both for a human in conversation who holds the ids.
 */
async function projectCreate(client: TaskaraClient, flags: Flags): Promise<CommandResult> {
  const input: CreateProjectInput = {
    name: flags.require('name'),
    // Sent as written. `createProjectSchema` trims and uppercases it, so `--key-prefix core` and
    // `--key-prefix CORE` are already the same request and a second normalisation here would only
    // be a copy of the server's rule that could drift from it.
    keyPrefix: flags.require('key-prefix'),
    description: await readBody(flags)
  };

  const parent = flags.get('parent');
  if (parent) input.parentId = await resolveProjectId(client, parent);

  flags.assertNoUnknown();
  const project = await createProject(client, dropUndefined(input));
  return { data: projectSummary(project), note: `Created project ${project.keyPrefix}` };
}

/**
 * The read that makes a person addressable.
 *
 * `--assignee` takes a UUID, and a user UUID appears in no key, no URL and no prose — the only place
 * the shell surfaced one was beside an assignee on a Task that person already holds. So handing work
 * to somebody who holds none was the one case with no handle at all, which is the same shape of hole
 * `project list` closed for projects, one noun over.
 *
 * It answers about **everyone**, agents included. #37 drew the line between visibility and
 * measurement: `measuredMemberWhere` keeps agents out of metrics that judge humans and out of
 * nothing else, so filtering them out here would quietly re-merge the two.
 */
async function userList(client: TaskaraClient, flags: Flags): Promise<CommandResult> {
  const filters: UserListFilters = {
    q: flags.get('query'),
    kind: flags.oneOf('kind', userKinds),
    role: flags.oneOf('role', workspaceRoles),
    limit: flags.number('limit'),
    offset: flags.number('offset')
  };
  flags.assertNoUnknown();

  const roster = await listUsers(client, dropUndefined(filters));
  return {
    data: {
      total: roster.total,
      limit: roster.limit,
      offset: roster.offset,
      // Always a list with a count, never a single resolved person, and deliberately so: `--query`
      // matches a name, a name is not unique, and a shape that could return one answer would invite
      // a caller to read `.users[0].id` as if it were.
      users: roster.items.map(userSummary)
    }
  };
}

/** A lost claim: a failure with a payload, because the holder is the point of the failure. */
export class ClaimLostError extends Error {
  constructor(message: string, readonly task: unknown) {
    super(message);
    this.name = 'ClaimLostError';
  }
}

/**
 * A refused write: the row moved past the version this edit was based on.
 *
 * Like a lost claim, the payload is the point. The server has already read the current row in order
 * to notice the conflict and returns it in the 409, so the loser can re-apply its line to the body
 * it gets back and send it with the version it carries. Without this the caller would have to issue
 * a second read to learn what it already has, and "re-read and retry" would cost two round trips
 * instead of one.
 */
export class StaleWriteError extends Error {
  constructor(message: string, readonly task: unknown) {
    super(message);
    this.name = 'StaleWriteError';
  }
}

/** `updateTask`, with the 409 turned into a failure that carries the row to merge against. */
async function patchTask(client: TaskaraClient, key: string, patch: UpdateTaskInput): Promise<void> {
  try {
    await updateTask(client, key, patch);
  } catch (error) {
    if (error instanceof TaskaraError && error.status === 409 && isTaskLike(error.body)) {
      throw new StaleWriteError(error.message, taskDetails(error.body as Task));
    }
    throw error;
  }
}

function isTaskLike(body: unknown): boolean {
  return Boolean(body) && typeof body === 'object' && 'version' in (body as Record<string, unknown>);
}

function requireTaskRef(positionals: string[], command: string): string {
  const [key] = positionals;
  if (!key) throw usageError(`${command} needs a task key or id`);
  return key;
}

function optionalList(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
}

/**
 * `resolveUserId` for a flag that may be absent, on the two commands that *write* an assignee.
 *
 * Neither of them takes `none` or `me`. `none` is a list filter, and clearing an assignee is not
 * something the tracker contract asks for; `me` cannot work on a write, because a credential never
 * learns its own user id — `resolveUserId` says so and points at `task claim`, which is the verb
 * for taking work yourself and is atomic besides.
 */
function optionalUserId(client: TaskaraClient, ref: string | undefined): Promise<string | undefined> {
  return ref === undefined ? Promise.resolve(undefined) : resolveUserId(client, ref);
}

/** How a shell caller actually reaches a person: an email on the flag, and the roster to find it. */
const MENTION_REACH = 'Hand work over with task edit --add-assignee <email>; taskara user list finds the address.';

/**
 * The outcome line, and the one thing the write did not do.
 *
 * A body that names people notifies none of them — a mention is a node, and this surface only ever
 * sends markdown (#53). The write still lands: the prose is what a human reads, and refusing to
 * store a sentence on the strength of a guess about it would leave the caller no way to write the
 * sentence at all. What it must not do is land in silence.
 *
 * `into` is the body being written, because the two do not have the same explanation — a
 * description's mention has a writer and a comment's has none (#56). See `MentionedBody`.
 */
function noted(outcome: string, body: string | undefined, into: MentionedBody): string {
  const notice = mentionNotice(body, MENTION_REACH, into);
  return notice ? `${outcome}\n${notice}` : outcome;
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function projectSummary(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    keyPrefix: project.keyPrefix,
    name: project.name,
    status: project.status,
    description: project.description ?? null,
    parentId: project.parentId ?? null,
    taskCount: project._count?.tasks ?? project.tasks?.length ?? 0,
    subprojectCount: project._count?.subprojects ?? project.subprojects?.length ?? 0
  };
}

/**
 * A roster row: what addressing a person needs, and nothing else.
 *
 * `GET /users` also returns a phone number, a Mattermost handle, an avatar URL and lifetime task
 * counts. None of it helps hand over work, and this is the one command whose entire output is other
 * people's details — so the shell prints the narrow thing. That is ergonomics, not a boundary: the
 * API still hands the caller the wider row, and narrowing it there is `GET /users`'s own question.
 *
 * `kind` and `operatorId` are the marking. An agent is a teammate and belongs in the list, but an
 * agent listed unmarked is an agent indistinguishable from the person above it — and `operatorId`
 * names the human it acts for, which is the part that makes the mark useful rather than merely
 * present. `role` is here because a GUEST is an outsider and that is worth seeing before assigning.
 */
export function userSummary(member: WorkspaceMember): Record<string, unknown> {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    kind: member.kind ?? 'HUMAN',
    operatorId: member.operatorId ?? null,
    role: member.role
  };
}

export function taskSummary(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    status: task.status,
    priority: task.priority,
    kind: task.kind ?? 'WORK',
    // On every read, not only the detailed one. A session that is about to rewrite a body needs the
    // version that came with it, and a caller that has to ask for the version separately is a caller
    // that will quote one taken at a different moment from the body it edited.
    version: task.version ?? null,
    dueAt: task.dueAt ?? null,
    project: task.project ? { id: task.project.id, keyPrefix: task.project.keyPrefix, name: task.project.name } : null,
    milestone: task.milestone
      ? { id: task.milestone.id, name: task.milestone.name, kind: task.milestone.kind, status: task.milestone.status }
      : null,
    assignee: task.assignee ? { id: task.assignee.id, name: task.assignee.name, email: task.assignee.email } : null,
    labels: task.labels?.map(({ label }) => label.name) ?? [],
    parentId: task.parentId ?? null,
    // `null` for a blocker behind a team wall (#58). The array's *length* is the count of things
    // in the way, so a hidden one has to occupy a slot — dropping it would report a blocked task
    // as free to the reader least able to check. There is no key to print, and inventing one
    // would be worse than a hole that reads as one.
    blockers: task.blockingDependencies?.map((dependency) =>
      isRedactedTaskRef(dependency.blockedByTask) ? null : dependency.blockedByTask.key
    )
      ?? task._count?.blockingDependencies
      ?? 0,
    comments: task._count?.comments ?? task.comments?.length ?? 0
  };
}

/**
 * A task as `task view` answers it.
 *
 * The description is unconditional. It is the field the command exists to show, and gating it
 * behind `--comments` made the one obvious read a two-guess affair.
 *
 * `commentThread` is what the flag actually buys, so it is the only thing the flag controls — and
 * it stays opt-in because a long thread is most of the payload and most callers are reading the
 * body, not the conversation.
 */
export function taskDetails(task: Task, options: { withComments?: boolean } = {}): Record<string, unknown> {
  return {
    ...taskSummary(task),
    description: task.description ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    subtasks: task.subtasks?.map((subtask) =>
      isRedactedTaskRef(subtask)
        ? { redacted: true, open: subtask.open }
        : { key: subtask.key, title: subtask.title, status: subtask.status }
    ) ?? [],
    ...(options.withComments
      ? {
          commentThread: task.comments?.map((comment) => ({
            body: comment.body,
            createdAt: comment.createdAt,
            author: comment.author?.name ?? null
          })) ?? []
        }
      : {})
  };
}
