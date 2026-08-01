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
export const taskWeights = [1, 2, 3, 4, 8] as const;
export const taskKinds = ['WORK', 'EFFORT'] as const;

export const taskViewLayouts = ['list', 'board'] as const;
export const taskViewGroupings = ['status', 'assignee', 'project', 'milestone', 'priority'] as const;
export const taskViewOrderings = ['priority', 'updatedAt', 'createdAt', 'dueAt', 'title'] as const;
export const taskViewSubGroupings = ['none', 'status', 'assignee', 'project', 'milestone', 'priority'] as const;
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
export const projectUpdateHealthValues = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] as const;
export const milestoneKinds = ['FEATURE', 'PHASE', 'OTHER'] as const;
export const milestoneStatuses = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELED'] as const;
export const milestoneHealthValues = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK'] as const;
export const milestoneUnfinishedTaskPolicies = ['KEEP', 'UNASSIGN', 'MOVE'] as const;
export const workspaceRoles = ['OWNER', 'ADMIN', 'MEMBER', 'GUEST', 'AGENT'] as const;
export const userKinds = ['HUMAN', 'AGENT'] as const;
export const agentCredentialScopes = ['READ_ONLY', 'READ_WRITE'] as const;
export const announcementStatuses = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const meetingStatuses = ['PLANNED', 'HELD', 'CANCELED', 'ARCHIVED'] as const;
export const meetingActionItemStatuses = ['OPEN', 'DONE', 'CANCELED'] as const;
export const meetingParticipantRoles = ['OWNER', 'PARTICIPANT'] as const;
export const knowledgeSpaceTypes = ['WORKSPACE', 'TEAM', 'PROJECT'] as const;
export const knowledgePageStatuses = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const knowledgeReferenceTypes = ['PAGE', 'TASK', 'PROJECT', 'MEETING', 'ANNOUNCEMENT', 'EXTERNAL_URL'] as const;
export const taskReviewStatuses = ['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'CANCELED'] as const;

export type TaskStatusValue = (typeof taskStatuses)[number];
export type TaskPriorityValue = (typeof taskPriorities)[number];
export type TaskKindValue = (typeof taskKinds)[number];
export type ProjectUpdateHealthValue = (typeof projectUpdateHealthValues)[number];
export type MilestoneKindValue = (typeof milestoneKinds)[number];
export type MilestoneStatusValue = (typeof milestoneStatuses)[number];
export type MilestoneHealthValue = (typeof milestoneHealthValues)[number];
export type MilestoneUnfinishedTaskPolicyValue = (typeof milestoneUnfinishedTaskPolicies)[number];
export type WorkspaceRoleValue = (typeof workspaceRoles)[number];
export type UserKindValue = (typeof userKinds)[number];
export type AnnouncementStatusValue = (typeof announcementStatuses)[number];
export type MeetingStatusValue = (typeof meetingStatuses)[number];
export type MeetingActionItemStatusValue = (typeof meetingActionItemStatuses)[number];
export type MeetingParticipantRoleValue = (typeof meetingParticipantRoles)[number];
export type KnowledgeSpaceTypeValue = (typeof knowledgeSpaceTypes)[number];
export type KnowledgePageStatusValue = (typeof knowledgePageStatuses)[number];
export type KnowledgeReferenceTypeValue = (typeof knowledgeReferenceTypes)[number];
export type TaskReviewStatusValue = (typeof taskReviewStatuses)[number];
export type TaskViewLayoutValue = (typeof taskViewLayouts)[number];
export type TaskViewGroupingValue = (typeof taskViewGroupings)[number];
export type TaskViewOrderingValue = (typeof taskViewOrderings)[number];
export type TaskViewSubGroupingValue = (typeof taskViewSubGroupings)[number];
export type TaskViewCompletedIssuesValue = (typeof taskViewCompletedIssues)[number];
export type TaskViewDisplayPropertyValue = (typeof taskViewDisplayProperties)[number];

export const taskStatusSchema = z.enum(taskStatuses);
export const taskPrioritySchema = z.enum(taskPriorities);
export const taskKindSchema = z.enum(taskKinds);
export const taskWeightSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(8)
]);
export const projectStatusSchema = z.enum(projectStatuses);
export const projectUpdateHealthSchema = z.enum(projectUpdateHealthValues);
export const milestoneKindSchema = z.enum(milestoneKinds);
export const milestoneStatusSchema = z.enum(milestoneStatuses);
export const milestoneHealthSchema = z.enum(milestoneHealthValues);
export const milestoneUnfinishedTaskPolicySchema = z.enum(milestoneUnfinishedTaskPolicies);
export const workspaceRoleSchema = z.enum(workspaceRoles);
export const userKindSchema = z.enum(userKinds);
export const agentCredentialScopeSchema = z.enum(agentCredentialScopes);
export const announcementStatusSchema = z.enum(announcementStatuses);
export const meetingStatusSchema = z.enum(meetingStatuses);
export const meetingActionItemStatusSchema = z.enum(meetingActionItemStatuses);
export const meetingParticipantRoleSchema = z.enum(meetingParticipantRoles);
export const knowledgeSpaceTypeSchema = z.enum(knowledgeSpaceTypes);
export const knowledgePageStatusSchema = z.enum(knowledgePageStatuses);
export const knowledgeReferenceTypeSchema = z.enum(knowledgeReferenceTypes);
export const taskReviewStatusSchema = z.enum(taskReviewStatuses);
export const taskViewLayoutSchema = z.enum(taskViewLayouts);
export const taskViewGroupingSchema = z.enum(taskViewGroupings);
export const taskViewOrderingSchema = z.enum(taskViewOrderings);
export const taskViewSubGroupingSchema = z.enum(taskViewSubGroupings);
export const taskViewCompletedIssuesSchema = z.enum(taskViewCompletedIssues);
export const taskViewDisplayPropertySchema = z.enum(taskViewDisplayProperties);

function normalizePhoneNumberInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().replace(/[\s-]/g, '');
  return normalized || undefined;
}

const phoneNumberSchema = z.string().regex(/^\+?\d{7,15}$/, 'Invalid phone number');

const optionalPhoneNumberSchema = z.preprocess(normalizePhoneNumberInput, phoneNumberSchema.optional());
const nullablePhoneNumberSchema = z.preprocess((value) => {
  const normalized = normalizePhoneNumberInput(value);
  return normalized === undefined ? null : normalized;
}, phoneNumberSchema.nullable()).optional();

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(160),
  phone: optionalPhoneNumberSchema,
  mattermostUsername: z.string().trim().toLowerCase().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/).optional(),
  avatarUrl: z.string().trim().url().optional(),
  role: workspaceRoleSchema.default('MEMBER'),
  kind: userKindSchema.optional(),
  operatorId: z.string().uuid().optional()
});

export const createAgentCredentialSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  // Read-write by default: the tracker skills create and update Tasks, and a credential that
  // cannot do its job gets replaced by one with a wider grant than anybody intended.
  scope: agentCredentialScopeSchema.default('READ_WRITE'),
  // Omitted means never expires -- the whole reason this primitive exists.
  expiresAt: z.string().datetime().optional()
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  aiModel: z.string().trim().min(1).max(120).nullable().optional(),
  phone: nullablePhoneNumberSchema,
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

export const mergeProjectsSchema = z.object({
  destinationProjectId: z.string().uuid(),
  sourceProjectIds: z.array(z.string().uuid()).min(1).max(50)
}).superRefine((input, context) => {
  const uniqueSourceIds = new Set(input.sourceProjectIds);
  if (uniqueSourceIds.size !== input.sourceProjectIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceProjectIds'],
      message: 'Source projects must be unique'
    });
  }
  if (uniqueSourceIds.has(input.destinationProjectId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceProjectIds'],
      message: 'Destination project cannot also be a source project'
    });
  }
});

export const createProjectHealthUpdateSchema = z.object({
  health: projectUpdateHealthSchema,
  summary: z.string().trim().min(1).max(2000),
  progress: z.string().trim().max(5000).nullable().optional(),
  risks: z.string().trim().max(5000).nullable().optional(),
  decisionsNeeded: z.string().trim().max(5000).nullable().optional(),
  nextUpdateDueAt: z.string().datetime().nullable().optional()
});

export const projectHealthUpdateListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0)
});

export const milestoneDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD').refine(
  (value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  },
  'Date is not a valid calendar day'
);

const milestoneMetadataSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: milestoneKindSchema,
  ownerId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(15000).nullable().optional(),
  health: milestoneHealthSchema.nullable().optional(),
  startsOn: milestoneDateSchema.nullable().optional(),
  targetOn: milestoneDateSchema.nullable().optional()
});

function validateMilestoneDateRange(
  value: { startsOn?: string | null; targetOn?: string | null },
  ctx: z.RefinementCtx
): void {
  if (value.startsOn && value.targetOn && value.startsOn > value.targetOn) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetOn'],
      message: 'Target date cannot precede start date'
    });
  }
}

export const createMilestoneSchema = milestoneMetadataSchema.extend({
  // Sync clients allocate the UUID before enqueueing so later offline task
  // mutations can safely reference the pending milestone.
  id: z.string().uuid().optional(),
  projectId: z.string().uuid(),
  status: z.enum(['PLANNED', 'ACTIVE']).default('PLANNED')
}).superRefine(validateMilestoneDateRange);

export const updateMilestoneSchema = milestoneMetadataSchema.partial().extend({
  version: z.number().int().min(1)
}).superRefine((value, ctx) => {
  validateMilestoneDateRange(value, ctx);
  if (Object.keys(value).every((key) => key === 'version')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'At least one milestone field must be updated'
    });
  }
});

/**
 * The only way to spell a boolean in a query string. `true` and `false` mean themselves and every
 * other value is rejected, so the caller gets a 400 instead of a silently different result set.
 *
 * This exists because `z.coerce.boolean()` is `Boolean(string)`: every non-empty value is `true`,
 * so `?mine=false` means `?mine=true` and there is no spelling of "off" at all. Unrecognized input
 * is echoed back unchanged for `z.boolean()` to reject, which keeps the field's name in the Zod
 * error path.
 *
 * Anything narrower or wider is a bug: no `1`/`0`, no `yes`/`no`, no case folding. A query string is
 * written by a program against a documented API, and a second accepted spelling is a second thing
 * every caller has to agree on. Environment variables answer to the same rule but a wider
 * vocabulary — see `parseEnvFlag` in the API's config, and issue #42 for why they differ.
 */
export const strictQueryBooleanSchema = z.preprocess((value) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}, z.boolean());

/** A repeated query filter is written as one comma-separated value, never as a repeated key. */
function splitCommaSeparated(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

const milestoneStatusFilterSchema = z.preprocess(
  splitCommaSeparated,
  z.array(milestoneStatusSchema).min(1).max(milestoneStatuses.length)
);

export const milestoneListQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  ownerId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  kind: milestoneKindSchema.optional(),
  status: milestoneStatusFilterSchema.optional(),
  health: z.union([milestoneHealthSchema, z.literal('none')]).optional(),
  overdue: strictQueryBooleanSchema.optional(),
  q: z.string().trim().max(200).optional(),
  includeArchived: strictQueryBooleanSchema.default(false),
  archivedOnly: strictQueryBooleanSchema.default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const milestoneOwnerCandidateQuerySchema = z.object({
  projectId: z.string().uuid(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

export const reorderMilestoneSchema = z.object({
  version: z.number().int().min(1),
  beforeId: z.string().uuid().nullable().optional(),
  afterId: z.string().uuid().nullable().optional()
}).superRefine((value, ctx) => {
  if (value.beforeId && value.afterId && value.beforeId === value.afterId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['afterId'],
      message: 'Reorder neighbors must be different milestones'
    });
  }
});

export const milestoneTransitionSchema = z.object({
  version: z.number().int().min(1).optional()
});

export const milestoneCompletionSchema = milestoneTransitionSchema.extend({
  unfinishedTaskPolicy: milestoneUnfinishedTaskPolicySchema.optional(),
  targetMilestoneId: z.string().uuid().optional(),
  note: z.string().trim().max(5000).nullable().optional()
}).superRefine((value, ctx) => {
  if (value.unfinishedTaskPolicy === 'MOVE' && !value.targetMilestoneId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetMilestoneId'],
      message: 'Moving unfinished tasks requires a target milestone'
    });
  }
  if (value.unfinishedTaskPolicy !== 'MOVE' && value.targetMilestoneId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetMilestoneId'],
      message: 'A target milestone is only valid with MOVE policy'
    });
  }
});

