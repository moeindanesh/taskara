import { z } from 'zod';

export const workspaceModes = ['TEAM', 'SUPPORT'] as const;
export const workspaceModeSchema = z.enum(workspaceModes);
export type WorkspaceModeValue = (typeof workspaceModes)[number];

export const departmentMemberRoles = ['MEMBER', 'MANAGER'] as const;
export const supportPermissionRoles = ['TRIAGER', 'SUPERVISOR'] as const;
export const supportCredentialScopes = ['CASE_READ', 'CASE_WRITE', 'TRIAGE', 'CONFIGURE', 'INTAKE'] as const;
export const supportCaseSourceChannels = ['API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING'] as const;
export const supportCasePriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const supportCaseImpacts = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const supportCaseUrgencies = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const supportCaseStatuses = [
  'NEW',
  'OPEN',
  'WAITING_ON_CUSTOMER',
  'WAITING_ON_INTERNAL',
  'RESOLVED',
  'CLOSED'
] as const;
export const supportCaseResolutionCodes = [
  'FIXED',
  'ANSWERED',
  'WORKAROUND',
  'DUPLICATE',
  'NO_RESPONSE',
  'NOT_REPRODUCIBLE',
  'REJECTED',
  'WITHDRAWN',
  'SPAM'
] as const;
export const supportInteractionKinds = ['MESSAGE', 'CALL', 'NOTE'] as const;
export const supportInteractionVisibilities = ['PUBLIC', 'INTERNAL'] as const;
export const supportInteractionDirections = ['INBOUND', 'OUTBOUND', 'INTERNAL'] as const;
export const supportCallDirections = ['INBOUND', 'OUTBOUND'] as const;
export const supportCallDispositions = ['ANSWERED', 'MISSED', 'ABANDONED', 'VOICEMAIL'] as const;
export const supportRecordingConsents = ['UNKNOWN', 'GIVEN', 'DENIED', 'NOT_REQUIRED'] as const;
export const supportCaseEventSources = ['WEB', 'API', 'CONNECTOR', 'CALL_CENTER', 'SYSTEM'] as const;
// The persisted enum reserves ED25519 for a future key-provisioning contract. The public v1
// connector API provisions a symmetric secret, so advertising ED25519 here would create a
// connector that cannot authenticate any request.
export const supportConnectorSignatureSchemes = ['HMAC_SHA256'] as const;
export const supportConnectorStatuses = ['ACTIVE', 'REVOKED'] as const;
export const supportIntakeReceiptStatuses = [
  'RECEIVED',
  'PROCESSING',
  'RETRY_PENDING',
  'PROCESSED',
  'REJECTED',
  'DEAD_LETTER'
] as const;
export const supportOutboxStatuses = ['PENDING', 'PROCESSING', 'RETRY_PENDING', 'DELIVERED', 'DEAD_LETTER'] as const;
export const supportSlaMetrics = [
  'TRIAGE',
  'FIRST_RESPONSE',
  'NEXT_RESPONSE',
  'RESOLUTION',
  'FOLLOW_UP',
  'MEMBER_ASSIGNMENT'
] as const;
export const supportSlaClockStates = ['RUNNING', 'PAUSED', 'MET', 'BREACHED', 'CANCELED'] as const;
export const supportJobLeaseStatuses = ['PENDING', 'RUNNING', 'RETRY_PENDING', 'COMPLETED', 'DEAD_LETTER'] as const;
export const workspaceConnectionStatuses = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export const supportCaseTaskLinkTypes = ['FIX_WORK', 'INVESTIGATION', 'FOLLOW_UP', 'RELATED'] as const;
export const supportCaseSignalStatuses = ['OPEN', 'RESOLVED', 'CLOSED'] as const;
export const supportQueueKinds = ['TRIAGE', 'DEPARTMENT_INBOX', 'MY_CASES', 'NEEDS_ATTENTION'] as const;
export const supportAttentionReasons = [
  'UNTRIAGED_TOO_LONG',
  'NO_NEXT_ACTION',
  'NEXT_ACTION_DUE',
  'SLA_AT_RISK',
  'SLA_BREACHED',
  'STALE_OWNERSHIP',
  'DEPARTMENT_UNASSIGNED_TOO_LONG',
  'WAITING_ON_CUSTOMER_TOO_LONG',
  'WAITING_ON_INTERNAL_TOO_LONG',
  'CALLBACK_DUE',
  'EXCESSIVE_TRANSFERS',
  'HANDOFF_REJECTED_OR_EXPIRED',
  'REOPENED',
  'RESOLUTION_UNCONFIRMED',
  'NON_FIXED_RESOLUTION',
  'LINKED_TASK_BLOCKED_OR_OVERDUE'
] as const;

