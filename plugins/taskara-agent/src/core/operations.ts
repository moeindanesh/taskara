import type {
  MilestoneHealthValue,
  MilestoneKindValue,
  MilestoneStatusValue,
  TaskKindValue,
  TaskPriorityValue,
  TaskStatusValue,
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
  TaskListResponse
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
  limit?: number;
}

export function listUsers(client: TaskaraClient, filters: UserListFilters = {}): Promise<JsonRecord> {
  return client.request<JsonRecord>('/users', { query: filters as QueryValues });
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