/**
 * How much prose a Task description may hold, per `kind`, in UTF-16 code units.
 *
 * **The unit is code units, and it is the only unit that binds.** `z.string().max()` counts
 * `String.length`; the column is Postgres `text` (`description String?`, no `@db.VarChar`), so
 * bytes never bind; and Fastify's body limit is 25 MB, four orders of magnitude away. That makes
 * the number below the whole of the bound, and it makes it a *character* bound rather than a
 * storage one — deliberately. Persian runs about 1.9 UTF-8 bytes per code unit, so a Persian body
 * costs roughly twice the bytes of an English one at the same ceiling. Counting bytes instead
 * would invert that into the wrong asymmetry for a Persian-speaking workspace: the same document
 * would be refused in Persian and accepted in English. In bytes the ceilings below are therefore
 * "up to" figures — about 15 KB and 60 KB in English, about 29 KB and 116 KB in Persian.
 */
export const WORK_DESCRIPTION_MAX_CHARS = 15_000;

/**
 * An Effort's description *is* the wayfinder map — Destination, Notes, and a Decisions-so-far
 * index that grows by a line every time one of its tickets closes. 15,000 does not hold one: the
 * map this model was built for measured 22,535 code units with nine of its twenty-five tickets
 * still open.
 *
 * Only efforts are widened, and the reason is not symmetry-breaking for its own sake. The
 * local-first bootstrap ships up to 500 work descriptions to every client on every cold start
 * (`sync.ts`, `take: 500`) and there is no payload budget anywhere else in the stack, so the work
 * ceiling is the only bound on how large that download can get. Efforts are excluded from that
 * payload at the server — in the bootstrap query *and* in the live stream's in-memory twin — so
 * widening theirs costs the bootstrap exactly nothing, while widening work's would multiply the
 * one bound it has.
 */
export const EFFORT_DESCRIPTION_MAX_CHARS = 60_000;

export function taskDescriptionMaxChars(kind: TaskKindValue): number {
  return kind === 'EFFORT' ? EFFORT_DESCRIPTION_MAX_CHARS : WORK_DESCRIPTION_MAX_CHARS;
}

export const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  parentId: z.string().uuid().optional(),
  cycleId: z.string().uuid().optional(),
  milestoneId: z.string().uuid().optional(),
  title: z.string().min(1).max(300),
  // Absent means WORK, and that default is the whole compatibility story rather than a tidy touch:
  // every caller that exists — the web app, the Mattermost bot, the menubar app, and every internal
  // path that mints a task from a meeting, a check-in or an agent proposal — omits this field. A
  // required field, or a different default, would silently reclassify everything the team files.
  kind: taskKindSchema.default('WORK'),
  // The widest ceiling any task may hold, matching `updateTaskSchema` — this is the transport
  // bound, and the per-kind one is applied in `createTask()`. The narrowing does not live here even
  // though `kind` is right above it: a `superRefine` would turn this object into a `ZodEffects`,
  // and `codexTaskCreateSchema` extends it. The service layer is the better home anyway, because a
  // Zod issue does not reach a caller — `/sync/push` flattens it and the web client reads only
  // `message` — whereas the `HttpError` the service throws survives both paths with its number.
  description: z.string().max(EFFORT_DESCRIPTION_MAX_CHARS).optional(),
  status: taskStatusSchema.default('TODO'),
  priority: taskPrioritySchema.default('NO_PRIORITY'),
  weight: taskWeightSchema.nullable().optional(),
  assigneeId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  labels: z.array(z.string().min(1).max(40)).max(12).default([]),
  source: z.enum(['WEB', 'API', 'MATTERMOST', 'CODEX', 'AGENT', 'SYSTEM']).default('API')
});

/**
 * How many labels one task may carry. Exported because two places enforce it and they must agree:
 * the schemas cap the array a caller sends, and the additive path caps the resulting set — which is
 * the only cap that binds once a caller can add twelve at a time, repeatedly.
 */
