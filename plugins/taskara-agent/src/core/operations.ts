import type {
  MilestoneHealthValue,
  MilestoneKindValue,
  MilestoneStatusValue,
  TaskKindValue,
  TaskPriorityValue,
  TaskStatusValue,
  TaskSubscriptionFilterValue,
  UserKindValue,
  WorkspaceRoleValue
} from '@taskara/shared';
import type { QueryValues, TaskaraClient } from './client';
import { TaskaraError, exitCodes } from './errors';
import type {
  JsonRecord,
  Milestone,
  MilestoneListResponse,
  Project,
  Task,
  TaskAttachment,
  TaskListResponse,
  UserListResponse
} from './types';

/**
 * One function per API operation. No presentation, no summarising, no ranking — those belong to a
 * shell, because the CLI renders for a pipe and MCP renders for a conversation and forcing them
 * together produces a CLI that prints MCP envelopes.
 */

export interface TaskListFilters {
  projectId?: string;
  parentId?: string;
  assigneeId?: string;
  milestoneId?: string;
  kind?: TaskKindValue;
  /** A status, a comma-separated list, or the derived value `unfinished`. */
  status?: string;
  priority?: TaskPriorityValue;
  label?: string;
  blockers?: 'none' | 'any';
  /** The caller's own relationship to the task: what they watch, or what they muted. */
  subscription?: TaskSubscriptionFilterValue;
  sort?: string;
  teamId?: string;
  q?: string;
  mine?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  kind?: TaskKindValue;
  status?: TaskStatusValue;
  priority?: TaskPriorityValue;
  assigneeId?: string;
  dueAt?: string;
  labels?: string[];
  parentId?: string;
  cycleId?: string;
  milestoneId?: string;
  weight?: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  status?: TaskStatusValue;
  priority?: TaskPriorityValue;
  assigneeId?: string | null;
  dueAt?: string | null;
  weight?: number | null;
  parentId?: string | null;
  cycleId?: string | null;
  milestoneId?: string | null;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  /**
   * The version this write is based on — not a field being changed, but the condition it is applied
   * under. The server answers 409 once the row has moved past it. **Required** when the patch
   * rewrites an Effort's description: that body is an index several sessions append a line to, and
   * a line lost from it is a decision the next session cannot find, in a ticket already closed.
   */
  baseVersion?: number;
}

/**
 * What the server says the caller's relationship to the task is now — its word, not the shell's.
 *
 * All three states, including `none`. An agent's unsubscribe records no decision, because #39 keeps
 * agents out of every fan-out and a mute for one would be a row with no reader; so the honest answer
 * there is `none`, and a shell that printed `muted` regardless would contradict the very next
 * `task list --subscription muted`.
 */
export interface TaskSubscriptionState {
  state: TaskSubscriptionFilterValue | 'none';
}

export interface ClaimOutcome {
  claimed: boolean;
  task: Task;
  /** Set when the claim was lost: who holds it, taken from the 409 body. */
  heldBy?: { id: string; name: string } | null;
}

export function listTasks(client: TaskaraClient, filters: TaskListFilters = {}): Promise<TaskListResponse> {
  return client.request<TaskListResponse>('/tasks', { query: filters as QueryValues });
}

export function getTask(client: TaskaraClient, idOrKey: string): Promise<Task> {
  return client.request<Task>(`/tasks/${encodeURIComponent(idOrKey)}`);
}

export function createTask(client: TaskaraClient, input: CreateTaskInput): Promise<Task> {
  // `source` is deliberately not sent. The old surface hardcoded `CODEX` on every create under every
  // runtime; omitting it lets the server apply its own default and keeps the surface out of the
  // business of describing itself. Provenance comes from the credential.
  return client.request<Task>('/tasks', { method: 'POST', body: input });
}

export function updateTask(client: TaskaraClient, idOrKey: string, patch: UpdateTaskInput): Promise<Task> {
  return client.request<Task>(`/tasks/${encodeURIComponent(idOrKey)}`, { method: 'PATCH', body: patch });
}

/**
 * Take a task, or find out who holds it.
 *
 * The 409 is not an error to propagate — it is the other half of the answer, and the caller needs
 * the holder out of it. Every other status still throws, so a 404 or an auth failure keeps its own
 * exit code rather than being flattened into "not claimed".
 */
