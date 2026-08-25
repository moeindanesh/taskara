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

/**
 * Whether a body is the web editor's serialised document rather than the markdown this surface
 * writes.
 *
 * One column holds two formats — `CONTEXT.md`, «Body»; `docs/adr/0003` — and this is the question
 * every module that touches a body has to ask before it touches one, because the editor's half is a
 * JSON document whose meaning lives in its structure. `mentions.ts` asks it to avoid warning about
 * live mention nodes; `line-breaks.ts` asks it because a `\n` inside that document is JSON's own
 * escape for a newline in a text node, and decoding one leaves a string literal with a raw break in
 * it that no longer parses.
 *
 * It lives here, beside `isRedactedTaskRef`, for the same reason that one does: it is the wire's
 * discriminant, and it is asked in one place so the two callers cannot drift into disagreeing about
 * what an editor document is.
 */
export function isSerializedEditorValue(body: string | null | undefined): boolean {
  if (!body?.trimStart().startsWith('{')) return false;

  try {
    const parsed = JSON.parse(body) as { root?: { type?: unknown; children?: unknown } } | null;
    return Boolean(parsed?.root && parsed.root.type === 'root' && Array.isArray(parsed.root.children));
  } catch {
    return false;
  }
}

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
  blockingDependencies?: Array<{ blockedByTask: TaskEdgeTarget }>;
  blockedTasks?: Array<{ task: TaskEdgeTarget }>;
  subtasks?: TaskEdgeTarget[];
  comments?: Array<{ body: string; createdAt: string; author?: { name: string } | null }>;
}

/**
 * A task hanging off a task you *can* read, that you cannot read yourself (#58).
 *
 * A blocker, the task it blocks and a subtask are not confined to one project, so
 * `GET /tasks/:idOrKey` withholds the ones behind a team wall. It **redacts rather than omits**:
 * a dependency that disappeared because of who was asking would make a blocked task read as
 * takeable, and an agent deciding what to pick up is the reader most likely to act on that.
 *
 * One bit survives, `open` — still in the way, on the same DONE/CANCELED reading as everywhere
 * else. There is nothing else: no id, no key, no title. Never render it as a task.
 */
export interface RedactedTaskRef {
  redacted: true;
  open: boolean;
}

/** The far end of an edge: the task, or the fact that there is one. */
export type TaskEdgeTarget = Task | RedactedTaskRef;

/** Which of the two arrived. The wire's discriminant, asked in one place. */
export function isRedactedTaskRef(target: TaskEdgeTarget): target is RedactedTaskRef {
  return 'redacted' in target && target.redacted === true;
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

/**
 * A person as the check-in routes name them.
 *
 * Not `WorkspaceMember`: these rows come from a different select and carry no membership, so they
 * have no `role` and no `kind` — and they do carry a **phone number**, which is why both shells
 * project this down rather than printing it. A digest is the one read whose whole payload is other
 * people's details, and it is read out loud in standups.
 */
export interface CheckInPerson {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  avatarUrl?: string | null;
}

/**
 * One filed daily report.
 *
 * `userId` and `authorId` differ when somebody filed on another person's behalf, which is the only
 * reason `author` is worth carrying: a report in a manager's voice reads differently from one in the
 * subject's, and nothing else on the row says which it is.
 */
export interface CheckInRow {
  id: string;
  userId: string;
  authorId: string;
  completedText: string | null;
  unplannedText: string | null;
  blockersText: string | null;
  planText: string | null;
  helpText: string | null;
  dateKey: string | null;
  submittedFor: string;
  user: CheckInPerson;
  author?: CheckInPerson | null;
}

/** Yesterday's plan against today's result, per person, with the task keys made comparable. */
export interface PlanVsDone {
  userId: string;
  user: CheckInPerson;
  plannedYesterday: string | null;
  completedToday: string | null;
  tasks: Array<{ key: string; status: 'done' | 'slipped' }>;
}

/**
 * The manager's morning artifact.
 *
 * The two halves are not interchangeable and the server draws them from different populations on
 * purpose. `reports`, `blockersFirst`, `unplanned` and `planVsDone` are what a manager READS — every
 * report filed that day, a guest's included. `stats` is what a manager is SCORED BY — the measured
 * roster only, humans who are not guests. So `reports.length` and `stats.submitted` may legitimately
 * disagree, and reconciling them would re-merge visibility with measurement.
 *
 * `workday: false` is a weekend: nobody was asked, so `expected` is 0 and `missing` is empty. Read it
 * as "nothing was owed", never as "everybody skipped it".
 */
export interface DailyReportDigest {
  dateKey: string;
  workday: boolean;
  reports: CheckInRow[];
  blockersFirst: CheckInRow[];
  unplanned: CheckInRow[];
  planVsDone: PlanVsDone[];
  missing: CheckInPerson[];
  stats: {
    expected: number;
    submitted: number;
    missing: number;
    participationRate: number;
    blockerCount: number;
    unplannedShare: number;
  };
}

/** Who owes a report for one workspace day. What `GET /check-ins/missing?dateKey=…` answers. */
export interface MissingForDay {
  dateKey: string;
  items: CheckInPerson[];
  total: number;
  expected: number;
}

/** Who has filed nothing at all lately. What the same path answers with no `dateKey`. */
export interface MissingInWindow {
  items: Array<{ user: CheckInPerson; lastCheckInAt: string | null; hoursSinceLastCheckIn: number | null }>;
  total: number;
  thresholdHours: number;
  generatedAt: string;
}

/**
 * One path, two answers. The `dateKey` the caller sent is what chose between them, so a reader that
 * did not send one cannot be handed a day's roster and vice versa.
 */
export type MissingDailyReports = MissingForDay | MissingInWindow;

/** Which of the two arrived. The wire's discriminant, asked in one place. */
export function isMissingForDay(result: MissingDailyReports): result is MissingForDay {
  return 'dateKey' in result;
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