export const maxTaskLabels = 12;

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  // The widest ceiling any task may hold, because a patch body cannot tell WORK from EFFORT — the
  // kind lives on the row being patched, not in the request. This is the transport bound; the
  // narrower per-kind one is applied in `updateTask()`, once the row has been read.
  description: z.string().max(EFFORT_DESCRIPTION_MAX_CHARS).nullable().optional(),
  projectId: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  weight: taskWeightSchema.nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  cycleId: z.string().uuid().nullable().optional(),
  milestoneId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  // The whole-array replacement, unchanged. The web client holds the complete set in its editor and
  // means to replace it, so this is the right idiom for it and stays the default.
  labels: z.array(z.string().min(1).max(40)).max(maxTaskLabels).optional(),
  // The additive idiom, for callers that hold a delta rather than the set. Two agents each adding
  // one label to the same task must both survive; with `labels` they cannot, because each reads the
  // set, appends locally and writes the whole thing back, and this endpoint has no concurrency
  // control to catch the loser (`baseVersion` is optional and reachable only through /sync). Moving
  // the add server-side makes the two writes commute instead of racing.
  addLabels: z.array(z.string().min(1).max(40)).max(maxTaskLabels).optional(),
  removeLabels: z.array(z.string().min(1).max(40)).max(maxTaskLabels).optional()
}).superRefine((value, ctx) => {
  // Replacing and adding in one request is not a merge anyone can predict the outcome of — it is a
  // caller that has confused the two idioms. Refusing beats picking an order and being quietly
  // wrong half the time.
  if (value.labels === undefined) return;
  for (const field of ['addLabels', 'removeLabels'] as const) {
    if (value[field] === undefined) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: 'Use labels to replace the whole set, or addLabels/removeLabels to change it — not both'
    });
  }
});

export const createCommentSchema = z.object({
  body: z.string().min(1).max(15000),
  source: z.enum(['WEB', 'API', 'MATTERMOST', 'CODEX', 'AGENT', 'SYSTEM']).default('API'),
  mattermostPostId: z.string().optional()
});

// `blockedBy` is an id or a key, like every other task reference an agent or a script can hold, so
// it is length-bounded rather than uuid-shaped. Trimmed and non-empty after trimming: a blank
// string would otherwise reach the lookup and come back as a plain 404, which reads as "no such
// task" when the truth is "you sent nothing".
export const createTaskDependencySchema = z.object({
  blockedBy: z.string().trim().min(1).max(120)
});

export const requestTaskReviewSchema = z.object({
  reviewerId: z.string().uuid(),
  dueAt: z.string().datetime().nullable().optional(),
  comment: z.string().trim().max(5000).nullable().optional()
});

export const reassignTaskReviewSchema = z.object({
  reviewerId: z.string().uuid(),
  dueAt: z.string().datetime().nullable().optional(),
  comment: z.string().trim().max(5000).nullable().optional()
});

export const taskReviewDecisionSchema = z.object({
  comment: z.string().trim().max(5000).nullable().optional()
});

export const assignmentRecommendationSchema = z.object({
  taskIdOrKey: z.string().trim().min(1).max(120).optional(),
  projectId: z.string().uuid().optional(),
  title: z.string().trim().max(300).optional(),
  description: z.string().trim().max(15000).optional(),
  priority: taskPrioritySchema.default('NO_PRIORITY'),
  weight: z.coerce.number().positive().max(40).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8)
}).superRefine((value, ctx) => {
  if (!value.taskIdOrKey && !value.projectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['projectId'],
      message: 'Assignment recommendation requires taskIdOrKey or projectId'
    });
  }
});

export const updateUserCapacitySchema = z.object({
  dailyWeightLimit: z.coerce.number().min(0).max(100).optional(),
  weeklyWeightLimit: z.coerce.number().min(0).max(500).nullable().optional(),
  active: z.boolean().optional(),
  note: z.string().trim().max(2000).nullable().optional()
});

export const upsertWorkingAgreementSchema = z.object({
  teamId: z.string().uuid().nullable().optional(),
  activeWipLimit: z.coerce.number().int().min(0).max(500).nullable().optional(),
  reviewWipLimit: z.coerce.number().int().min(0).max(500).nullable().optional(),
  reviewSlaHours: z.coerce.number().int().min(1).max(720).optional(),
  blockedSlaHours: z.coerce.number().int().min(1).max(720).optional(),
  staleAfterHours: z.coerce.number().int().min(1).max(2160).optional()
});

