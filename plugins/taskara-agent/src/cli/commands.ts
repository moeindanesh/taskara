import { taskKinds, taskPriorities, taskStatuses } from '@taskara/shared';
import type { TaskaraClient } from '../core/client';
import { TaskaraError, usageError } from '../core/errors';
import {
  addTaskBlocker,
  claimTask,
  commentOnTask,
  createTask,
  getTask,
  listTasks,
  removeTaskBlocker,
  resolveTaskId,
  updateTask,
  type CreateTaskInput,
  type TaskListFilters,
  type UpdateTaskInput
} from '../core/operations';
import type { Task } from '../core/types';
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
  close: taskClose
};

const nouns: Record<string, Record<string, Handler>> = {
  task: taskVerbs
};

export const usage = `taskara <noun> <verb> [arguments]

  task create   --project <id> --title <s> [--body <s> | --body-file <path|->]
                [--kind WORK|EFFORT] [--parent <key|id>] [--status S] [--priority P]
                [--label a,b] [--assignee <id>] [--due-at <iso>] [--milestone <id>] [--weight n]
  task view     <key|id> [--comments]
  task list     [--parent <key|id|none>] [--status unfinished|S,S] [--assignee <id>|none|me]
                [--blockers none|any] [--label <name>|none] [--project <id>] [--kind WORK|EFFORT]
                [--sort createdAt:asc] [--query <s>] [--team <slug>] [--limit n] [--offset n]
  task edit     <key|id> [--add-label L] [--remove-label L] [--add-blocker K] [--remove-blocker K]
                [--add-assignee <id>] [--title <s>] [--body <s> | --body-file <path|->]
                [--status S] [--priority P] [--due-at <iso>] [--milestone <id>] [--weight n]
                [--base-version n]   the version you read; 409/exit 5 if the row has moved past it.
                                     Required when rewriting an Effort's body.
  task claim    <key|id>
  task comment  <key|id> [--body <s> | --body-file <path|->]
  task close    <key|id> [--reason completed|canceled]

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
  const input: CreateTaskInput = {
    projectId: flags.require('project'),
    title: flags.require('title'),
    description: await readBody(flags),
    kind: flags.oneOf('kind', taskKinds),
    status: flags.oneOf('status', taskStatuses),
    priority: flags.oneOf('priority', taskPriorities),
    assigneeId: flags.get('assignee'),
    dueAt: flags.get('due-at'),
    milestoneId: flags.get('milestone'),
    weight: flags.number('weight'),
    labels: optionalList(splitValues(flags.all('label')))
  };

  const parent = flags.get('parent');
  if (parent) input.parentId = await resolveTaskId(client, parent);

  flags.assertNoUnknown();
  const task = await createTask(client, dropUndefined(input));
  return { data: taskSummary(task), note: `Created ${task.key}` };
}

async function taskView(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task view');
  const withComments = flags.bool('comments');
  flags.assertNoUnknown();

  const task = await getTask(client, key);
  return { data: withComments ? taskDetails(task) : taskSummary(task) };
}

async function taskList(client: TaskaraClient, flags: Flags): Promise<CommandResult> {
  const filters: TaskListFilters = {
    projectId: flags.get('project'),
    status: flags.get('status'),
    priority: flags.oneOf('priority', taskPriorities),
    kind: flags.oneOf('kind', taskKinds),
    label: flags.get('label'),
    blockers: flags.oneOf('blockers', ['none', 'any'] as const),
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
  // ask when the caller is a credential that never learned its own user id.
  const assignee = flags.get('assignee');
  if (assignee === 'me') filters.mine = true;
  else if (assignee) filters.assigneeId = assignee;

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

  const patch: UpdateTaskInput = {
    title: flags.get('title'),
    description: await readBody(flags),
    status: flags.oneOf('status', taskStatuses),
    priority: flags.oneOf('priority', taskPriorities),
    dueAt: flags.get('due-at'),
    milestoneId: flags.get('milestone'),
    weight: flags.number('weight'),
    // Taskara holds at most one assignee, so this sets rather than appends. The flag keeps `gh`'s
    // name because the docs are read in two columns; the semantics are Taskara's, and `task claim`
    // is the verb for taking unheld work.
    assigneeId: flags.get('add-assignee'),
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
  return { data: taskSummary(task), note: `Updated ${task.key}` };
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
  return { data: comment, note: `Commented on ${key}` };
}

const closeReasons = { completed: 'DONE', canceled: 'CANCELED' } as const;

async function taskClose(client: TaskaraClient, flags: Flags, positionals: string[]): Promise<CommandResult> {
  const key = requireTaskRef(positionals, 'task close');
  const reason = flags.oneOf('reason', Object.keys(closeReasons) as Array<keyof typeof closeReasons>) ?? 'completed';
  flags.assertNoUnknown();

  const task = await updateTask(client, key, { status: closeReasons[reason] });
  return { data: taskSummary(task), note: `Closed ${task.key} as ${reason}` };
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

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
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
    blockers: task.blockingDependencies?.map((dependency) => dependency.blockedByTask.key)
      ?? task._count?.blockingDependencies
      ?? 0,
    comments: task._count?.comments ?? task.comments?.length ?? 0
  };
}

export function taskDetails(task: Task): Record<string, unknown> {
  return {
    ...taskSummary(task),
    description: task.description ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    subtasks: task.subtasks?.map((subtask) => ({ key: subtask.key, title: subtask.title, status: subtask.status })) ?? [],
    commentThread: task.comments?.map((comment) => ({
      body: comment.body,
      createdAt: comment.createdAt,
      author: comment.author?.name ?? null
    })) ?? []
  };
}