export async function claimTask(client: TaskaraClient, idOrKey: string): Promise<ClaimOutcome> {
  try {
    const task = await client.request<Task>(`/tasks/${encodeURIComponent(idOrKey)}/claim`, {
      method: 'POST',
      body: {}
    });
    return { claimed: true, task };
  } catch (error) {
    if (error instanceof TaskaraError && error.status === 409 && isTaskBody(error.body)) {
      return { claimed: false, task: error.body, heldBy: error.body.assignee ?? null };
    }
    throw error;
  }
}

function isTaskBody(body: unknown): body is Task {
  return Boolean(body && typeof body === 'object' && 'key' in body && 'id' in body);
}

/**
 * Start watching a task, deliberately.
 *
 * Refused for an agent credential with a 400, because #39 settled that an agent is not an audience
 * for notifications. Not smoothed over here: the error names the reason, and a caller that meant to
 * find work should be querying the frontier instead.
 */
export function subscribeToTask(client: TaskaraClient, idOrKey: string): Promise<TaskSubscriptionState> {
  return client.request<TaskSubscriptionState>(`/tasks/${encodeURIComponent(idOrKey)}/subscription`, {
    method: 'POST',
    body: {}
  });
}

/**
 * Stop watching a task, and have that survive the next mention or assignment.
 *
 * Succeeds for an agent as well as a person — an agent tidying up after itself runs the same verb —
 * though for an agent there is nothing to keep quiet and the server records no decision.
 */
export function unsubscribeFromTask(client: TaskaraClient, idOrKey: string): Promise<TaskSubscriptionState> {
  return client.request<TaskSubscriptionState>(`/tasks/${encodeURIComponent(idOrKey)}/subscription`, {
    method: 'DELETE'
  });
}

/**
 * What the server says it handed the SMS provider.
 *
 * `sent` is always `true` — every failure is an HTTP status, never `sent: false` — so `receptor` is
 * the whole of the answer. It arrives already masked (`0912***456`), and it is evidence rather than
 * a handle: nothing on this surface takes a phone number, and the digits the mask removes are the
 * ones that would make it dialable. Its job is to let a human say "that is not Robin's".
 *
 * It is also the weakest true claim available. The server reports the provider *accepting* the
 * message and nothing downstream reports back, so neither shell may render this as "delivered".
 */
export interface TaskSmsReceipt {
  sent: true;
  receptor: string;
}

/**
 * Text the task's assignee that the work is theirs.
 *
 * Three things it deliberately does not take. **A recipient** — the assignee is the only audience
 * the route has, so a task holding none is refused rather than broadcast. **Any text** — the Persian
 * message is composed server-side from the title, the priority, the task URL and the caller's own
 * name, and a `message` parameter here would advertise a freedom that does not exist. **A task
 * uuid** — the route takes `:idOrKey` and resolves a key itself, as `getTask` does, so calling
 * `resolveTaskId` first would buy a round trip and nothing else.
 *
 * This is the one write on the surface that reaches somebody who decided not to be reached. A
 * subscription silences an inbox; this path reads no subscription and no mute, and #39's rule
 * keeping agents out of every fan-out governs notification rows, not phones.
 *
 * `body: {}` matches `claimTask` and `subscribeToTask`: `client.request` declares
 * `application/json` only when a body is present, and a POST arriving without one is at Fastify's
 * mercy. That refusal would come back as exit 6 and read exactly like the server's own "Task has no
 * assignee" — which is why the tests assert the message and not only the code.
 */
export function sendTaskCreatedSms(client: TaskaraClient, idOrKey: string): Promise<TaskSmsReceipt> {
  return client.request<TaskSmsReceipt>(`/tasks/${encodeURIComponent(idOrKey)}/sms/task-created`, {
    method: 'POST',
    body: {}
  });
}

/**
 * Text the task's assignee asking them to update its status.
 *
 * A second function rather than a parameter on the first, because these are two endpoints with two
 * templates and two audit actions: one function per API operation, and a private route table inside
 * one wrapper would typecheck for as long as it was wrong and then 404 in a way that reads like a
 * missing task. The two are one *verb* in both shells, which is the map below — a decision about a
 * grammar rather than about the API.
 */
export function sendTaskFollowUpSms(client: TaskaraClient, idOrKey: string): Promise<TaskSmsReceipt> {
  return client.request<TaskSmsReceipt>(`/tasks/${encodeURIComponent(idOrKey)}/sms/follow-up`, {
    method: 'POST',
    body: {}
  });
}