export const triageAcceptSchema = z.object({
  assigneeId: z.string().uuid().nullable().optional(),
  priority: taskPrioritySchema.optional(),
  weight: taskWeightSchema.nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  projectId: z.string().uuid().optional(),
  unassignedReason: z.string().trim().max(2000).nullable().optional(),
  comment: z.string().trim().max(5000).nullable().optional()
}).superRefine((value, ctx) => {
  if (!value.assigneeId && !value.unassignedReason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unassignedReason'],
      message: 'Accepting unassigned work requires a reason'
    });
  }
});

export const triageRequestInfoSchema = z.object({
  comment: z.string().trim().min(3).max(5000)
});

export const triageDeclineSchema = z.object({
  reason: z.string().trim().min(3).max(5000)
});

export const triageDuplicateSchema = z.object({
  canonicalTaskIdOrKey: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(5000).nullable().optional()
});

export const triageSnoozeSchema = z.object({
  snoozedUntil: z.string().datetime(),
  reason: z.string().trim().min(3).max(5000)
});

export const triageSplitSchema = z.object({
  items: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(15000).nullable().optional()
  })).min(2).max(12),
  reason: z.string().trim().max(5000).nullable().optional()
});

/**
 * One absence sentinel for the whole task query surface. `milestoneId=none` established it; every
 * later filter that can ask for "the field is not set" spells it the same way, so a caller learns
 * the convention once.
 */
const taskFilterNone = z.literal('none');

/** Taskara's word for `status NOT IN (DONE, CANCELED)` — see a milestone's `unfinishedTaskPolicy`. */
export const unfinishedTaskStatusFilter = 'unfinished';

/**
 * `status` accepts one status, a comma-separated list of them, or `unfinished` on its own.
 *
 * `unfinished` is deliberately not spelled `open`: this is a task manager, not a GitHub clone, and
 * `open` has no meaning in Taskara's language. It is also not spelled `active`, which
 * `work-health.ts` already uses for the narrower TODO/IN_PROGRESS/IN_REVIEW/BLOCKED set — reusing it
 * here would give one word two sizes. Mixing `unfinished` with explicit statuses is rejected rather
 * than guessed at, because both plausible readings (union, intersection) have a real caller.
 */
export const taskStatusFilterSchema = z.union(
  [
    z.literal(unfinishedTaskStatusFilter),
    z.preprocess(splitCommaSeparated, z.array(taskStatusSchema).min(1).max(taskStatuses.length))
  ],
  {
    errorMap: () => ({
      message: `status accepts ${taskStatuses.join(', ')}, a comma-separated list of those, or "${unfinishedTaskStatusFilter}" on its own`
    })
  }
);

/**
 * Whether the task has an *open* blocker — a blocking task that is itself unfinished. Named for the
 * dependency edge, not for `status: BLOCKED`, which is a self-declared status and a different claim.
 */
export const taskBlockerFilterSchema = z.enum(['none', 'any']);

/**
 * A closed set rather than a free `field:direction` parser: every value here has to stay cheap to
 * order by, and an open parser invites sorts with no index behind them.
 */
export const taskSortOrders = [
  'createdAt:asc',
  'createdAt:desc',
  'updatedAt:asc',
  'updatedAt:desc',
  'dueAt:asc',
  'dueAt:desc'
] as const;

export type TaskSortOrderValue = (typeof taskSortOrders)[number];
export const taskSortSchema = z.enum(taskSortOrders);

export const taskListQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  milestoneId: z.union([z.string().uuid(), taskFilterNone]).optional(),
  parentId: z.union([z.string().uuid(), taskFilterNone]).optional(),
  assigneeId: z.union([z.string().uuid(), taskFilterNone]).optional(),
  // Omitted means WORK: the task list is the issue list a human reads, and an EFFORT is not an
  // issue. Passing it explicitly is how an effort surface lists efforts — the read half of the
  // property, without which "excluded" and "deleted" become the same thing.
  kind: taskKindSchema.optional(),
  status: taskStatusFilterSchema.optional(),
  priority: taskPrioritySchema.optional(),
  label: z.string().trim().max(80).optional(),
  blockers: taskBlockerFilterSchema.optional(),
  sort: taskSortSchema.optional(),
  teamId: z.string().min(1).default('all'),
  q: z.string().max(200).optional(),
  mine: strictQueryBooleanSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const announcementPollOptionSchema = z.string().trim().min(1).max(160);