export type DepartmentMemberRoleValue = (typeof departmentMemberRoles)[number];
export type SupportPermissionRoleValue = (typeof supportPermissionRoles)[number];
export type SupportCredentialScopeValue = (typeof supportCredentialScopes)[number];
export type SupportCaseSourceChannelValue = (typeof supportCaseSourceChannels)[number];
export type SupportCasePriorityValue = (typeof supportCasePriorities)[number];
export type SupportCaseImpactValue = (typeof supportCaseImpacts)[number];
export type SupportCaseUrgencyValue = (typeof supportCaseUrgencies)[number];
export type SupportCaseStatusValue = (typeof supportCaseStatuses)[number];
export type SupportCaseResolutionCodeValue = (typeof supportCaseResolutionCodes)[number];
export type SupportInteractionKindValue = (typeof supportInteractionKinds)[number];
export type SupportInteractionVisibilityValue = (typeof supportInteractionVisibilities)[number];
export type SupportInteractionDirectionValue = (typeof supportInteractionDirections)[number];
export type SupportCallDirectionValue = (typeof supportCallDirections)[number];
export type SupportCallDispositionValue = (typeof supportCallDispositions)[number];
export type SupportRecordingConsentValue = (typeof supportRecordingConsents)[number];
export type SupportCaseEventSourceValue = (typeof supportCaseEventSources)[number];
export type SupportConnectorSignatureSchemeValue = (typeof supportConnectorSignatureSchemes)[number];
export type SupportConnectorStatusValue = (typeof supportConnectorStatuses)[number];
export type SupportIntakeReceiptStatusValue = (typeof supportIntakeReceiptStatuses)[number];
export type SupportOutboxStatusValue = (typeof supportOutboxStatuses)[number];
export type SupportSlaMetricValue = (typeof supportSlaMetrics)[number];
export type SupportSlaClockStateValue = (typeof supportSlaClockStates)[number];
export type SupportJobLeaseStatusValue = (typeof supportJobLeaseStatuses)[number];
export type WorkspaceConnectionStatusValue = (typeof workspaceConnectionStatuses)[number];
export type SupportCaseTaskLinkTypeValue = (typeof supportCaseTaskLinkTypes)[number];
export type SupportCaseSignalStatusValue = (typeof supportCaseSignalStatuses)[number];
export type SupportQueueKindValue = (typeof supportQueueKinds)[number];
export type SupportAttentionReasonValue = (typeof supportAttentionReasons)[number];

export const departmentMemberRoleSchema = z.enum(departmentMemberRoles);
export const supportPermissionRoleSchema = z.enum(supportPermissionRoles);
export const supportCredentialScopeSchema = z.enum(supportCredentialScopes);
export const supportCaseSourceChannelSchema = z.enum(supportCaseSourceChannels);
export const supportCasePrioritySchema = z.enum(supportCasePriorities);
export const supportCaseImpactSchema = z.enum(supportCaseImpacts);
export const supportCaseUrgencySchema = z.enum(supportCaseUrgencies);
export const supportCaseStatusSchema = z.enum(supportCaseStatuses);
export const supportCaseResolutionCodeSchema = z.enum(supportCaseResolutionCodes);
export const supportInteractionKindSchema = z.enum(supportInteractionKinds);
export const supportInteractionVisibilitySchema = z.enum(supportInteractionVisibilities);
export const supportInteractionDirectionSchema = z.enum(supportInteractionDirections);
export const supportCallDirectionSchema = z.enum(supportCallDirections);
export const supportCallDispositionSchema = z.enum(supportCallDispositions);
export const supportRecordingConsentSchema = z.enum(supportRecordingConsents);
export const supportCaseEventSourceSchema = z.enum(supportCaseEventSources);
export const supportConnectorSignatureSchemeSchema = z.enum(supportConnectorSignatureSchemes);
export const supportConnectorStatusSchema = z.enum(supportConnectorStatuses);
export const supportIntakeReceiptStatusSchema = z.enum(supportIntakeReceiptStatuses);
export const supportOutboxStatusSchema = z.enum(supportOutboxStatuses);
export const supportSlaMetricSchema = z.enum(supportSlaMetrics);
export const supportSlaClockStateSchema = z.enum(supportSlaClockStates);
export const supportJobLeaseStatusSchema = z.enum(supportJobLeaseStatuses);
export const workspaceConnectionStatusSchema = z.enum(workspaceConnectionStatuses);
export const supportCaseTaskLinkTypeSchema = z.enum(supportCaseTaskLinkTypes);
export const supportCaseSignalStatusSchema = z.enum(supportCaseSignalStatuses);
export const supportQueueKindSchema = z.enum(supportQueueKinds);
export const supportAttentionReasonSchema = z.enum(supportAttentionReasons);