/**
 * The two messages, under the words a caller says.
 *
 * A caller-facing word mapped onto a server behaviour usually belongs to a shell — `closeReasons` is
 * `task close`'s alone, and can be, because MCP has no close tool. Both shells offer this one, so
 * keeping it here is the lesser evil: two copies would be two lists to hold in step, and
 * `mcp-server.ts` already records what that costs — a drift bug findable only by reading two files
 * side by side. It is dispatch, not presentation; how a receipt is *rendered* still belongs to each
 * shell.
 *
 * `new-task` renames the route's `task-created`, the way `closeReasons` renames `DONE`. The endpoint
 * checks a task, an assignee and a phone number and never how old the row is, so it works on a
 * ticket filed last month; `task-created` would promise a freshness rule that does not exist.
 * `new-task` is instead a literal reading of the sentence the assignee receives: «در تسکارا وظیفه
 * جدید داری».
 *
 * `handoff` was the runner-up and is out. `MENTION_REACH` already spends "hand work over" on
 * `--add-assignee`, so in this grammar the word means *assign* — and this command assigns nothing,
 * it texts somebody about an assignment made earlier, possibly by somebody else. One word meaning
 * two acts across one grammar is the drift #25 names.
 */
export const taskSmsMessages = {
  'new-task': sendTaskCreatedSms,
  'follow-up': sendTaskFollowUpSms
} as const;

export type TaskSmsMessage = keyof typeof taskSmsMessages;

/** The two message names, for the shells that have to offer them as a choice. */
export const taskSmsMessageNames = Object.keys(taskSmsMessages) as [TaskSmsMessage, ...TaskSmsMessage[]];

export function commentOnTask(client: TaskaraClient, idOrKey: string, body: string): Promise<JsonRecord> {
  return client.request<JsonRecord>(`/tasks/${encodeURIComponent(idOrKey)}/comments`, {
    method: 'POST',
    body: { body }
  });
}

export function addTaskBlocker(client: TaskaraClient, idOrKey: string, blockedBy: string): Promise<JsonRecord> {
  return client.request<JsonRecord>(`/tasks/${encodeURIComponent(idOrKey)}/dependencies`, {
    method: 'POST',
    body: { blockedBy }
  });
}

export function removeTaskBlocker(client: TaskaraClient, idOrKey: string, blockedBy: string): Promise<void> {
  return client.request<void>(
    `/tasks/${encodeURIComponent(idOrKey)}/dependencies/${encodeURIComponent(blockedBy)}`,
    { method: 'DELETE' }
  );
}

export function listTaskActivity(client: TaskaraClient, idOrKey: string): Promise<JsonRecord[]> {
  return client.request<JsonRecord[]>(`/tasks/${encodeURIComponent(idOrKey)}/activity`);
}

export async function uploadTaskAttachment(
  client: TaskaraClient,
  idOrKey: string,
  filePath: string,
  name?: string
): Promise<TaskAttachment> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new TaskaraError(`File not found: ${filePath}`, { exitCode: exitCodes.usage });
  }
  const form = new FormData();
  if (name) form.set('name', name);
  form.set('file', file, filePath.split('/').pop() ?? 'attachment');
  return client.requestForm<TaskAttachment>(`/tasks/${encodeURIComponent(idOrKey)}/attachments`, form);
}

/**
 * Resolve a task reference to a UUID.
 *
 * `parentId` and `assigneeId` take UUIDs, matching every other id filter, but an agent holds keys —
 * it reads `TKR-12` in its own prompt. #21 accepted that as a limit and expected callers to resolve
 * once per session; doing it here means no caller has to remember. Costs one GET when the caller
 * passes a key, and nothing when it already holds an id.
 */