export const announcementPollSchema = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(announcementPollOptionSchema).min(2).max(12),
  allowMultiple: z.boolean().default(false)
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.options.forEach((option, index) => {
    const normalized = option.toLocaleLowerCase();
    if (seen.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', index],
        message: 'Poll options must be unique'
      });
      return;
    }
    seen.add(normalized);
  });
});

export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(15000).optional(),
  recipientIds: z.array(z.string().uuid()).max(500).default([]),
  poll: announcementPollSchema.optional(),
  publish: z.boolean().default(false)
}).superRefine((value, ctx) => {
  if (value.publish && value.recipientIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recipientIds'],
      message: 'Published announcements require at least one recipient'
    });
  }
});

export const updateAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().max(15000).nullable().optional(),
  recipientIds: z.array(z.string().uuid()).max(500).optional(),
  status: announcementStatusSchema.optional()
});

export const announcementPollVoteSchema = z.object({
  optionIds: z.array(z.string().uuid()).min(1).max(12)
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.optionIds.forEach((optionId, index) => {
    if (seen.has(optionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionIds', index],
        message: 'Duplicate option ids are not allowed'
      });
      return;
    }
    seen.add(optionId);
  });
});

export const announcementListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: announcementStatusSchema.optional(),
  unread: strictQueryBooleanSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(30000).optional(),
  teamId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  participantIds: z.array(z.string().uuid()).max(500).default([]),
  status: meetingStatusSchema.default('PLANNED'),
  scheduledAt: z.string().datetime().optional(),
  heldAt: z.string().datetime().optional()
});

export const updateMeetingSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(30000).nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  participantIds: z.array(z.string().uuid()).max(500).optional(),
  status: meetingStatusSchema.optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  heldAt: z.string().datetime().nullable().optional()
});

export const meetingListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: meetingStatusSchema.optional(),
  teamId: z.string().min(1).default('all'),
  mine: strictQueryBooleanSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const createMeetingTasksSchema = z.object({
  projectId: z.string().uuid(),
  tasks: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(15000).optional(),
    assigneeId: z.string().uuid().optional(),
    status: taskStatusSchema.default('TODO'),
    priority: taskPrioritySchema.default('NO_PRIORITY'),
    dueAt: z.string().datetime().optional(),
    labels: z.array(z.string().min(1).max(40)).max(12).default([])
  })).min(1).max(50)
});

export const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date key');

export const createCheckInResponseSchema = z.object({
  userId: z.string().uuid().optional(),
  completedText: z.string().trim().max(5000).nullable().optional(),
  unplannedText: z.string().trim().max(5000).nullable().optional(),
  blockersText: z.string().trim().max(5000).nullable().optional(),
  planText: z.string().trim().max(5000).nullable().optional(),
  helpText: z.string().trim().max(5000).nullable().optional(),
  dateKey: dateKeySchema.optional(),
  submittedFor: z.string().datetime().optional()
}).superRefine((value, ctx) => {
  const hasAnswer = [value.completedText, value.unplannedText, value.blockersText, value.planText, value.helpText]
    .some((field) => Boolean(field?.trim()));
  if (!hasAnswer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['planText'],
      message: 'Check-in requires at least one response field'
    });
  }
});

export const checkInListQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  dateKey: dateKeySchema.optional(),
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const missingCheckInQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  dateKey: dateKeySchema.optional()
});

export const checkInDigestQuerySchema = z.object({
  dateKey: dateKeySchema.optional()
});

export const checkInTrendsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
  dateKey: dateKeySchema.optional()
});

export const checkInDraftQuerySchema = z.object({
  dateKey: dateKeySchema.optional()
});

export const requestCheckInSchema = z.object({
  userId: z.string().uuid(),
  message: z.string().trim().max(500).nullable().optional()
});

export const createOneOnOneSeriesSchema = z.object({
  participantId: z.string().uuid(),
  managerId: z.string().uuid().optional(),
  title: z.string().trim().max(300).nullable().optional(),
  cadenceDays: z.coerce.number().int().min(1).max(365).default(14),
  nextScheduledAt: z.string().datetime().nullable().optional()
});