export const supportCaseKeySchema = z.string().trim().regex(/^[A-Z][A-Z0-9]{1,7}-[1-9]\d*$/).max(32);
export const supportCaseTypeKeySchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/);
export const supportDepartmentSlugSchema = z.string().trim().toLowerCase().min(2).max(48).regex(/^[a-z0-9-]+$/);
export const supportCaseVersionSchema = z.coerce.number().int().positive();

export const departmentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: supportDepartmentSlugSchema,
  description: z.string().trim().max(2000).optional(),
  routingSettings: z.record(z.unknown()).optional()
});

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  active: z.boolean().optional(),
  routingSettings: z.record(z.unknown()).nullable().optional()
}).strict();

export const addDepartmentMemberSchema = z.object({
  userId: z.string().uuid(),
  role: departmentMemberRoleSchema.default('MEMBER')
});

export const updateDepartmentMemberSchema = z.object({
  role: departmentMemberRoleSchema.optional(),
  active: z.boolean().optional()
}).strict().refine((value) => value.role !== undefined || value.active !== undefined, {
  message: 'At least one membership field is required'
});

export const setSupportPermissionGrantSchema = z.object({
  userId: z.string().uuid(),
  role: supportPermissionRoleSchema
});

export const setSupportCredentialGrantSchema = z.object({
  credentialId: z.string().uuid(),
  scope: supportCredentialScopeSchema
});

export const supportContactInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().regex(/^\+?\d{7,15}$/).optional(),
  externalCustomerId: z.string().trim().min(1).max(240).optional()
}).refine((value) => value.name !== undefined || value.email !== undefined || value.phone !== undefined || value.externalCustomerId !== undefined, {
  message: 'At least one contact identifier is required'
});

export const createSupportCaseSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(50_000).optional(),
  sourceChannel: supportCaseSourceChannelSchema,
  typeKey: supportCaseTypeKeySchema,
  priority: supportCasePrioritySchema.default('NORMAL'),
  impact: supportCaseImpactSchema.optional(),
  urgency: supportCaseUrgencySchema.optional(),
  contactId: z.string().uuid().optional(),
  contact: supportContactInputSchema.optional(),
  departmentId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional()
}).refine((value) => !(value.contactId && value.contact), {
  message: 'Provide contactId or contact, not both',
  path: ['contact']
});