export async function resolveTaskId(client: TaskaraClient, idOrKey: string): Promise<string> {
  if (isUuid(idOrKey)) return idOrKey;
  const task = await getTask(client, idOrKey);
  return task.id;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function listProjects(client: TaskaraClient): Promise<Project[]> {
  return client.request<Project[]>('/projects');
}

/**
 * Resolve a project reference to a UUID, accepting a key prefix as well as an id.
 *
 * The same argument that made `--parent` take a task key, one level up. `CORE` is the front half of
 * every key in the project, so an agent that has read `CORE-123` anywhere is already holding the
 * handle, while a project uuid appears in no key, no URL and no prose. The two can never be confused:
 * a key prefix matches `^[A-Z][A-Z0-9]*$` and every uuid contains the hyphen that forbids.
 *
 * `GET /projects/:id` takes only an id, so the lookup goes through the list — one request, the same
 * one `project list` makes, and none at all when the caller already holds an id.
 */
export async function resolveProjectId(client: TaskaraClient, idOrKeyPrefix: string): Promise<string> {
  if (isUuid(idOrKeyPrefix)) return idOrKeyPrefix;

  const wanted = idOrKeyPrefix.trim().toUpperCase();
  const projects = await listProjects(client);
  const match = projects.find((project) => project.keyPrefix.toUpperCase() === wanted);
  if (match) return match.id;

  // The recovery is one line away and this call already fetched it, so naming the prefixes that do
  // exist costs nothing and saves the caller a round trip through `project list` to learn what it
  // should have typed. No HTTP 404 happened here — the list succeeded — so no status is attached.
  const known = projects.map((project) => project.keyPrefix).sort();
  const shown = known.slice(0, 20).join(', ');
  const suffix = known.length === 0
    ? 'This workspace has no projects yet; create one with `taskara project create`.'
    : `Known prefixes: ${shown}${known.length > 20 ? `, and ${known.length - 20} more` : ''}.`;
  throw new TaskaraError(`No project with key prefix "${idOrKeyPrefix}". ${suffix}`, {
    exitCode: exitCodes.notFound
  });
}

export function getProject(client: TaskaraClient, projectId: string): Promise<Project> {
  return client.request<Project>(`/projects/${encodeURIComponent(projectId)}`);
}

export interface CreateProjectInput {
  name: string;
  keyPrefix: string;
  description?: string;
  parentId?: string;
  teamId?: string;
  leadId?: string;
}

export function createProject(client: TaskaraClient, input: CreateProjectInput): Promise<Project> {
  return client.request<Project>('/projects', { method: 'POST', body: input });
}

export interface MilestoneListFilters {
  q?: string;
  projectId?: string;
  teamId?: string;
  ownerId?: string;
  kind?: MilestoneKindValue;
  status?: string;
  health?: string;
  overdue?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export function listMilestones(
  client: TaskaraClient,
  filters: MilestoneListFilters = {}
): Promise<MilestoneListResponse> {
  return client.request<MilestoneListResponse>('/milestones', { query: filters as QueryValues });
}

export function getMilestone(client: TaskaraClient, milestoneId: string): Promise<Milestone> {
  return client.request<Milestone>(`/milestones/${encodeURIComponent(milestoneId)}`);
}

export interface CreateMilestoneInput {
  projectId: string;
  name: string;
  kind: MilestoneKindValue;
  status?: Extract<MilestoneStatusValue, 'PLANNED' | 'ACTIVE'>;
  ownerId?: string | null;
  description?: string | null;
  health?: MilestoneHealthValue | null;
  startsOn?: string | null;
  targetOn?: string | null;
}

export function createMilestone(client: TaskaraClient, input: CreateMilestoneInput): Promise<Milestone> {
  return client.request<Milestone>('/milestones', { method: 'POST', body: input });
}

export interface UpdateMilestoneInput {
  version: number;
  name?: string;
  kind?: MilestoneKindValue;
  ownerId?: string | null;
  description?: string | null;
  health?: MilestoneHealthValue | null;
  startsOn?: string | null;
  targetOn?: string | null;
}

export function updateMilestone(
  client: TaskaraClient,
  milestoneId: string,
  patch: UpdateMilestoneInput
): Promise<Milestone> {
  return client.request<Milestone>(`/milestones/${encodeURIComponent(milestoneId)}`, {
    method: 'PATCH',
    body: patch
  });
}

export function getHealth(client: TaskaraClient): Promise<JsonRecord> {
  return client.request<JsonRecord>('/health');
}

export function listActivity(client: TaskaraClient): Promise<JsonRecord[]> {
  return client.request<JsonRecord[]>('/activity');
}

export function generateDailyPlan(client: TaskaraClient): Promise<JsonRecord> {
  return client.request<JsonRecord>('/agent/daily-plan', { method: 'POST', body: {} });
}

export interface ProposeTasksInput {
  text: string;
  projectId?: string;
  sourceTitle?: string;
  sourceUrl?: string;
}

export function proposeTasksFromText(client: TaskaraClient, input: ProposeTasksInput): Promise<JsonRecord> {
  return client.request<JsonRecord>('/agent/thread-to-tasks', { method: 'POST', body: input });
}

export function applyAgentAction(client: TaskaraClient, actionId: string): Promise<JsonRecord> {
  return client.request<JsonRecord>(`/agent/actions/${encodeURIComponent(actionId)}/apply`, {
    method: 'POST',
    body: {}
  });
}

export function getDailyReportDraft(client: TaskaraClient, dateKey?: string): Promise<JsonRecord> {
  return client.request<JsonRecord>('/check-ins/draft', { query: { dateKey } });
}

export interface DailyReportInput {
  completedText?: string;
  unplannedText?: string;
  planText?: string;
  blockersText?: string;
  helpText?: string;
}

export function submitDailyReport(client: TaskaraClient, input: DailyReportInput): Promise<JsonRecord> {
  return client.request<JsonRecord>('/check-ins', { method: 'POST', body: input });
}

export interface UserListFilters {
  q?: string;
  role?: WorkspaceRoleValue;
  /** HUMAN or AGENT. Species, not permission — a role never says which one a member is. */
  kind?: UserKindValue;
  limit?: number;
  offset?: number;
}

export function listUsers(client: TaskaraClient, filters: UserListFilters = {}): Promise<UserListResponse> {
  return client.request<UserListResponse>('/users', { query: filters as QueryValues });
}

/**
 * Resolve a person to a UUID, accepting an email address as well as an id.
 *
 * The three handles a person could have are not equal, and this is where that is decided:
 *
 * - A **UUID** passes through, as everywhere else.
 * - An **email** is resolved. It is the only handle a person has that is both unique
 *   (`User.email` is `@@unique`) and appears in prose, which is what makes it addressable at all.
 * - A **name** is refused, and loudly. `User.name` carries no unique constraint, so matching one
 *   would be a heuristic that works until two people share a first name and then quietly hands the
 *   work to the wrong colleague. This surface will not make a name behave like an identifier.
 *
 * Nothing here guesses: the two forms are told apart by the `@` a UUID cannot contain, and the
 * match against the search results is **exact**, because `GET /users?q=` matches with `contains`
 * and `dana@example.test` is a substring of `xdana@example.test`.
 */
export async function resolveUserId(client: TaskaraClient, ref: string): Promise<string> {
  if (isUuid(ref)) return ref;

  const wanted = ref.trim().toLowerCase();
  if (!wanted.includes('@')) {
    // Usage rather than not-found: nothing is sent, and no retry of this string can ever work.
    const hint = wanted === 'me'
      ? 'To take a task yourself, use `taskara task claim <key>` — it is atomic and this flag is not.'
      : 'A name is not an identifier: `User.name` has no unique constraint. Find the person with '
        + '`taskara user list --query "<name>"` and pass the id or the email it prints.';
    throw new TaskaraError(`"${ref}" is neither a user id nor an email address. ${hint}`, {
      exitCode: exitCodes.usage
    });
  }

  const roster = await listUsers(client, { q: wanted, limit: 200 });
  const match = roster.items.find((member) => member.email.toLowerCase() === wanted);
  if (match) return match.id;

  // The search succeeded and held no exact match, so no HTTP 404 happened and none is claimed. The
  // roster is not named back at the caller the way `resolveProjectId` names known prefixes: a list
  // of prefixes is a handful of tokens, and a list of everyone's email addresses is the whole
  // directory pasted into an error message.
  throw new TaskaraError(
    `No member of this workspace has the email "${ref}". List the roster with \`taskara user list\`.`,
    { exitCode: exitCodes.notFound }
  );
}

export interface CreateUserInput {
  email: string;
  name: string;
  role?: WorkspaceRoleValue;
  mattermostUsername?: string;
  avatarUrl?: string;
}

export function createUser(client: TaskaraClient, input: CreateUserInput): Promise<JsonRecord> {
  return client.request<JsonRecord>('/users', { method: 'POST', body: input });
}

export function updateUserRole(
  client: TaskaraClient,
  userId: string,
  role: WorkspaceRoleValue
): Promise<JsonRecord> {
  return client.request<JsonRecord>(`/users/${encodeURIComponent(userId)}/role`, {
    method: 'PATCH',
    body: { role }
  });
}