export const oneOnOneListQuerySchema = z.object({
  participantId: z.string().uuid().optional(),
  // Handed straight to Prisma as a `where` clause, so a misread here inverts the answer rather than
  // widening it.
  active: strictQueryBooleanSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const createOneOnOneAgendaItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(5000).nullable().optional(),
  meetingId: z.string().uuid().nullable().optional(),
  sourceType: z.string().trim().max(80).nullable().optional(),
  sourceId: z.string().trim().max(160).nullable().optional(),
  position: z.coerce.number().int().min(0).max(10000).default(0)
});

export const createMeetingActionItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(5000).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional()
});

export const meetingActionItemListQuerySchema = z.object({
  assigneeId: z.string().uuid().optional(),
  meetingId: z.string().uuid().optional(),
  status: z.union([meetingActionItemStatusSchema, z.literal('ALL')]).default('OPEN'),
  dueBefore: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const updateMeetingActionItemSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  status: meetingActionItemStatusSchema.optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'At least one action-item field is required'
});

export const carryForwardMeetingActionItemSchema = z.object({
  seriesId: z.string().uuid(),
  notes: z.string().trim().max(5000).nullable().optional()
});

export const createTaskFromMeetingActionItemSchema = z.object({
  projectId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  priority: taskPrioritySchema.default('MEDIUM')
});

const knowledgeContentSchema = z.unknown();

export const createKnowledgeSpaceSchema = z.object({
  type: knowledgeSpaceTypeSchema.default('WORKSPACE'),
  key: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).optional(),
  icon: z.string().trim().max(80).optional(),
  teamId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional()
});

export const updateKnowledgeSpaceSchema = z.object({
  key: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  icon: z.string().trim().max(80).nullable().optional()
});

export const createKnowledgePageSchema = z.object({
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().optional(),
  slug: z.string().trim().toLowerCase().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(1000).optional(),
  icon: z.string().trim().max(80).optional(),
  content: knowledgeContentSchema.optional(),
  status: knowledgePageStatusSchema.default('PUBLISHED'),
  ownerId: z.string().uuid().optional(),
  labels: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  position: z.coerce.number().int().min(0).max(100000).default(0)
});

export const updateKnowledgePageSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  slug: z.string().trim().toLowerCase().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  parentId: z.string().uuid().nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  icon: z.string().trim().max(80).nullable().optional(),
  content: knowledgeContentSchema.optional(),
  status: knowledgePageStatusSchema.optional(),
  ownerId: z.string().uuid().nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  position: z.coerce.number().int().min(0).max(100000).optional(),
  baseVersion: z.coerce.number().int().min(1).optional()
});

export const knowledgePageListQuerySchema = z.object({
  spaceId: z.string().uuid().optional(),
  parentId: z.string().uuid().nullable().optional(),
  q: z.string().trim().max(200).optional(),
  ownerId: z.string().uuid().optional(),
  label: z.string().trim().max(80).optional(),
  status: knowledgePageStatusSchema.optional(),
  // `verified` is three-valued downstream — verified, unverified, unfiltered — so the false half is
  // a real query, not just the absence of the true one.
  verified: strictQueryBooleanSchema.optional(),
  expired: strictQueryBooleanSchema.optional(),
  mine: strictQueryBooleanSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const knowledgeSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export const verifyKnowledgePageSchema = z.object({
  expiresAt: z.string().datetime().nullable().optional()
});

export const createKnowledgeCommentSchema = z.object({
  body: z.string().trim().min(1).max(15000),
  anchor: z.unknown().optional()
});

export const updateKnowledgeCommentSchema = z.object({
  body: z.string().trim().min(1).max(15000).optional(),
  resolved: z.boolean().optional()
});

export const taskViewStateSchema = z.object({
  scope: z.literal('tasks').default('tasks'),
  teamId: z.string().min(1).default('all'),
  query: z.string().max(200).default(''),
  status: z.array(taskStatusSchema).max(20).default([]),
  assigneeIds: z.array(z.string().min(1)).max(100).default([]),
  priority: z.array(taskPrioritySchema).max(20).default([]),
  projectIds: z.array(z.string().uuid()).max(100).default([]),
  milestoneIds: z.array(z.string()).max(100).default([]),
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