export const supportCaseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  key: supportCaseKeySchema,
  sequence: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  sourceChannel: supportCaseSourceChannelSchema,
  typeKey: supportCaseTypeKeySchema,
  priority: supportCasePrioritySchema,
  impact: supportCaseImpactSchema.nullable(),
  urgency: supportCaseUrgencySchema.nullable(),
  status: supportCaseStatusSchema,
  waitingReason: z.string().nullable(),
  departmentId: z.string().uuid().nullable(),
  assigneeMembershipId: z.string().uuid().nullable(),
  contactId: z.string().uuid().nullable(),
  nextActionAt: z.string().datetime().nullable(),
  nextSlaDueAt: z.string().datetime().nullable(),
  resolutionCode: supportCaseResolutionCodeSchema.nullable(),
  resolutionSummary: z.string().nullable(),
  receivedAt: z.string().datetime(),
  lastMeaningfulActivityAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const supportCaseListQuerySchema = z.object({
  queue: supportQueueKindSchema.optional(),
  status: z.union([supportCaseStatusSchema, z.array(supportCaseStatusSchema)]).optional(),
  departmentId: z.string().uuid().optional(),
  assigneeMembershipId: z.string().uuid().optional(),
  priority: z.union([supportCasePrioritySchema, z.array(supportCasePrioritySchema)]).optional(),
  sourceChannel: z.union([supportCaseSourceChannelSchema, z.array(supportCaseSourceChannelSchema)]).optional(),
  typeKey: supportCaseTypeKeySchema.optional(),
  attentionReason: supportAttentionReasonSchema.optional(),
  q: z.string().trim().max(200).optional(),
  receivedFrom: z.string().datetime().optional(),
  receivedTo: z.string().datetime().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

/// Route, return to Department Inbox, assign and transfer share one optimistic command. A null
/// assignee means the Department Inbox; a cross-Department transfer requires a non-empty reason.
export const routeSupportCaseSchema = z.object({
  targetDepartmentId: z.string().uuid(),
  targetAssigneeMembershipId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
  baseVersion: supportCaseVersionSchema
});

export const waitOnSupportCaseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('WAITING_ON_CUSTOMER'),
    nextActionAt: z.string().datetime(),
    baseVersion: supportCaseVersionSchema
  }),
  z.object({
    status: z.literal('WAITING_ON_INTERNAL'),
    waitingReason: z.string().trim().min(1).max(1000),
    nextActionAt: z.string().datetime(),
    baseVersion: supportCaseVersionSchema
  })
]);

export const resolveSupportCaseSchema = z.object({
  resolutionCode: supportCaseResolutionCodeSchema,
  resolutionSummary: z.string().trim().min(1).max(10_000),
  duplicateOfCaseId: z.string().uuid().optional(),
  baseVersion: supportCaseVersionSchema
}).superRefine((value, context) => {
  if (value.resolutionCode === 'DUPLICATE' && !value.duplicateOfCaseId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['duplicateOfCaseId'], message: 'Duplicate resolution requires a canonical Case' });
  }
  if (value.resolutionCode !== 'DUPLICATE' && value.duplicateOfCaseId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['duplicateOfCaseId'], message: 'Only duplicate resolution accepts a canonical Case' });
  }
});

export const closeSupportCaseSchema = z.object({
  baseVersion: supportCaseVersionSchema,
  confirmation: z.enum(['CUSTOMER_CONFIRMED', 'POLICY_WINDOW_ELAPSED', 'ADMIN_OVERRIDE']),
  reason: z.string().trim().min(1).max(1000).optional()
});

export const reopenSupportCaseSchema = z.object({
  baseVersion: supportCaseVersionSchema,
  reason: z.string().trim().min(1).max(1000)
});

export const supportInteractionContentInputSchema = z.object({
  body: z.string().min(1).max(100_000),
  format: z.enum(['text/plain', 'text/markdown']).default('text/plain')
});

export const addSupportInteractionSchema = z.object({
  kind: supportInteractionKindSchema,
  visibility: supportInteractionVisibilitySchema,
  channel: supportCaseSourceChannelSchema,
  direction: supportInteractionDirectionSchema,
  contactId: z.string().uuid().optional(),
  occurredAt: z.string().datetime().optional(),
  externalId: z.string().trim().min(1).max(240).optional(),
  content: supportInteractionContentInputSchema.optional(),
  baseVersion: supportCaseVersionSchema
}).superRefine((value, context) => {
  if (value.direction === 'INTERNAL' && value.visibility !== 'INTERNAL') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['visibility'], message: 'Internal interactions must be internal' });
  }
});

export const supportCallDetailInputSchema = z.object({
  direction: supportCallDirectionSchema,
  disposition: supportCallDispositionSchema,
  startedAt: z.string().datetime(),
  answeredAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  durationSeconds: z.coerce.number().int().nonnegative().optional(),
  recordingConsent: supportRecordingConsentSchema.default('UNKNOWN'),
  recordingExists: z.boolean().default(false),
  callbackOwnerId: z.string().uuid().optional(),
  callbackDueAt: z.string().datetime().optional(),
  externalCallId: z.string().trim().min(1).max(240).optional()
}).refine((value) => (value.callbackOwnerId === undefined) === (value.callbackDueAt === undefined), {
  message: 'Callback owner and due time must be supplied together',
  path: ['callbackDueAt']
});

export const createSupportCallSchema = z.object({
  caseId: z.string().uuid().optional(),
  newCase: createSupportCaseSchema.optional(),
  baseVersion: supportCaseVersionSchema.optional(),
  contactId: z.string().uuid().optional(),
  contact: supportContactInputSchema.optional(),
  summary: z.string().trim().min(1).max(10_000),
  internalNotes: z.string().trim().max(50_000).optional(),
  call: supportCallDetailInputSchema
}).superRefine((value, context) => {
  if ((value.caseId === undefined) === (value.newCase === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['caseId'], message: 'Choose an existing Case or create one' });
  }
  if (value.caseId !== undefined && value.baseVersion === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['baseVersion'], message: 'Existing Case calls require the current Case version' });
  }
  if (value.newCase && !value.newCase.idempotencyKey) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['newCase', 'idempotencyKey'], message: 'New Case calls require an idempotency key' });
  }
});

export const createSupportIntakeConnectorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourceKey: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/),
  sourceChannel: supportCaseSourceChannelSchema,
  signatureScheme: supportConnectorSignatureSchemeSchema.default('HMAC_SHA256'),
  replayWindowSeconds: z.coerce.number().int().min(30).max(3600).default(300),
  maxPayloadBytes: z.coerce.number().int().min(1024).max(10_485_760).default(1_048_576),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(10_000).default(120),
  config: z.record(z.unknown()).optional()
});

export const supportBusinessPeriodSchema = z.object({
  dayOfWeek: z.coerce.number().int().min(1).max(7),
  startMinute: z.coerce.number().int().min(0).max(1439),
  endMinute: z.coerce.number().int().min(1).max(1440)
}).refine((value) => value.startMinute < value.endMinute, {
  message: 'Business period must end after it starts',
  path: ['endMinute']
});

export const createSupportBusinessCalendarSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(120),
  departmentId: z.string().uuid().optional(),
  periods: z.array(supportBusinessPeriodSchema).max(64),
  holidays: z.array(z.object({
    date: z.string().date(),
    name: z.string().trim().min(1).max(160),
    working: z.boolean().default(false)
  })).max(500).default([])
});

export const createSupportSlaPolicySchema = z.object({
  calendarId: z.string().uuid(),
  policyKey: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().trim().min(1).max(120),
  version: z.coerce.number().int().positive(),
  priority: z.coerce.number().int().nonnegative().default(100),
  conditions: z.record(z.unknown()),
  targets: z.record(z.unknown()),
  pauseRules: z.record(z.unknown()),
  effectiveFrom: z.string().datetime(),
  effectiveUntil: z.string().datetime().optional()
});

export const createWorkspaceConnectionSchema = z.object({
  teamWorkspaceId: z.string().uuid()
});

export const approveWorkspaceConnectionSchema = z.object({
  side: z.enum(['SUPPORT', 'TEAM'])
});

export const revokeWorkspaceConnectionSchema = z.object({
  reason: z.string().trim().min(1).max(1000)
});

export const createDepartmentWorkTargetSchema = z.object({
  connectionId: z.string().uuid(),
  departmentId: z.string().uuid(),
  projectId: z.string().uuid(),
  allowCreateTasks: z.boolean().default(false),
  allowLinkTasks: z.boolean().default(true)
}).refine((value) => value.allowCreateTasks || value.allowLinkTasks, {
  message: 'At least one target capability is required'
});

const supportHandoffSchema = z.object({
  workTargetId: z.string().uuid(),
  relationType: supportCaseTaskLinkTypeSchema.default('FIX_WORK'),
  handoffTitle: z.string().trim().min(1).max(240),
  handoffSummary: z.string().trim().min(1).max(20_000),
  baseVersion: supportCaseVersionSchema,
  idempotencyKey: z.string().trim().min(8).max(200)
});

export const linkSupportCaseToTaskSchema = supportHandoffSchema.extend({
  taskId: z.string().uuid()
});

export const createLinkedTaskFromSupportCaseSchema = supportHandoffSchema.extend({
  parentTaskId: z.string().uuid().optional(),
  taskTitle: z.string().trim().min(1).max(240),
  taskDescription: z.string().trim().max(50_000).optional(),
  taskPriority: z.enum(['NO_PRIORITY', 'LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('NO_PRIORITY')
});

export const unlinkSupportCaseTaskSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  baseVersion: supportCaseVersionSchema
});
