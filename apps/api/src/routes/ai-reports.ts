import type { FastifyInstance } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { prisma, type IntegrationAccount, type Prisma } from '@taskara/db';
import { priorityLabel, statusLabel } from '@taskara/shared';
import { z } from 'zod';
import { config } from '../config';
import { getRequestActor, isWorkspaceAdminRole, requireWorkspaceAdmin } from '../services/actor';
import { createAnnouncement } from '../services/announcements';
import { HttpError } from '../services/http';
import { canAccessMeeting, createMeeting, resolveMeetingAccessScope } from '../services/meetings';
import {
  projectWhereForAccess,
  resolveWorkspaceAccess,
  taskWhereForAccess,
  teamWhereForAccess,
  type WorkspaceAccess
} from '../services/team-access';
import {
  addTaskProgressStartedAt,
  createTask,
  findTaskByIdOrKey,
  serializeTaskForResponse,
  updateTask
} from '../services/tasks';

const AI_INTEGRATION_PROVIDER = 'CODEX' as const;
const AI_INTEGRATION_EXTERNAL_ID = 'task-report-ai';
const AI_INTEGRATION_EXTERNAL_ID_PREFIX = 'task-report-ai:key:';
const OPENROUTER_PROVIDER = 'OPENROUTER' as const;
const API_KEY_HASH_PREFIX = 'sha256$';
const API_KEY_CIPHER_PREFIX = 'enc:v1:';
type ReportAiProvider = typeof OPENROUTER_PROVIDER;

const aiSettingsUpdateSchema = z.object({
  credentialId: z.string().uuid().optional(),
  createNew: z.boolean().optional(),
  setActive: z.boolean().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  provider: z.literal(OPENROUTER_PROVIDER).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  apiKey: z.preprocess(
    (value) => {
      if (value === null) return null;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    },
    z.string().min(8).max(500).nullable().optional()
  ),
  defaultContext: z.preprocess(
    (value) => {
      if (value === null) return null;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    },
    z.string().max(8000).nullable().optional()
  )
});

const aiSettingsSelectSchema = z.object({
  credentialId: z.string().uuid()
});

const aiSettingsTestSchema = z.object({
  credentialId: z.string().uuid().optional(),
  provider: z.literal(OPENROUTER_PROVIDER).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  apiKey: z.preprocess(
    (value) => {
      if (value === null) return null;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    },
    z.string().min(8).max(500).nullable().optional()
  )
});

const aiSettingsDeleteParamsSchema = z.object({
  credentialId: z.string().uuid()
});

const reportAnalyzeInputSchema = z.object({
  request: z.string().trim().min(3).max(4000)
});

const taskTextRefineInputSchema = z.object({
  title: z.string().max(300).optional().default(''),
  description: z.string().max(20000).optional().default(''),
});

const taskTextRefineOutputSchema = z.object({
  titleSuggestion: z.string().trim().min(1).max(300).nullable().optional(),
  descriptionSuggestion: z.string().trim().min(1).max(20000).nullable().optional(),
  summarySuggestion: z.string().trim().min(1).max(4000).nullable().optional(),
});

const TASK_STATUS_VALUES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELED'] as const;
const TASK_PRIORITY_VALUES = ['NO_PRIORITY', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const MEETING_STATUS_VALUES = ['PLANNED', 'HELD', 'CANCELED', 'ARCHIVED'] as const;
const ANNOUNCEMENT_STATUS_VALUES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
const assistantActionValues = [
  'create_task',
  'update_task',
  'query_tasks',
  'bulk_update_tasks',
  'create_meeting',
  'query_meetings',
  'create_announcement',
  'query_announcements',
  'clarify',
  'unsupported'
] as const;
const assistantOperationValues = [
  'create_task',
  'update_task',
  'query_tasks',
  'bulk_update_tasks',
  'create_meeting',
  'query_meetings',
  'create_announcement',
  'query_announcements'
] as const;
const assistantQueryModeValues = [
  'latest_task_for_user',
  'latest_done_task_for_user',
  'latest_done_task_for_each_user',
  'search_tasks'
] as const;

const aiAssistantMessageSchema = z.object({
  message: z.string().trim().max(4000).default(''),
  history: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().trim().min(1).max(2000)
    })
  ).max(30).default([]),
  audio: z.object({
    data: z.string().min(8),
    mimeType: z.string().trim().min(3).max(120),
    model: z.string().trim().min(1).max(120).optional(),
    language: z.string().trim().min(2).max(8).optional()
  }).optional(),
  clientNow: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().trim().min(1).max(80).optional()
}).superRefine((value, ctx) => {
  if (!value.message.trim() && !value.audio) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['message'],
      message: 'Message or audio is required'
    });
  }
});

const assistantTaskDraftSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  projectHint: z.string().trim().min(1).max(160).nullable().optional(),
  title: z.string().trim().min(1).max(300).nullable().optional(),
  description: z.string().trim().max(15000).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  assigneeHint: z.string().trim().min(1).max(160).nullable().optional(),
  status: z.enum(TASK_STATUS_VALUES).nullable().optional(),
  priority: z.enum(TASK_PRIORITY_VALUES).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(12).optional().default([])
});

const assistantTaskUpdateSchema = z.object({
  taskKeyOrId: z.string().trim().min(1).max(120).nullable().optional(),
  taskHint: z.string().trim().min(1).max(160).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  projectHint: z.string().trim().min(1).max(160).nullable().optional(),
  title: z.string().trim().min(1).max(300).nullable().optional(),
  description: z.string().trim().max(15000).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  assigneeHint: z.string().trim().min(1).max(160).nullable().optional(),
  unassign: z.boolean().optional(),
  status: z.enum(TASK_STATUS_VALUES).nullable().optional(),
  priority: z.enum(TASK_PRIORITY_VALUES).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  clearDueAt: z.boolean().optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(12).optional()
});

const assistantTaskQuerySchema = z.object({
  mode: z.enum(assistantQueryModeValues).optional().default('latest_task_for_user'),
  projectId: z.string().uuid().nullable().optional(),
  projectHint: z.string().trim().min(1).max(160).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  assigneeHint: z.string().trim().min(1).max(160).nullable().optional(),
  statuses: z.array(z.enum(TASK_STATUS_VALUES)).max(TASK_STATUS_VALUES.length).optional().default([]),
  priorities: z.array(z.enum(TASK_PRIORITY_VALUES)).max(TASK_PRIORITY_VALUES.length).optional().default([]),
  keywords: z.array(z.string().trim().min(1).max(80)).max(6).optional().default([]),
  limit: z.number().int().min(1).max(20).optional().default(5)
});

const assistantBulkUpdateSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  projectHint: z.string().trim().min(1).max(160).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  assigneeHint: z.string().trim().min(1).max(160).nullable().optional(),
  statuses: z.array(z.enum(TASK_STATUS_VALUES)).max(TASK_STATUS_VALUES.length).optional().default([]),
  priorities: z.array(z.enum(TASK_PRIORITY_VALUES)).max(TASK_PRIORITY_VALUES.length).optional().default([]),
  keywords: z.array(z.string().trim().min(1).max(80)).max(6).optional().default([]),
  limit: z.number().int().min(1).max(100).optional().default(30),
  setStatus: z.enum(TASK_STATUS_VALUES).nullable().optional(),
  setPriority: z.enum(TASK_PRIORITY_VALUES).nullable().optional(),
  setAssigneeId: z.string().uuid().nullable().optional(),
  setAssigneeHint: z.string().trim().min(1).max(160).nullable().optional(),
  clearDueAt: z.boolean().optional(),
  setDueAt: z.string().datetime({ offset: true }).nullable().optional(),
  addLabels: z.array(z.string().trim().min(1).max(40)).max(12).optional().default([]),
  removeLabels: z.array(z.string().trim().min(1).max(40)).max(12).optional().default([])
});

const assistantMeetingDraftSchema = z.object({
  title: z.string().trim().min(1).max(300).nullable().optional(),
  description: z.string().trim().max(30000).nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  teamHint: z.string().trim().min(1).max(160).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  projectHint: z.string().trim().min(1).max(160).nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  ownerHint: z.string().trim().min(1).max(160).nullable().optional(),
  participantIds: z.array(z.string().uuid()).max(100).optional().default([]),
  participantHints: z.array(z.string().trim().min(1).max(160)).max(100).optional().default([]),
  status: z.enum(MEETING_STATUS_VALUES).nullable().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  heldAt: z.string().datetime({ offset: true }).nullable().optional()
});

const assistantMeetingQuerySchema = z.object({
  mode: z.enum(['latest_for_me', 'upcoming', 'search_meetings']).optional().default('latest_for_me'),
  teamId: z.string().uuid().nullable().optional(),
  teamHint: z.string().trim().min(1).max(160).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  projectHint: z.string().trim().min(1).max(160).nullable().optional(),
  statuses: z.array(z.enum(MEETING_STATUS_VALUES)).max(MEETING_STATUS_VALUES.length).optional().default([]),
  keywords: z.array(z.string().trim().min(1).max(80)).max(6).optional().default([]),
  mine: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(20).optional().default(5)
});

const assistantAnnouncementDraftSchema = z.object({
  title: z.string().trim().min(1).max(300).nullable().optional(),
  body: z.string().trim().max(15000).nullable().optional(),
  publish: z.boolean().optional().default(false),
  recipientIds: z.array(z.string().uuid()).max(300).optional().default([]),
  recipientHints: z.array(z.string().trim().min(1).max(160)).max(300).optional().default([])
});

const assistantAnnouncementQuerySchema = z.object({
  mode: z.enum(['latest_for_me', 'latest_published', 'search_announcements']).optional().default('latest_for_me'),
  statuses: z.array(z.enum(ANNOUNCEMENT_STATUS_VALUES)).max(ANNOUNCEMENT_STATUS_VALUES.length).optional().default([]),
  unread: z.boolean().optional().default(false),
  keywords: z.array(z.string().trim().min(1).max(80)).max(6).optional().default([]),
  limit: z.number().int().min(1).max(20).optional().default(5)
});

const assistantActionStepSchema = z.object({
  operation: z.enum(assistantOperationValues),
  task: assistantTaskDraftSchema.nullable().optional(),
  update: assistantTaskUpdateSchema.nullable().optional(),
  query: assistantTaskQuerySchema.nullable().optional(),
  bulk: assistantBulkUpdateSchema.nullable().optional(),
  meeting: assistantMeetingDraftSchema.nullable().optional(),
  meetingsQuery: assistantMeetingQuerySchema.nullable().optional(),
  announcement: assistantAnnouncementDraftSchema.nullable().optional(),
  announcementsQuery: assistantAnnouncementQuerySchema.nullable().optional()
});

const assistantCommandPlanSchema = z.object({
  action: z.enum(assistantActionValues),
  response: z.string().trim().min(1).max(1000).nullable().optional(),
  actions: z.array(assistantActionStepSchema).max(20).optional().default([]),
  task: assistantTaskDraftSchema.nullable().optional(),
  update: assistantTaskUpdateSchema.nullable().optional(),
  query: assistantTaskQuerySchema.nullable().optional(),
  bulk: assistantBulkUpdateSchema.nullable().optional(),
  meeting: assistantMeetingDraftSchema.nullable().optional(),
  meetingsQuery: assistantMeetingQuerySchema.nullable().optional(),
  announcement: assistantAnnouncementDraftSchema.nullable().optional(),
  announcementsQuery: assistantAnnouncementQuerySchema.nullable().optional()
});

const reportQueryPlanSchema = z.object({
  teamSlug: z.string().trim().min(1).max(80).nullable().optional(),
  relativeDays: z.number().int().min(1).max(365).nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  assigneeHint: z.string().trim().min(1).max(120).nullable().optional(),
  reporterHint: z.string().trim().min(1).max(120).nullable().optional(),
  statuses: z.array(z.enum(TASK_STATUS_VALUES)).max(TASK_STATUS_VALUES.length).optional().default([]),
  priorities: z.array(z.enum(TASK_PRIORITY_VALUES)).max(TASK_PRIORITY_VALUES.length).optional().default([]),
  keywords: z.array(z.string().trim().min(1).max(80)).max(8).optional().default([]),
  guidance: z.string().trim().min(1).max(1000).nullable().optional()
});

type ReportQueryPlan = z.infer<typeof reportQueryPlanSchema>;

interface AiCredentialItem {
  credentialId: string;
  name: string;
  provider: ReportAiProvider;
  model: string;
  hasApiKey: boolean;
  maskedKey: string | null;
  defaultContext: string | null;
  isActive: boolean;
  updatedAt: string;
}

interface AiWorkspaceSettings {
  activeCredentialId: string | null;
  provider: ReportAiProvider;
  model: string;
  hasApiKey: boolean;
  maskedKey: string | null;
  usage: {
    totalRequests: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    costedRequests: number;
    lastRequestAt: string | null;
  };
  defaultContext: string | null;
  updatedAt: string | null;
  items: AiCredentialItem[];
}

interface ReportDateRange {
  startsAt: Date;
  endsAt: Date;
}

interface AiUsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

interface AiAnalysisResult {
  content: string;
  usage: AiUsageSnapshot;
}

type AssistantCommandPlan = z.infer<typeof assistantCommandPlanSchema>;
type AssistantActionStep = z.infer<typeof assistantActionStepSchema>;
type AssistantTaskDraft = z.infer<typeof assistantTaskDraftSchema>;
type AssistantTaskUpdate = z.infer<typeof assistantTaskUpdateSchema>;
type AssistantTaskQuery = z.infer<typeof assistantTaskQuerySchema>;
type AssistantBulkUpdate = z.infer<typeof assistantBulkUpdateSchema>;
type AssistantMeetingDraft = z.infer<typeof assistantMeetingDraftSchema>;
type AssistantMeetingQuery = z.infer<typeof assistantMeetingQuerySchema>;
type AssistantAnnouncementDraft = z.infer<typeof assistantAnnouncementDraftSchema>;
type AssistantAnnouncementQuery = z.infer<typeof assistantAnnouncementQuerySchema>;
type AssistantResultStatus = 'completed' | 'blocked' | 'needs_clarification' | 'unsupported';

interface AssistantProjectContext {
  index: number;
  id: string;
  name: string;
  keyPrefix: string;
  teamId: string | null;
  teamName: string | null;
  teamSlug: string | null;
}

interface AssistantTeamContext {
  index: number;
  id: string;
  name: string;
  slug: string;
}

interface AssistantUserContext {
  index: number;
  id: string;
  name: string;
  email: string;
  teamIds: string[];
}

interface AssistantTaskContext {
  index: number;
  id: string;
  key: string;
  title: string;
  projectId: string;
}

interface AssistantContext {
  teams: AssistantTeamContext[];
  projects: AssistantProjectContext[];
  users: AssistantUserContext[];
  recentTasks: AssistantTaskContext[];
  access: WorkspaceAccess;
}

interface ResolvedQueryFilters {
  request: string;
  teamSlug: string | null;
  teamName: string | null;
  assigneeHint: string | null;
  reporterHint: string | null;
  statuses: string[];
  priorities: string[];
  keywords: string[];
  guidance: string | null;
}

function defaultModelForProvider(provider: ReportAiProvider): string {
  return provider === OPENROUTER_PROVIDER ? 'x-ai/grok-4.1-fast' : 'x-ai/grok-4.1-fast';
}

function defaultCredentialName(provider: ReportAiProvider, index: number): string {
  return `${provider} Key ${index}`;
}

function normalizeOpenRouterModel(rawModel: string): string {
  const model = rawModel.trim();
  if (!model) return defaultModelForProvider(OPENROUTER_PROVIDER);

  if (!model.includes('/')) {
    if (model.startsWith('deepseek-')) return `deepseek/${model}`;
    if (model.startsWith('grok-')) return `x-ai/${model}`;
    if (model.startsWith('claude-')) return `anthropic/${model}`;
    if (model.startsWith('gemini-')) return `google/${model}`;
    if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
      return `openai/${model}`;
    }
  }

  return model;
}

function configObject(config: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegativeInt(value: unknown): number {
  const numeric = numberOrNull(value);
  if (numeric === null || numeric < 0) return 0;
  return Math.floor(numeric);
}

function nonNegativeFloat(value: unknown): number {
  const numeric = numberOrNull(value);
  if (numeric === null || numeric < 0) return 0;
  return numeric;
}

function extractOpenRouterErrorMessage(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const errorRaw = payload.error;
  if (!errorRaw || typeof errorRaw !== 'object' || Array.isArray(errorRaw)) return null;
  const message = (errorRaw as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim().length ? message.trim() : null;
}

function extractOpenRouterContent(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const choicesRaw = payload.choices;
  if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) return null;
  const firstChoice = choicesRaw[0];
  if (!firstChoice || typeof firstChoice !== 'object' || Array.isArray(firstChoice)) return null;
  const messageRaw = (firstChoice as Record<string, unknown>).message;
  if (!messageRaw || typeof messageRaw !== 'object' || Array.isArray(messageRaw)) return null;
  const content = (messageRaw as Record<string, unknown>).content;
  return typeof content === 'string' && content.trim().length ? content.trim() : null;
}

function normalizeAiConfig(config: Prisma.JsonValue | null | undefined): {
  provider: ReportAiProvider;
  model: string;
  name: string | null;
  keyPreview: string | null;
  defaultContext: string | null;
  active: boolean;
} {
  const raw = configObject(config);
  const modelRaw = raw.model;
  const nameRaw = raw.name;
  const keyPreviewRaw = raw.keyPreview;
  const defaultContextRaw = raw.defaultContext;
  const activeRaw = raw.active;

  const normalizedProvider: ReportAiProvider = OPENROUTER_PROVIDER;

  const normalizedModel = typeof modelRaw === 'string' && modelRaw.trim().length
    ? normalizeOpenRouterModel(modelRaw)
    : defaultModelForProvider(normalizedProvider);

  const normalizedName = typeof nameRaw === 'string' && nameRaw.trim().length ? nameRaw.trim() : null;
  const normalizedKeyPreview =
    typeof keyPreviewRaw === 'string' && keyPreviewRaw.trim().length
      ? keyPreviewRaw.trim()
      : null;
  const normalizedDefaultContext =
    typeof defaultContextRaw === 'string' && defaultContextRaw.trim().length
      ? defaultContextRaw.trim()
      : null;

  return {
    provider: normalizedProvider,
    model: normalizedModel,
    name: normalizedName,
    keyPreview: normalizedKeyPreview,
    defaultContext: normalizedDefaultContext,
    active: activeRaw === true
  };
}

function maskKey(apiKey: string | null): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 6) return `${apiKey.slice(0, 2)}…${apiKey.slice(-1)}`;
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}

function isHashedApiKey(value: string | null | undefined): boolean {
  return Boolean(value && value.startsWith(API_KEY_HASH_PREFIX));
}

function hashApiKey(apiKey: string): string {
  return `${API_KEY_HASH_PREFIX}${createHash('sha256').update(apiKey).digest('base64url')}`;
}

function resolveApiCipherSecret(): string {
  const secret = config.TASKARA_AI_CREDENTIAL_SECRET || config.DATABASE_URL;
  if (!secret) throw new HttpError(500, 'AI credential secret is not configured');
  return secret;
}

function encryptApiKey(apiKey: string): string {
  const key = createHash('sha256').update(resolveApiCipherSecret()).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${API_KEY_CIPHER_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptApiKey(cipherPayload: string): string {
  if (!cipherPayload.startsWith(API_KEY_CIPHER_PREFIX)) {
    throw new HttpError(500, 'Stored AI API key format is invalid');
  }

  const encoded = cipherPayload.slice(API_KEY_CIPHER_PREFIX.length);
  const [ivPart, tagPart, dataPart] = encoded.split('.');
  if (!ivPart || !tagPart || !dataPart) {
    throw new HttpError(500, 'Stored AI API key payload is invalid');
  }

  const key = createHash('sha256').update(resolveApiCipherSecret()).digest();
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const data = Buffer.from(dataPart, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  if (!plaintext.trim()) throw new HttpError(500, 'Stored AI API key is empty');
  return plaintext;
}

function accountHasApiKey(account: IntegrationAccount | null | undefined): boolean {
  if (!account) return false;
  const raw = configObject(account.config);
  if (typeof raw.apiKeyCipher === 'string' && raw.apiKeyCipher.trim().length) return true;
  return Boolean(account.accessToken && !isHashedApiKey(account.accessToken));
}

function accountMaskedKey(account: IntegrationAccount | null | undefined): string | null {
  if (!account) return null;
  const cfg = normalizeAiConfig(account.config);
  if (cfg.keyPreview) return cfg.keyPreview;
  if (account.accessToken && !isHashedApiKey(account.accessToken)) return maskKey(account.accessToken);
  return null;
}

function resolveStoredApiKey(account: IntegrationAccount | null | undefined): string | null {
  if (!account) return null;
  const raw = configObject(account.config);
  const encrypted = typeof raw.apiKeyCipher === 'string' && raw.apiKeyCipher.trim().length ? raw.apiKeyCipher.trim() : null;
  if (encrypted) return decryptApiKey(encrypted);
  if (account.accessToken && !isHashedApiKey(account.accessToken)) return account.accessToken;
  return null;
}

function extractUsageStats(config: Prisma.JsonValue | null | undefined): AiWorkspaceSettings['usage'] {
  const raw = configObject(config);
  const usageRaw = raw.usageStats;
  const usage = usageRaw && typeof usageRaw === 'object' && !Array.isArray(usageRaw)
    ? usageRaw as Record<string, unknown>
    : {};

  const lastRequestAtRaw = usage.lastRequestAt;
  const lastRequestAt = typeof lastRequestAtRaw === 'string' && lastRequestAtRaw.trim().length
    ? lastRequestAtRaw.trim()
    : null;

  return {
    totalRequests: nonNegativeInt(usage.totalRequests),
    totalPromptTokens: nonNegativeInt(usage.totalPromptTokens),
    totalCompletionTokens: nonNegativeInt(usage.totalCompletionTokens),
    totalTokens: nonNegativeInt(usage.totalTokens),
    totalCostUsd: nonNegativeFloat(usage.totalCostUsd),
    costedRequests: nonNegativeInt(usage.costedRequests),
    lastRequestAt,
  };
}

function mergeUsageStats(
  current: AiWorkspaceSettings['usage'],
  snapshot: AiUsageSnapshot
): AiWorkspaceSettings['usage'] {
  const hasCost = snapshot.costUsd !== null && Number.isFinite(snapshot.costUsd) && snapshot.costUsd >= 0;
  return {
    totalRequests: current.totalRequests + 1,
    totalPromptTokens: current.totalPromptTokens + Math.max(0, Math.floor(snapshot.promptTokens)),
    totalCompletionTokens: current.totalCompletionTokens + Math.max(0, Math.floor(snapshot.completionTokens)),
    totalTokens: current.totalTokens + Math.max(0, Math.floor(snapshot.totalTokens)),
    totalCostUsd: current.totalCostUsd + (hasCost ? snapshot.costUsd || 0 : 0),
    costedRequests: current.costedRequests + (hasCost ? 1 : 0),
    lastRequestAt: new Date().toISOString(),
  };
}

function accumulateUsageStats(
  current: AiWorkspaceSettings['usage'],
  next: AiWorkspaceSettings['usage']
): AiWorkspaceSettings['usage'] {
  let lastRequestAt = current.lastRequestAt;
  if (next.lastRequestAt) {
    if (!lastRequestAt) {
      lastRequestAt = next.lastRequestAt;
    } else {
      const currentDate = new Date(lastRequestAt);
      const nextDate = new Date(next.lastRequestAt);
      if (!Number.isNaN(nextDate.getTime()) && (Number.isNaN(currentDate.getTime()) || nextDate > currentDate)) {
        lastRequestAt = next.lastRequestAt;
      }
    }
  }

  return {
    totalRequests: current.totalRequests + next.totalRequests,
    totalPromptTokens: current.totalPromptTokens + next.totalPromptTokens,
    totalCompletionTokens: current.totalCompletionTokens + next.totalCompletionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    totalCostUsd: current.totalCostUsd + next.totalCostUsd,
    costedRequests: current.costedRequests + next.costedRequests,
    lastRequestAt
  };
}

function aggregateUsageStats(accounts: IntegrationAccount[]): AiWorkspaceSettings['usage'] {
  return accounts.reduce<AiWorkspaceSettings['usage']>(
    (aggregate, account) => accumulateUsageStats(aggregate, extractUsageStats(account.config)),
    {
      totalRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      costedRequests: 0,
      lastRequestAt: null
    }
  );
}

async function recordUsageStats(credentialId: string, snapshot: AiUsageSnapshot): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "IntegrationAccount" WHERE "id" = ${credentialId}::uuid FOR UPDATE`;
    const account = await tx.integrationAccount.findUnique({ where: { id: credentialId } });
    if (!account) return;
    const raw = configObject(account.config);
    const current = extractUsageStats(account.config);
    const next = mergeUsageStats(current, snapshot);
    await tx.integrationAccount.update({
      where: { id: credentialId },
      data: {
        config: {
          ...raw,
          usageStats: next,
        },
      },
    });
  });
}

function isAiCredentialExternalId(externalId: string | null): boolean {
  if (!externalId) return false;
  return externalId === AI_INTEGRATION_EXTERNAL_ID || externalId.startsWith(AI_INTEGRATION_EXTERNAL_ID_PREFIX);
}

function isSoftDeletedCredential(config: Prisma.JsonValue | null | undefined): boolean {
  const raw = configObject(config);
  return Boolean(raw.deletedAt);
}

function filterActiveCredentials(accounts: IntegrationAccount[]): IntegrationAccount[] {
  return accounts.filter((account) => isAiCredentialExternalId(account.externalId) && !isSoftDeletedCredential(account.config));
}

async function loadAiCredentialAccounts(workspaceId: string): Promise<IntegrationAccount[]> {
  const accounts = await prisma.integrationAccount.findMany({
    where: {
      workspaceId,
      provider: AI_INTEGRATION_PROVIDER
    },
    orderBy: [{ updatedAt: 'desc' }]
  });

  return filterActiveCredentials(accounts);
}

function resolveActiveCredential(accounts: IntegrationAccount[]): IntegrationAccount | null {
  if (accounts.length === 0) return null;
  const markedActive = accounts.find((account) => normalizeAiConfig(account.config).active);
  return markedActive || accounts[0] || null;
}

function serializeWorkspaceSettings(accounts: IntegrationAccount[]): AiWorkspaceSettings {
  const active = resolveActiveCredential(accounts);
  const activeConfig = normalizeAiConfig(active?.config);
  const sorted = [...accounts].sort((a, b) => {
    const aActive = normalizeAiConfig(a.config).active;
    const bActive = normalizeAiConfig(b.config).active;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });

  const items = sorted.map((account, index) => {
    const cfg = normalizeAiConfig(account.config);
    return {
      credentialId: account.id,
      name: cfg.name || defaultCredentialName(cfg.provider, index + 1),
      provider: cfg.provider,
      model: cfg.model,
      hasApiKey: accountHasApiKey(account),
      maskedKey: accountMaskedKey(account),
      defaultContext: cfg.defaultContext,
      isActive: active?.id === account.id,
      updatedAt: account.updatedAt.toISOString()
    } satisfies AiCredentialItem;
  });

  return {
    activeCredentialId: active?.id || null,
    provider: activeConfig.provider,
    model: activeConfig.model,
    hasApiKey: accountHasApiKey(active),
    maskedKey: accountMaskedKey(active),
    usage: aggregateUsageStats(accounts),
    defaultContext: activeConfig.defaultContext,
    updatedAt: active ? active.updatedAt.toISOString() : null,
    items
  };
}

async function setActiveCredential(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  credentialId: string
): Promise<void> {
  const accounts = await tx.integrationAccount.findMany({
    where: {
      workspaceId,
      provider: AI_INTEGRATION_PROVIDER
    }
  });

  const candidates = filterActiveCredentials(accounts);

  for (const account of candidates) {
    const raw = configObject(account.config);
    await tx.integrationAccount.update({
      where: { id: account.id },
      data: {
        config: {
          ...raw,
          active: account.id === credentialId
        }
      }
    });
  }
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u064A\u06CC]/g, 'ی')
    .replace(/[\u0643\u06A9]/g, 'ک')
    .replace(/[\u200c\u200f\u200e]/g, '')
    .replace(/[^\p{L}\p{N}@._-]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('fa-IR');
}

function parseStatusHints(query: string): Array<(typeof TASK_STATUS_VALUES)[number]> {
  const text = normalizeSearchText(query);
  const hits: Array<(typeof TASK_STATUS_VALUES)[number]> = [];
  const add = (value: (typeof TASK_STATUS_VALUES)[number]) => {
    if (!hits.includes(value)) hits.push(value);
  };

  if (/(blocked|مسدود|گیر|گلوگاه)/i.test(text)) add('BLOCKED');
  if (/(done|completed|انجام|بسته|تمام)/i.test(text)) add('DONE');
  if (/(todo|باز|انجام نشده)/i.test(text)) add('TODO');
  if (/(review|بازبینی|بررسی)/i.test(text)) add('IN_REVIEW');
  if (/(progress|در حال انجام|in progress)/i.test(text)) add('IN_PROGRESS');
  if (/(backlog|بک لاگ)/i.test(text)) add('BACKLOG');
  if (/(cancel|لغو)/i.test(text)) add('CANCELED');
  return hits;
}

function parsePriorityHints(query: string): Array<(typeof TASK_PRIORITY_VALUES)[number]> {
  const text = normalizeSearchText(query);
  const hits: Array<(typeof TASK_PRIORITY_VALUES)[number]> = [];
  const add = (value: (typeof TASK_PRIORITY_VALUES)[number]) => {
    if (!hits.includes(value)) hits.push(value);
  };

  if (/(urgent|فوری)/i.test(text)) add('URGENT');
  if (/(high|بالا)/i.test(text)) add('HIGH');
  if (/(medium|متوسط)/i.test(text)) add('MEDIUM');
  if (/(low|پایین)/i.test(text)) add('LOW');
  if (/(no priority|بدون اولویت)/i.test(text)) add('NO_PRIORITY');
  return hits;
}

function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], trimmed];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const source = candidate.trim();
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] !== '{') continue;
      let depth = 0;
      for (let j = i; j < source.length; j += 1) {
        if (source[j] === '{') depth += 1;
        if (source[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            const slice = source.slice(i, j + 1);
            try {
              const parsed = JSON.parse(slice) as unknown;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
              }
            } catch {
              // Ignore parsing errors and keep scanning.
            }
          }
        }
      }
    }
  }

  return null;
}

function sanitizeSuggestionText(
  value: string | null | undefined,
  maxLength: number,
  originalValue: string
): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return null;
  const cropped = cleaned.slice(0, maxLength).trim();
  if (!cropped) return null;
  if (normalizeSearchText(cropped) === normalizeSearchText(originalValue.trim())) return null;
  return cropped;
}

function resolveDateRangeFromPlan(plan: ReportQueryPlan): ReportDateRange {
  const now = new Date();
  const fallbackDays = plan.relativeDays && Number.isFinite(plan.relativeDays) ? plan.relativeDays : 30;
  const days = Math.max(1, Math.min(365, Math.floor(fallbackDays)));

  const endsAt = plan.endsAt ? new Date(plan.endsAt) : now;
  const startsAt = plan.startsAt ? new Date(plan.startsAt) : new Date(endsAt.getTime() - days * 24 * 60 * 60 * 1000);

  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
    const safeEndsAt = now;
    const safeStartsAt = new Date(safeEndsAt.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { startsAt: safeStartsAt, endsAt: safeEndsAt };
  }

  return { startsAt, endsAt };
}

function fallbackQueryPlan(requestText: string): ReportQueryPlan {
  return {
    teamSlug: null,
    relativeDays: 30,
    assigneeHint: null,
    reporterHint: null,
    statuses: parseStatusHints(requestText),
    priorities: parsePriorityHints(requestText),
    keywords: [],
    guidance: requestText.slice(0, 1000)
  };
}

async function requestQueryPlan(params: {
  provider: ReportAiProvider;
  apiKey: string;
  model: string;
  requestText: string;
  teams: Array<{ slug: string; name: string }>;
}): Promise<{ plan: ReportQueryPlan; usage: AiUsageSnapshot | null }> {
  const teamsText = params.teams.length
    ? params.teams.map((team) => `- ${team.slug} | ${team.name}`).join('\n')
    : '- (no teams)';

  const planningPrompt = [
    'در نقش planner عمل کن و فقط JSON معتبر برگردان.',
    'هدف: از متن کاربر، فیلترهای لازم برای گزارش تسک را استخراج کن.',
    'مقادیر status فقط از این لیست باشند:',
    TASK_STATUS_VALUES.join(', '),
    'مقادیر priority فقط از این لیست باشند:',
    TASK_PRIORITY_VALUES.join(', '),
    'teamSlug فقط از اسلاگ‌های زیر انتخاب شود، و اگر معلوم نبود null بگذار:',
    teamsText,
    '',
    'فرمت خروجی JSON:',
    '{',
    '  "teamSlug": string|null,',
    '  "relativeDays": number|null,',
    '  "startsAt": string|null,',
    '  "endsAt": string|null,',
    '  "assigneeHint": string|null,',
    '  "reporterHint": string|null,',
    `  "statuses": string[], // subset of ${TASK_STATUS_VALUES.join(', ')}`,
    `  "priorities": string[], // subset of ${TASK_PRIORITY_VALUES.join(', ')}`,
    '  "keywords": string[],',
    '  "guidance": string|null',
    '}',
    '',
    'قواعد:',
    '1) اگر بازه زمانی مشخص نبود relativeDays=30 بگذار.',
    '2) اگر تاریخ absolute تشخیص دادی startsAt/endsAt را ISO 8601 با timezone بده.',
    '3) اگر چیزی قطعی نبود null یا آرایه خالی بده.',
    '4) فقط JSON بده و هیچ متن اضافی نده.',
    '',
    `متن کاربر: ${params.requestText}`
  ].join('\n');

  try {
    const planningResult = await generateAnalysis(
      params.provider,
      params.apiKey,
      params.model,
      planningPrompt,
      null
    );

    const parsedJson = extractFirstJsonObject(planningResult.content);
    if (!parsedJson) {
      return { plan: fallbackQueryPlan(params.requestText), usage: planningResult.usage };
    }

    const parsedPlan = reportQueryPlanSchema.parse(parsedJson);
    return { plan: parsedPlan, usage: planningResult.usage };
  } catch {
    return { plan: fallbackQueryPlan(params.requestText), usage: null };
  }
}

function resolveTeamFromPlan(
  teamSlug: string | null | undefined,
  teams: Array<{ id: string; slug: string; name: string }>
): { id: string; slug: string; name: string } | null {
  if (!teamSlug) return null;
  const normalized = normalizeSearchText(teamSlug);
  if (!normalized) return null;
  return teams.find((team) => normalizeSearchText(team.slug) === normalized) || null;
}

function buildReportPrompt(params: {
  startsAt: Date;
  endsAt: Date;
  guidance?: string | null;
  workspaceName: string;
  teamLabel: string;
  appliedFilters: ResolvedQueryFilters;
  summary: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
  truncated: boolean;
}): string {
  const periodLabel = `${params.startsAt.toISOString()} تا ${params.endsAt.toISOString()}`;

  const guidance = params.guidance?.trim()
    ? `راهنمای تحلیل کاربر:\n${params.guidance.trim()}`
    : 'راهنمای تحلیل کاربر: (ندارد)';

  return [
    'تو یک تحلیل‌گر مدیریت پروژه هستی.',
    'فقط بر اساس داده‌های داده‌شده تحلیل کن و اگر چیزی قطعی نیست صریح بگو.',
    'پاسخ را به فارسی و با Markdown بنویس.',
    'ساختار خروجی باید شامل این بخش‌ها باشد:',
    '1) خلاصه مدیریتی',
    '2) روندها و الگوهای مهم',
    '3) ریسک‌ها و گلوگاه‌ها',
    '4) پیشنهادهای عملی اولویت‌بندی‌شده',
    '5) شاخص‌های پیشنهادی برای پایش بعدی',
    '6) تحلیل باید فقط روی همین فیلترهای اعمال‌شده باشد و هیچ فرض اضافه نسازد.',
    '',
    `فضای کاری: ${params.workspaceName}`,
    `تیم انتخابی: ${params.teamLabel}`,
    `بازه گزارش: ${periodLabel}`,
    `درخواست خام کاربر: ${params.appliedFilters.request}`,
    params.appliedFilters.assigneeHint ? `فیلتر مسئول: ${params.appliedFilters.assigneeHint}` : 'فیلتر مسئول: (ندارد)',
    params.appliedFilters.reporterHint ? `فیلتر گزارش‌دهنده: ${params.appliedFilters.reporterHint}` : 'فیلتر گزارش‌دهنده: (ندارد)',
    params.appliedFilters.statuses.length ? `فیلتر وضعیت: ${params.appliedFilters.statuses.join(', ')}` : 'فیلتر وضعیت: (ندارد)',
    params.appliedFilters.priorities.length ? `فیلتر اولویت: ${params.appliedFilters.priorities.join(', ')}` : 'فیلتر اولویت: (ندارد)',
    params.appliedFilters.keywords.length ? `کلیدواژه‌ها: ${params.appliedFilters.keywords.join(', ')}` : 'کلیدواژه‌ها: (ندارد)',
    guidance,
    '',
    'خلاصه عددی:',
    JSON.stringify(params.summary, null, 2),
    '',
    params.truncated
      ? 'نمونه تسک‌ها (فهرست برش‌خورده؛ همه تسک‌ها ارسال نشده):'
      : 'نمونه تسک‌ها:',
    JSON.stringify(params.tasks, null, 2)
  ].join('\n');
}

async function requestOpenAiCompatibleAnalysis(
  apiKey: string,
  model: string,
  prompt: string,
  endpoint: string,
  extraHeaders?: Record<string, string>,
  defaultContext?: string | null,
  systemInstruction = 'You are a project analytics assistant. Answer in Persian.'
): Promise<AiAnalysisResult> {
  const systemMessage = defaultContext?.trim()
    ? `${systemInstruction}\n\nDefault instructions:\n${defaultContext.trim()}`
    : systemInstruction;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: systemMessage
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;

  if (!response.ok) {
    throw new HttpError(502, extractOpenRouterErrorMessage(payload) || `AI request failed for ${endpoint}`);
  }

  const content = extractOpenRouterContent(payload);
  if (!content) {
    throw new HttpError(502, 'AI model returned an empty response');
  }

  const usageRaw = payload?.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
    ? payload.usage as Record<string, unknown>
    : {};

  const promptTokens = nonNegativeInt(usageRaw.prompt_tokens);
  const completionTokens = nonNegativeInt(usageRaw.completion_tokens);
  const totalTokens = nonNegativeInt(usageRaw.total_tokens) || (promptTokens + completionTokens);
  const costCandidate = numberOrNull(usageRaw.cost) ?? numberOrNull(usageRaw.total_cost);
  let usage: AiUsageSnapshot = {
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: costCandidate !== null && costCandidate >= 0 ? costCandidate : null,
  };

  usage = await fillUsageFromOpenRouterGeneration({
    apiKey,
    payload,
    usage,
    extraHeaders
  });

  return {
    content,
    usage,
  };
}

async function fetchOpenRouterGenerationUsage(params: {
  apiKey: string;
  generationId: string;
  extraHeaders?: Record<string, string>;
}): Promise<AiUsageSnapshot | null> {
  const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(params.generationId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      ...(params.extraHeaders || {})
    }
  });

  if (!response.ok) return null;
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return null;
  const dataRaw = payload.data;
  const data =
    dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw)
      ? dataRaw as Record<string, unknown>
      : payload;

  const promptTokens = nonNegativeInt(data.native_tokens_prompt) || nonNegativeInt(data.tokens_prompt);
  const completionTokens = nonNegativeInt(data.native_tokens_completion) || nonNegativeInt(data.tokens_completion);
  const totalTokens = nonNegativeInt(data.total_tokens) || (promptTokens + completionTokens);
  const costCandidate = numberOrNull(data.total_cost) ?? numberOrNull(data.cost);

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0 && (costCandidate === null || costCandidate < 0)) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: costCandidate !== null && costCandidate >= 0 ? costCandidate : null
  };
}

async function fillUsageFromOpenRouterGeneration(params: {
  apiKey: string;
  payload: Record<string, unknown> | null;
  usage: AiUsageSnapshot;
  extraHeaders?: Record<string, string>;
}): Promise<AiUsageSnapshot> {
  if (params.usage.totalTokens > 0 && params.usage.costUsd !== null) return params.usage;
  const generationId = typeof params.payload?.id === 'string' ? params.payload.id.trim() : '';
  if (!generationId) return params.usage;

  const fallback = await fetchOpenRouterGenerationUsage({
    apiKey: params.apiKey,
    generationId,
    extraHeaders: params.extraHeaders
  }).catch(() => null);
  if (!fallback) return params.usage;

  return {
    promptTokens: params.usage.promptTokens > 0 ? params.usage.promptTokens : fallback.promptTokens,
    completionTokens: params.usage.completionTokens > 0 ? params.usage.completionTokens : fallback.completionTokens,
    totalTokens: params.usage.totalTokens > 0 ? params.usage.totalTokens : fallback.totalTokens,
    costUsd: params.usage.costUsd !== null ? params.usage.costUsd : fallback.costUsd
  };
}

async function generateAnalysis(
  provider: ReportAiProvider,
  apiKey: string,
  model: string,
  prompt: string,
  defaultContext?: string | null
): Promise<AiAnalysisResult> {
  return requestOpenAiCompatibleAnalysis(
    apiKey,
    model,
    prompt,
    'https://openrouter.ai/api/v1/chat/completions',
    { 'HTTP-Referer': 'https://taskara.local', 'X-Title': 'Taskara AI Report' },
    defaultContext
  );
}

function audioFormatFromMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  const parts = normalized.split('/');
  const rawSubtype = parts[1] || '';
  const subtype = rawSubtype.split(';')[0]?.split('+')[0] || '';
  if (!subtype) return 'wav';
  if (subtype === 'x-wav') return 'wav';
  return subtype;
}

async function transcribeAudioWithOpenRouter(params: {
  apiKey: string;
  inputAudioBase64: string;
  mimeType: string;
  model?: string;
  language?: string;
}): Promise<{ text: string; usage: AiUsageSnapshot }> {
  const model = params.model?.trim() || 'openai/whisper-large-v3';
  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://taskara.local',
      'X-Title': 'Taskara AI Assistant'
    },
    body: JSON.stringify({
      input_audio: {
        data: params.inputAudioBase64,
        format: audioFormatFromMimeType(params.mimeType)
      },
      model,
      ...(params.language?.trim() ? { language: params.language.trim() } : {})
    })
  });

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new HttpError(502, extractOpenRouterErrorMessage(payload) || 'Audio transcription failed');
  }

  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) throw new HttpError(502, 'Audio transcription returned empty text');

  const usageRaw = payload?.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
    ? payload.usage as Record<string, unknown>
    : {};
  const inputTokens = nonNegativeInt(usageRaw.input_tokens);
  const outputTokens = nonNegativeInt(usageRaw.output_tokens);
  const totalTokens = nonNegativeInt(usageRaw.total_tokens) || (inputTokens + outputTokens);
  const costCandidate = numberOrNull(usageRaw.cost) ?? numberOrNull(usageRaw.total_cost);
  let usage: AiUsageSnapshot = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    costUsd: costCandidate !== null && costCandidate >= 0 ? costCandidate : null
  };
  usage = await fillUsageFromOpenRouterGeneration({
    apiKey: params.apiKey,
    payload,
    usage,
    extraHeaders: { 'HTTP-Referer': 'https://taskara.local', 'X-Title': 'Taskara AI Assistant' }
  });

  return {
    text,
    usage
  };
}

async function generateAssistantCommandPlan(params: {
  apiKey: string;
  model: string;
  defaultContext?: string | null;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  clientNow?: string;
  timezone?: string;
  actorName: string;
  actorUserId: string;
  workspaceName: string;
  context: AssistantContext;
}): Promise<{ plan: AssistantCommandPlan; usage: AiUsageSnapshot }> {
  const contextPayload = {
    actor: {
      userId: params.actorUserId,
      name: params.actorName
    },
    workspace: params.workspaceName,
    now: params.clientNow || new Date().toISOString(),
    timezone: params.timezone || 'UTC',
    projects: params.context.projects.map((project) => ({
      index: project.index,
      id: project.id,
      name: project.name,
      keyPrefix: project.keyPrefix,
      team: project.teamId
        ? { id: project.teamId, name: project.teamName, slug: project.teamSlug }
        : null
    })),
    users: params.context.users.map((user) => ({
      index: user.index,
      id: user.id,
      name: user.name,
      email: user.email,
      teamIds: user.teamIds
    })),
    teams: params.context.teams.map((team) => ({
      index: team.index,
      id: team.id,
      name: team.name,
      slug: team.slug
    })),
    recentTasks: params.context.recentTasks
  };

  const prompt = [
    'تو planner اجرایی Taskara هستی. فقط JSON معتبر برگردان و هیچ متن اضافی ننویس.',
    'وظیفه: پیام فارسی یا انگلیسی کاربر را به یک یا چند عملیات امن و محدود تبدیل کن.',
    '',
    'عملیات‌های مجاز:',
    '- create_task: ساخت یک تسک',
    '- update_task: ویرایش یک تسک موجود',
    '- query_tasks: گزارش‌گیری از تسک‌ها (فقط خواندن)',
    '- bulk_update_tasks: ویرایش چند تسک براساس فیلتر',
    '- create_meeting: ایجاد جلسه',
    '- query_meetings: گزارش‌گیری جلسه‌ها',
    '- create_announcement: ایجاد اطلاعیه',
    '- query_announcements: گزارش‌گیری اطلاعیه‌ها',
    '- clarify: وقتی اطلاعات ضروری کم است',
    '- unsupported: وقتی درخواست خارج از این عملیات‌هاست یا خطرناک/گروهی/نامطمئن است',
    '',
    'قواعد مهم:',
    '1) فقط از projectId و userIdهای موجود در context استفاده کن. ID جدید نساز.',
    '2) اگر کاربر گفت پروژه ۲ یا کاربر ۳، index متناظر در context را انتخاب کن.',
    '3) عبارت‌هایی مثل سینک به کاربر، assign، مسئول، بسپار به، یعنی assigneeId.',
    '4) اگر پیام چند کار مستقل دارد، در actions همه را به ترتیب بیاور.',
    '5) اگر عنوان تسک معلوم نیست action=clarify.',
    '6) اگر پروژه برای ساخت تسک معلوم نیست action=clarify، مگر فقط یک پروژه در context باشد.',
    '7) تاریخ‌های نسبی را با now و timezone داده‌شده به ISO 8601 همراه offset تبدیل کن.',
    '8) مقدار priority فقط یکی از این‌ها باشد:',
    TASK_PRIORITY_VALUES.join(', '),
    '9) مقدار status فقط یکی از این‌ها باشد:',
    TASK_STATUS_VALUES.join(', '),
    '10) درخواست‌هایی مثل "آخرین تسک فلانی" یا "آخرین تسک انجام‌شده هر شخص" را با query_tasks پوشش بده.',
    '11) برای عملیات چندتایی، فقط از bulk_update_tasks استفاده کن.',
    '12) در create_announcement اگر publish=true است recipient لازم است؛ اگر نبود clarify بده.',
    '13) حذف، مدیریت کاربر/تیم/پروژه، یا کار نامطمئن را unsupported کن.',
    '14) response را فارسی و کوتاه بنویس؛ اگر clarify یا unsupported است دقیق بگو کاربر چه چیزی را اصلاح کند.',
    '',
    'فرمت خروجی:',
    JSON.stringify({
      action: 'create_task | update_task | query_tasks | bulk_update_tasks | create_meeting | query_meetings | create_announcement | query_announcements | clarify | unsupported',
      response: 'پیام کوتاه فارسی',
      actions: [
        {
          operation: 'create_task | update_task | query_tasks | bulk_update_tasks | create_meeting | query_meetings | create_announcement | query_announcements',
          task: {},
          update: {},
          query: {},
          bulk: {},
          meeting: {},
          meetingsQuery: {},
          announcement: {},
          announcementsQuery: {}
        }
      ],
      task: {
        projectId: 'uuid یا null',
        projectHint: 'string یا null',
        title: 'string یا null',
        description: 'string یا null',
        assigneeId: 'uuid یا null',
        assigneeHint: 'string یا null',
        status: 'TODO',
        priority: 'MEDIUM',
        dueAt: 'ISO یا null',
        labels: []
      },
      update: {
        taskKeyOrId: 'TASK-1 یا uuid یا null',
        taskHint: 'string یا null',
        projectId: 'uuid یا null',
        projectHint: 'string یا null',
        title: 'string یا null',
        description: 'string یا null',
        assigneeId: 'uuid یا null',
        assigneeHint: 'string یا null',
        unassign: false,
        status: 'TODO یا null',
        priority: 'MEDIUM یا null',
        dueAt: 'ISO یا null',
        clearDueAt: false,
        labels: []
      },
      query: {
        mode: 'latest_task_for_user | latest_done_task_for_user | latest_done_task_for_each_user | search_tasks',
        projectId: 'uuid یا null',
        projectHint: 'string یا null',
        assigneeId: 'uuid یا null',
        assigneeHint: 'string یا null',
        statuses: [],
        priorities: [],
        keywords: [],
        limit: 5
      },
      bulk: {
        projectId: 'uuid یا null',
        projectHint: 'string یا null',
        assigneeId: 'uuid یا null',
        assigneeHint: 'string یا null',
        statuses: [],
        priorities: [],
        keywords: [],
        limit: 30,
        setStatus: 'TODO یا null',
        setPriority: 'MEDIUM یا null',
        setAssigneeId: 'uuid یا null',
        setAssigneeHint: 'string یا null',
        clearDueAt: false,
        setDueAt: 'ISO یا null',
        addLabels: [],
        removeLabels: []
      },
      meeting: {
        title: 'string',
        description: 'string یا null',
        teamId: 'uuid یا null',
        teamHint: 'string یا null',
        projectId: 'uuid یا null',
        projectHint: 'string یا null',
        ownerId: 'uuid یا null',
        ownerHint: 'string یا null',
        participantIds: [],
        participantHints: [],
        status: 'PLANNED یا null',
        scheduledAt: 'ISO یا null',
        heldAt: 'ISO یا null'
      },
      meetingsQuery: {
        mode: 'latest_for_me | upcoming | search_meetings',
        teamId: 'uuid یا null',
        teamHint: 'string یا null',
        projectId: 'uuid یا null',
        projectHint: 'string یا null',
        statuses: [],
        keywords: [],
        mine: true,
        limit: 5
      },
      announcement: {
        title: 'string',
        body: 'string یا null',
        publish: false,
        recipientIds: [],
        recipientHints: []
      },
      announcementsQuery: {
        mode: 'latest_for_me | latest_published | search_announcements',
        statuses: [],
        unread: false,
        keywords: [],
        limit: 5
      }
    }, null, 2),
    '',
    'context:',
    JSON.stringify(contextPayload, null, 2),
    '',
    'history:',
    params.history.length
      ? JSON.stringify(params.history.slice(-12), null, 2)
      : '[]',
    '',
    `پیام کاربر: ${params.message}`
  ].join('\n');

  const result = await requestOpenAiCompatibleAnalysis(
    params.apiKey,
    params.model,
    prompt,
    'https://openrouter.ai/api/v1/chat/completions',
    { 'HTTP-Referer': 'https://taskara.local', 'X-Title': 'Taskara AI Assistant' },
    params.defaultContext,
    'You are a strict JSON planner for a Taskara task-management command executor. Return JSON only.'
  );

  const parsedJson = extractFirstJsonObject(result.content);
  if (!parsedJson) {
    return {
      plan: {
        action: 'clarify',
        response: 'نتونستم پیام را با اطمینان به یک فرمان قابل اجرا تبدیل کنم. لطفا پروژه، عنوان تسک، مسئول و سررسید را واضح‌تر بفرست.',
        actions: [],
        task: null,
        update: null,
        query: null,
        bulk: null
      },
      usage: result.usage
    };
  }

  const parsedPlan = assistantCommandPlanSchema.safeParse(parsedJson);
  if (!parsedPlan.success) {
    return {
      plan: {
        action: 'clarify',
        response: 'نتونستم پیام را دقیق parse کنم. لطفا درخواست را کوتاه‌تر و با جزئیات پروژه/مسئول ارسال کن.',
        actions: [],
        task: null,
        update: null,
        query: null,
        bulk: null
      },
      usage: result.usage
    };
  }

  return {
    plan: parsedPlan.data,
    usage: result.usage
  };
}

async function loadAssistantContext(actor: Awaited<ReturnType<typeof getRequestActor>>): Promise<AssistantContext> {
  const access = await resolveWorkspaceAccess(actor);

  const [teams, projects, members, teamMembers, projectMembers, recentTasks] = await Promise.all([
    prisma.team.findMany({
      where: teamWhereForAccess(access),
      orderBy: [{ name: 'asc' }],
      select: { id: true, name: true, slug: true }
    }),
    prisma.project.findMany({
      where: projectWhereForAccess(access),
      orderBy: [{ updatedAt: 'desc' }],
      take: 120,
      include: {
        team: { select: { id: true, name: true, slug: true } },
        lead: { select: { id: true } }
      }
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: [{ user: { name: 'asc' } }],
      take: 300,
      include: { user: { select: { id: true, name: true, email: true } } }
    }),
    prisma.teamMember.findMany({
      where: access.workspaceWide
        ? { team: { workspaceId: actor.workspace.id } }
        : { teamId: { in: access.teamIds } },
      select: { teamId: true, userId: true }
    }),
    access.workspaceWide || access.projectIds.length === 0
      ? Promise.resolve([])
      : prisma.projectMember.findMany({
        where: { projectId: { in: access.projectIds } },
        select: { projectId: true, userId: true }
      }),
    prisma.task.findMany({
      where: taskWhereForAccess(access),
      orderBy: [{ updatedAt: 'desc' }],
      take: 80,
      select: { id: true, key: true, title: true, projectId: true }
    })
  ]);

  const teamIdsByUserId = new Map<string, string[]>();
  for (const membership of teamMembers) {
    const current = teamIdsByUserId.get(membership.userId) || [];
    current.push(membership.teamId);
    teamIdsByUserId.set(membership.userId, current);
  }

  const visibleUserIds = new Set<string>([actor.user.id]);
  if (!access.workspaceWide) {
    for (const membership of teamMembers) visibleUserIds.add(membership.userId);
    for (const membership of projectMembers) visibleUserIds.add(membership.userId);
    for (const project of projects) {
      if (project.lead?.id) visibleUserIds.add(project.lead.id);
    }
  }
  const visibleMembers = access.workspaceWide
    ? members
    : members.filter((member) => visibleUserIds.has(member.user.id));

  return {
    teams: teams.map((team, index) => ({
      index: index + 1,
      id: team.id,
      name: team.name,
      slug: team.slug
    })),
    projects: projects.map((project, index) => ({
      index: index + 1,
      id: project.id,
      name: project.name,
      keyPrefix: project.keyPrefix,
      teamId: project.teamId,
      teamName: project.team?.name || null,
      teamSlug: project.team?.slug || null
    })),
    users: visibleMembers.map((member, index) => ({
      index: index + 1,
      id: member.user.id,
      name: member.user.name,
      email: member.user.email,
      teamIds: teamIdsByUserId.get(member.user.id) || []
    })),
    recentTasks: recentTasks.map((task, index) => ({
      index: index + 1,
      id: task.id,
      key: task.key,
      title: task.title,
      projectId: task.projectId
    })),
    access
  };
}

async function executeAssistantPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  plan: AssistantCommandPlan,
  context: AssistantContext
) {
  if (plan.action === 'clarify') {
    return assistantResponse('needs_clarification', plan.response || 'برای انجام این کار چند جزئیات کم است. پیام را با پروژه، عنوان و مسئول دقیق‌تر بفرست.');
  }

  if (plan.action === 'unsupported') {
    return assistantResponse('unsupported', plan.response || 'این کار فعلا در محدوده عملیات قابل اجرای AI نیست. می‌توانم تسک/جلسه/اطلاعیه را مدیریت کنم و گزارش بگیرم.');
  }

  const fallbackActions: AssistantActionStep[] =
    plan.action === 'create_task'
      ? [{ operation: 'create_task', task: plan.task || null }]
      : plan.action === 'update_task'
        ? [{ operation: 'update_task', update: plan.update || null }]
        : plan.action === 'query_tasks'
          ? [{ operation: 'query_tasks', query: plan.query || null }]
          : plan.action === 'bulk_update_tasks'
            ? [{ operation: 'bulk_update_tasks', bulk: plan.bulk || null }]
            : plan.action === 'create_meeting'
              ? [{ operation: 'create_meeting', meeting: plan.meeting || null }]
              : plan.action === 'query_meetings'
                ? [{ operation: 'query_meetings', meetingsQuery: plan.meetingsQuery || null }]
                : plan.action === 'create_announcement'
                  ? [{ operation: 'create_announcement', announcement: plan.announcement || null }]
                  : plan.action === 'query_announcements'
                    ? [{ operation: 'query_announcements', announcementsQuery: plan.announcementsQuery || null }]
          : [];
  const actions = plan.actions.length > 0 ? plan.actions : fallbackActions;

  if (actions.length === 0) {
    return assistantResponse('unsupported', 'این فرمان قابل اجرا نبود. پیام را دقیق‌تر بفرست تا روی تسک/جلسه/اطلاعیه اجرا کنم.');
  }

  const stepResults: Array<{ index: number; operation: string; status: AssistantResultStatus; message: string; data: Record<string, unknown> }> = [];

  for (const [index, action] of actions.entries()) {
    try {
      const result = await executeAssistantActionStep(actor, action, context);
      stepResults.push({
        index: index + 1,
        operation: action.operation,
        status: result.status as AssistantResultStatus,
        message: result.message as string,
        data: pickAssistantResultData(result)
      });
    } catch (error) {
      stepResults.push({
        index: index + 1,
        operation: action.operation,
        status: 'blocked',
        message: assistantErrorMessage(error),
        data: {}
      });
    }
  }

  const completed = stepResults.filter((item) => item.status === 'completed');
  const failed = stepResults.filter((item) => item.status !== 'completed');

  if (failed.length === 0) {
    return assistantResponse(
      'completed',
      completed.length === 1 ? completed[0]?.message || 'عملیات انجام شد.' : `${completed.length} عملیات روی تسک‌ها انجام شد.`,
      {
        steps: stepResults,
        task: firstTaskPayload(stepResults)
      }
    );
  }

  if (completed.length === 0) {
    return assistantResponse('blocked', failed[0]?.message || 'نتونستم عملیات خواسته‌شده را انجام بدهم.', {
      steps: stepResults
    });
  }

  return assistantResponse(
    'blocked',
    `${completed.length} عملیات انجام شد، اما ${failed.length} مورد نیاز به اصلاح پیام یا دسترسی دارد.`,
    {
      steps: stepResults,
      task: firstTaskPayload(stepResults)
    }
  );
}

async function executeCreateTaskPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  draft: AssistantTaskDraft | null,
  context: AssistantContext
) {
  if (!draft?.title) {
    return assistantResponse('needs_clarification', 'عنوان تسک مشخص نیست. لطفا عنوان کار را هم در پیام بفرست.');
  }

  const project = resolveAssistantProject(draft.projectId || undefined, draft.projectHint || undefined, context);
  if (!project) {
    return assistantResponse('needs_clarification', 'پروژه را با اطمینان پیدا نکردم. نام، کد یا شماره پروژه را دقیق‌تر بنویس.');
  }

  const assignee = resolveOptionalAssistantUser(draft.assigneeId, draft.assigneeHint, context);
  const assigneeProblem = validateAssistantAssignee(project, assignee, Boolean(draft.assigneeId || draft.assigneeHint));
  if (assigneeProblem) return assistantResponse('blocked', assigneeProblem);

  const task = await createTask(actor, {
    projectId: project.id,
    title: draft.title,
    description: draft.description || undefined,
    assigneeId: assignee?.id,
    status: draft.status || 'TODO',
    priority: draft.priority || 'NO_PRIORITY',
    dueAt: draft.dueAt || undefined,
    labels: draft.labels || [],
    source: 'AGENT'
  });
  const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [serializeTaskForResponse(task)]);

  return assistantResponse('completed', `تسک ${task.key} ساخته شد.`, {
    action: 'create_task',
    task: decoratedTask
  });
}

async function executeUpdateTaskPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  update: AssistantTaskUpdate | null,
  context: AssistantContext
) {
  const taskKeyOrId = resolveAssistantTaskKey(update?.taskKeyOrId || undefined, update?.taskHint || undefined, context);
  if (!update || !taskKeyOrId) {
    return assistantResponse('needs_clarification', 'تسکی که باید ویرایش شود مشخص نیست. کلید تسک یا شماره تسک اخیر را در پیام بفرست.');
  }

  const existing = await findTaskByIdOrKey(actor.workspace.id, taskKeyOrId, context.access);
  if (!existing) {
    return assistantResponse('blocked', 'این تسک را پیدا نکردم یا به آن دسترسی نداری.');
  }

  const targetProject = update.projectId || update.projectHint
    ? resolveAssistantProject(update.projectId || undefined, update.projectHint || undefined, context)
    : context.projects.find((project) => project.id === existing.projectId) || null;
  if ((update.projectId || update.projectHint) && !targetProject) {
    return assistantResponse('blocked', 'پروژه مقصد را پیدا نکردم یا به آن دسترسی نداری.');
  }

  const patch: Parameters<typeof updateTask>[2] = {};

  if (hasOwn(update, 'title') && update.title) patch.title = update.title;
  if (hasOwn(update, 'description')) patch.description = update.description ?? null;
  if (targetProject && targetProject.id !== existing.projectId) patch.projectId = targetProject.id;
  if (update.status) patch.status = update.status;
  if (update.priority) patch.priority = update.priority;
  if (hasOwn(update, 'labels') && update.labels) patch.labels = update.labels;
  if (update.clearDueAt || (hasOwn(update, 'dueAt') && update.dueAt === null)) {
    patch.dueAt = null;
  } else if (update.dueAt) {
    patch.dueAt = update.dueAt;
  }

  const assigneeRequested = Boolean(update.assigneeId || update.assigneeHint || update.unassign);
  if (update.unassign || (hasOwn(update, 'assigneeId') && update.assigneeId === null)) {
    patch.assigneeId = null;
  } else if (update.assigneeId || update.assigneeHint) {
    const assignee = resolveOptionalAssistantUser(update.assigneeId, update.assigneeHint, context);
    const projectForAssignee = targetProject || context.projects.find((project) => project.id === existing.projectId) || null;
    if (!projectForAssignee) return assistantResponse('blocked', 'پروژه تسک را برای کنترل دسترسی پیدا نکردم.');
    const assigneeProblem = validateAssistantAssignee(projectForAssignee, assignee, assigneeRequested);
    if (assigneeProblem) return assistantResponse('blocked', assigneeProblem);
    patch.assigneeId = assignee?.id;
  }

  if (Object.keys(patch).length === 0) {
    return assistantResponse('needs_clarification', 'مشخص نکردی چه چیزی در تسک باید تغییر کند.');
  }

  const task = await updateTask(actor, existing.id, patch);
  const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [serializeTaskForResponse(task)]);
  return assistantResponse('completed', `تسک ${task.key} به‌روزرسانی شد.`, {
    action: 'update_task',
    task: decoratedTask
  });
}

async function executeQueryTasksPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  query: AssistantTaskQuery | null,
  context: AssistantContext
) {
  const safeQuery = assistantTaskQuerySchema.parse(query || {});
  const mode = safeQuery.mode;
  const limit = safeQuery.limit;
  const resolvedProject = resolveAssistantProject(safeQuery.projectId || undefined, safeQuery.projectHint || undefined, context);
  const resolvedAssignee = resolveOptionalAssistantUser(safeQuery.assigneeId, safeQuery.assigneeHint, context);
  const baseWhere: Prisma.TaskWhereInput = taskWhereForAccess(context.access);
  const andFilters: Prisma.TaskWhereInput[] = [];
  if (resolvedProject) andFilters.push({ projectId: resolvedProject.id });
  if (safeQuery.statuses.length > 0) andFilters.push({ status: { in: safeQuery.statuses } });
  if (safeQuery.priorities.length > 0) andFilters.push({ priority: { in: safeQuery.priorities } });
  if (safeQuery.keywords.length > 0) {
    andFilters.push({
      OR: safeQuery.keywords.flatMap((keyword) => ([
        { key: { contains: keyword, mode: 'insensitive' as const } },
        { title: { contains: keyword, mode: 'insensitive' as const } },
        { description: { contains: keyword, mode: 'insensitive' as const } }
      ]))
    });
  }

  if (mode === 'latest_done_task_for_each_user') {
    const userIds = context.users.map((user) => user.id);
    if (userIds.length === 0) {
      return assistantResponse('completed', 'کاربری برای گزارش پیدا نشد.', {
        action: 'query_tasks',
        query: { mode, items: [] }
      });
    }

    const doneTasks = await prisma.task.findMany({
      where: {
        ...baseWhere,
        status: 'DONE',
        assigneeId: { in: userIds },
        ...(andFilters.length > 0 ? { AND: andFilters } : {})
      },
      orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        completedAt: true,
        updatedAt: true,
        assigneeId: true,
        assignee: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, keyPrefix: true } }
      },
      take: 1000
    });

    const latestByAssignee = new Map<string, (typeof doneTasks)[number]>();
    for (const task of doneTasks) {
      if (!task.assigneeId) continue;
      if (!latestByAssignee.has(task.assigneeId)) {
        latestByAssignee.set(task.assigneeId, task);
      }
    }

    const items = [...latestByAssignee.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map((task) => ({
        key: task.key,
        title: task.title,
        assignee: task.assignee?.name || 'بدون مسئول',
        project: task.project?.name || '-',
        completedAt: task.completedAt?.toISOString() || null
      }));

    const lines = items.length
      ? items.map((item) =>
          [
            `- ${item.assignee} | ${item.key} | ${item.title}`,
            `  پروژه: ${item.project} | زمان انجام: ${formatFaDateTime(item.completedAt)}`
          ].join('\n')
        )
      : ['- موردی پیدا نشد.'];

    return assistantResponse('completed', `آخرین تسک‌های انجام‌شده هر شخص:\n${lines.join('\n')}`, {
      action: 'query_tasks',
      query: { mode, items }
    });
  }

  if (mode !== 'search_tasks' && !resolvedAssignee) {
    return assistantResponse('needs_clarification', 'شخص موردنظر را پیدا نکردم. نام، ایمیل یا شماره کاربر را دقیق‌تر بفرست.');
  }

  if (mode === 'search_tasks' && !resolvedProject && !resolvedAssignee && andFilters.length === 0) {
    return assistantResponse('needs_clarification', 'برای گزارش تسک، حداقل یک فیلتر بده: شخص، پروژه، وضعیت، اولویت یا کلیدواژه.');
  }

  const where: Prisma.TaskWhereInput = {
    ...baseWhere,
    ...(resolvedAssignee ? { assigneeId: resolvedAssignee.id } : {}),
    ...(mode === 'latest_done_task_for_user' ? { status: 'DONE' } : {}),
    ...(andFilters.length > 0 ? { AND: andFilters } : {})
  };

  const items = await prisma.task.findMany({
    where,
    orderBy: mode === 'latest_done_task_for_user'
      ? [{ completedAt: 'desc' }, { updatedAt: 'desc' }]
      : [{ updatedAt: 'desc' }],
    select: {
      id: true,
      key: true,
      title: true,
      status: true,
      priority: true,
      dueAt: true,
      completedAt: true,
      updatedAt: true,
      assignee: { select: { id: true, name: true } },
      project: { select: { id: true, name: true, keyPrefix: true } }
    },
    take: limit
  });

  const lines = items.length
    ? items.map((task) =>
        formatTaskLineFa({
          key: task.key,
          title: task.title,
          status: task.status,
          priority: task.priority,
          project: task.project?.name || '-',
          assignee: task.assignee?.name || null,
          dueAt: task.dueAt?.toISOString() || null,
          completedAt: task.completedAt?.toISOString() || null
        })
      )
    : ['- موردی پیدا نشد.'];

  const label =
    mode === 'latest_done_task_for_user'
      ? `آخرین تسک‌های انجام‌شده ${resolvedAssignee?.name || ''}`.trim()
      : mode === 'latest_task_for_user'
        ? `آخرین تسک‌های ${resolvedAssignee?.name || ''}`.trim()
        : 'نتیجه جستجوی تسک‌ها';
  return assistantResponse('completed', `${label}:\n${lines.join('\n')}`, {
    action: 'query_tasks',
    query: {
      mode,
      assignee: resolvedAssignee ? { id: resolvedAssignee.id, name: resolvedAssignee.name } : null,
      project: resolvedProject ? { id: resolvedProject.id, name: resolvedProject.name } : null,
      items: items.map((task) => ({
        key: task.key,
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueAt: task.dueAt?.toISOString() || null,
        completedAt: task.completedAt?.toISOString() || null,
        assignee: task.assignee?.name || null,
        project: task.project?.name || '-'
      }))
    }
  });
}

async function executeBulkUpdateTasksPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  bulk: AssistantBulkUpdate | null,
  context: AssistantContext
) {
  const input = assistantBulkUpdateSchema.parse(bulk || {});
  const resolvedProject = resolveAssistantProject(input.projectId || undefined, input.projectHint || undefined, context);
  const resolvedAssignee = resolveOptionalAssistantUser(input.assigneeId, input.assigneeHint, context);
  const targetAssignee = resolveOptionalAssistantUser(input.setAssigneeId, input.setAssigneeHint, context);
  const where: Prisma.TaskWhereInput = {
    ...taskWhereForAccess(context.access),
    ...(resolvedProject ? { projectId: resolvedProject.id } : {}),
    ...(resolvedAssignee ? { assigneeId: resolvedAssignee.id } : {}),
    ...(input.statuses.length ? { status: { in: input.statuses } } : {}),
    ...(input.priorities.length ? { priority: { in: input.priorities } } : {})
  };

  if (input.keywords.length) {
    where.AND = [
      {
        OR: input.keywords.flatMap((keyword) => ([
          { key: { contains: keyword, mode: 'insensitive' as const } },
          { title: { contains: keyword, mode: 'insensitive' as const } },
          { description: { contains: keyword, mode: 'insensitive' as const } }
        ]))
      }
    ];
  }

  const hasMutation =
    Boolean(input.setStatus) ||
    Boolean(input.setPriority) ||
    Boolean(input.setAssigneeId || input.setAssigneeHint) ||
    Boolean(input.clearDueAt) ||
    input.setDueAt !== undefined ||
    input.addLabels.length > 0 ||
    input.removeLabels.length > 0;
  if (!hasMutation) {
    return assistantResponse('needs_clarification', 'برای ویرایش گروهی مشخص نکردی چه تغییری اعمال شود.');
  }

  const tasks = await prisma.task.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }],
    select: { id: true, key: true, projectId: true },
    take: input.limit ?? 30
  });
  if (tasks.length === 0) {
    return assistantResponse('completed', 'تسکی مطابق فیلتر پیدا نشد.', {
      action: 'bulk_update_tasks',
      bulk: { updated: 0, failed: 0, items: [] }
    });
  }

  const results: Array<{ key: string; ok: boolean; message: string }> = [];
  for (const task of tasks) {
    try {
      const patch: Parameters<typeof updateTask>[2] = {};
      if (input.setStatus) patch.status = input.setStatus;
      if (input.setPriority) patch.priority = input.setPriority;
      if (input.clearDueAt || input.setDueAt === null) patch.dueAt = null;
      else if (input.setDueAt) patch.dueAt = input.setDueAt;

      if (input.setAssigneeId || input.setAssigneeHint) {
        if (!targetAssignee) throw new Error('Target assignee not found');
        const project = context.projects.find((item) => item.id === task.projectId);
        const assigneeProblem = project ? validateAssistantAssignee(project, targetAssignee, true) : null;
        if (assigneeProblem) throw new Error(assigneeProblem);
        patch.assigneeId = targetAssignee.id;
      }

      if (input.addLabels.length > 0 || input.removeLabels.length > 0) {
        const labelSet = new Set(
          (
            await prisma.task.findUnique({
              where: { id: task.id },
              select: { labels: { include: { label: { select: { name: true } } } } }
            })
          )?.labels.map((item) => item.label.name) || []
        );
        for (const label of input.addLabels) labelSet.add(label);
        for (const label of input.removeLabels) labelSet.delete(label);
        patch.labels = [...labelSet];
      }

      if (Object.keys(patch).length === 0) {
        results.push({ key: task.key, ok: false, message: 'No patch fields' });
        continue;
      }

      await updateTask(actor, task.id, patch);
      results.push({ key: task.key, ok: true, message: 'Updated' });
    } catch (error) {
      results.push({ key: task.key, ok: false, message: assistantErrorMessage(error) });
    }
  }

  const updated = results.filter((item) => item.ok).length;
  const failed = results.length - updated;
  const status: AssistantResultStatus = failed > 0 ? 'blocked' : 'completed';
  const message = failed > 0
    ? `${updated} تسک به‌روزرسانی شد و ${failed} مورد خطا داشت.`
    : `${updated} تسک با موفقیت به‌روزرسانی شد.`;

  return assistantResponse(status, message, {
    action: 'bulk_update_tasks',
    bulk: {
      updated,
      failed,
      items: results
    }
  });
}

async function executeCreateMeetingPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  meeting: AssistantMeetingDraft | null,
  context: AssistantContext
) {
  const input = assistantMeetingDraftSchema.parse(meeting || {});
  if (!input.title) {
    return assistantResponse('needs_clarification', 'برای ایجاد جلسه، عنوان جلسه لازم است.');
  }

  const team = resolveAssistantTeam(input.teamId || undefined, input.teamHint || undefined, context);
  const project = resolveAssistantProject(input.projectId || undefined, input.projectHint || undefined, context);
  const owner = resolveOptionalAssistantUser(input.ownerId, input.ownerHint, context);
  const participantIds = [
    ...new Set([
      ...input.participantIds,
      ...input.participantHints
        .map((hint) => resolveOptionalAssistantUser(null, hint, context)?.id)
        .filter((value): value is string => Boolean(value))
    ])
  ];

  const created = await createMeeting(actor, {
    title: input.title,
    description: input.description || undefined,
    teamId: team?.id,
    projectId: project?.id,
    ownerId: owner?.id,
    participantIds,
    status: input.status || 'PLANNED',
    scheduledAt: input.scheduledAt || undefined,
    heldAt: input.heldAt || undefined
  });

  return assistantResponse('completed', `جلسه "${created.title}" ایجاد شد.`, {
    action: 'create_meeting',
    meeting: {
      id: created.id,
      title: created.title,
      status: meetingStatusFa(created.status),
      scheduledAt: created.scheduledAt?.toISOString() || null,
      team: created.team?.name || null,
      project: created.project?.name || null
    }
  });
}

async function executeQueryMeetingsPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  query: AssistantMeetingQuery | null,
  context: AssistantContext
) {
  const input = assistantMeetingQuerySchema.parse(query || {});
  const team = resolveAssistantTeam(input.teamId || undefined, input.teamHint || undefined, context);
  const project = resolveAssistantProject(input.projectId || undefined, input.projectHint || undefined, context);
  const where: Prisma.MeetingWhereInput = {
    workspaceId: actor.workspace.id,
    ...(team ? { teamId: team.id } : {}),
    ...(project ? { projectId: project.id } : {}),
    ...(input.statuses.length ? { status: { in: input.statuses } } : {})
  };

  if (!isWorkspaceAdminRole(actor.role) || input.mine) {
    where.OR = [
      { ownerId: actor.user.id },
      { createdById: actor.user.id },
      { participants: { some: { userId: actor.user.id } } }
    ];
  }

  if (input.keywords.length) {
    where.AND = [
      {
        OR: input.keywords.flatMap((keyword) => ([
          { title: { contains: keyword, mode: 'insensitive' as const } },
          { description: { contains: keyword, mode: 'insensitive' as const } }
        ]))
      }
    ];
  }

  if (input.mode === 'upcoming') {
    where.scheduledAt = { gte: new Date() };
  }

  const meetings = await prisma.meeting.findMany({
    where,
    orderBy: input.mode === 'upcoming' ? [{ scheduledAt: 'asc' }] : [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
    take: input.limit,
    include: {
      team: { select: { name: true } },
      project: { select: { name: true, teamId: true } },
      owner: { select: { name: true } },
      participants: { select: { userId: true } }
    }
  });

  const accessScope = await resolveMeetingAccessScope(actor);
  const visible = meetings.filter((item) => canAccessMeeting(actor, item, accessScope));
  const lines = visible.length
    ? visible.map((item) => [
        `- ${item.title}`,
        `  وضعیت: ${meetingStatusFa(item.status)} | تیم: ${item.team?.name || '-'} | پروژه: ${item.project?.name || '-'}`,
        `  زمان: ${formatFaDateTime(item.scheduledAt?.toISOString() || null)} | مالک: ${item.owner?.name || '-'}`
      ].join('\n'))
    : ['- موردی پیدا نشد.'];

  return assistantResponse('completed', `نتیجه جلسه‌ها:\n${lines.join('\n')}`, {
    action: 'query_meetings',
    meetings: visible.map((item) => ({
      id: item.id,
      title: item.title,
      status: meetingStatusFa(item.status),
      scheduledAt: item.scheduledAt?.toISOString() || null,
      team: item.team?.name || null,
      project: item.project?.name || null
    }))
  });
}

async function executeCreateAnnouncementPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  announcement: AssistantAnnouncementDraft | null,
  context: AssistantContext
) {
  if (!isWorkspaceAdminRole(actor.role)) {
    return assistantResponse('blocked', 'برای ایجاد اطلاعیه باید دسترسی مدیر یا مالک داشته باشی.');
  }

  const input = assistantAnnouncementDraftSchema.parse(announcement || {});
  if (!input.title) {
    return assistantResponse('needs_clarification', 'برای ایجاد اطلاعیه، عنوان لازم است.');
  }

  const resolvedRecipientIds = [
    ...new Set([
      ...input.recipientIds,
      ...input.recipientHints
        .map((hint) => resolveOptionalAssistantUser(null, hint, context)?.id)
        .filter((value): value is string => Boolean(value))
    ])
  ];

  if (input.publish && resolvedRecipientIds.length === 0) {
    return assistantResponse('needs_clarification', 'برای انتشار اطلاعیه، حداقل یک گیرنده لازم است.');
  }

  const created = await createAnnouncement(actor, {
    title: input.title,
    body: input.body || undefined,
    recipientIds: resolvedRecipientIds,
    publish: input.publish
  });

  return assistantResponse('completed', `اطلاعیه "${created.title}" ${created.status === 'PUBLISHED' ? 'منتشر' : 'ثبت'} شد.`, {
    action: 'create_announcement',
    announcement: {
      id: created.id,
      title: created.title,
      status: announcementStatusFa(created.status),
      recipientCount: created._count?.recipients || 0
    }
  });
}

async function executeQueryAnnouncementsPlan(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  query: AssistantAnnouncementQuery | null
) {
  const input = assistantAnnouncementQuerySchema.parse(query || {});
  const isAdmin = isWorkspaceAdminRole(actor.role);
  const where: Prisma.AnnouncementWhereInput = {
    workspaceId: actor.workspace.id,
    status: input.statuses.length ? { in: input.statuses } : (isAdmin ? undefined : 'PUBLISHED')
  };

  if (!isAdmin) {
    where.recipients = { some: { userId: actor.user.id } };
  }

  if (input.unread) {
    where.recipients = { some: { userId: actor.user.id, readAt: null } };
    where.status = 'PUBLISHED';
  }

  if (input.keywords.length) {
    where.OR = input.keywords.flatMap((keyword) => ([
      { title: { contains: keyword, mode: 'insensitive' as const } },
      { body: { contains: keyword, mode: 'insensitive' as const } }
    ]));
  }

  const items = await prisma.announcement.findMany({
    where,
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: input.limit,
    include: {
      creator: { select: { name: true } },
      _count: { select: { recipients: true } }
    }
  });

  const lines = items.length
    ? items.map((item) => [
        `- ${item.title}`,
        `  وضعیت: ${announcementStatusFa(item.status)} | گیرنده‌ها: ${item._count.recipients.toLocaleString('fa-IR')} | ایجادکننده: ${item.creator?.name || '-'}`,
        `  زمان انتشار: ${formatFaDateTime(item.publishedAt?.toISOString() || null)}`
      ].join('\n'))
    : ['- موردی پیدا نشد.'];

  return assistantResponse('completed', `نتیجه اطلاعیه‌ها:\n${lines.join('\n')}`, {
    action: 'query_announcements',
    announcements: items.map((item) => ({
      id: item.id,
      title: item.title,
      status: announcementStatusFa(item.status),
      publishedAt: item.publishedAt?.toISOString() || null,
      recipientCount: item._count.recipients
    }))
  });
}

async function executeAssistantActionStep(
  actor: Awaited<ReturnType<typeof getRequestActor>>,
  step: AssistantActionStep,
  context: AssistantContext
) {
  if (step.operation === 'create_task') {
    return executeCreateTaskPlan(actor, step.task || null, context);
  }
  if (step.operation === 'update_task') {
    return executeUpdateTaskPlan(actor, step.update || null, context);
  }
  if (step.operation === 'query_tasks') {
    return executeQueryTasksPlan(actor, step.query || null, context);
  }
  if (step.operation === 'bulk_update_tasks') {
    return executeBulkUpdateTasksPlan(actor, step.bulk || null, context);
  }
  if (step.operation === 'create_meeting') {
    return executeCreateMeetingPlan(actor, step.meeting || null, context);
  }
  if (step.operation === 'query_meetings') {
    return executeQueryMeetingsPlan(actor, step.meetingsQuery || null, context);
  }
  if (step.operation === 'create_announcement') {
    return executeCreateAnnouncementPlan(actor, step.announcement || null, context);
  }
  if (step.operation === 'query_announcements') {
    return executeQueryAnnouncementsPlan(actor, step.announcementsQuery || null);
  }
  return assistantResponse('unsupported', 'این نوع عملیات فعلا پشتیبانی نمی‌شود.');
}

function pickAssistantResultData(result: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if ('task' in result) picked.task = result.task;
  if ('query' in result) picked.query = result.query;
  if ('bulk' in result) picked.bulk = result.bulk;
  if ('meeting' in result) picked.meeting = result.meeting;
  if ('meetings' in result) picked.meetings = result.meetings;
  if ('announcement' in result) picked.announcement = result.announcement;
  if ('announcements' in result) picked.announcements = result.announcements;
  if ('action' in result) picked.action = result.action;
  return picked;
}

function firstTaskPayload(
  items: Array<{ data: Record<string, unknown> }>
): Record<string, unknown> | null {
  for (const item of items) {
    if (item.data.task && typeof item.data.task === 'object') {
      return item.data.task as Record<string, unknown>;
    }
  }
  return null;
}

function assistantResponse(status: AssistantResultStatus, message: string, extra: Record<string, unknown> = {}) {
  return {
    ok: status === 'completed',
    status,
    message,
    ...extra
  };
}

function resolveAssistantProject(
  projectId: string | undefined,
  projectHint: string | undefined,
  context: AssistantContext
): AssistantProjectContext | null {
  if (projectId) return context.projects.find((project) => project.id === projectId) || null;
  if (context.projects.length === 1 && !projectHint) return context.projects[0];
  if (!projectHint) return null;

  const normalized = normalizeSearchText(projectHint);
  const numericIndex = numericHint(normalized);
  if (numericIndex) {
    const byIndex = context.projects.find((project) => project.index === numericIndex);
    if (byIndex) return byIndex;
  }

  return context.projects.find((project) => {
    const fields = [project.name, project.keyPrefix, project.teamName || '', project.teamSlug || ''].map(normalizeSearchText);
    return fields.some((field) => field === normalized || field.includes(normalized) || normalized.includes(field));
  }) || null;
}

function resolveAssistantTeam(
  teamId: string | undefined,
  teamHint: string | undefined,
  context: AssistantContext
): AssistantTeamContext | null {
  if (teamId) return context.teams.find((team) => team.id === teamId) || null;
  if (context.teams.length === 1 && !teamHint) return context.teams[0];
  if (!teamHint) return null;

  const normalized = normalizeSearchText(teamHint);
  const numericIndex = numericHint(normalized);
  if (numericIndex) {
    const byIndex = context.teams.find((team) => team.index === numericIndex);
    if (byIndex) return byIndex;
  }

  return context.teams.find((team) => {
    const fields = [team.name, team.slug].map(normalizeSearchText);
    return fields.some((field) => field === normalized || field.includes(normalized) || normalized.includes(field));
  }) || null;
}

function resolveOptionalAssistantUser(
  userId: string | null | undefined,
  userHint: string | null | undefined,
  context: AssistantContext
): AssistantUserContext | null {
  if (userId) return context.users.find((user) => user.id === userId) || null;
  if (!userHint) return null;

  const normalized = normalizeSearchText(userHint);
  const numericIndex = numericHint(normalized);
  if (numericIndex) {
    const byIndex = context.users.find((user) => user.index === numericIndex);
    if (byIndex) return byIndex;
  }

  return context.users.find((user) => {
    const fields = [user.name, user.email].map(normalizeSearchText);
    return fields.some((field) => field === normalized || field.includes(normalized) || normalized.includes(field));
  }) || null;
}

function resolveAssistantTaskKey(
  taskKeyOrId: string | undefined,
  taskHint: string | undefined,
  context: AssistantContext
): string | null {
  if (taskKeyOrId) return taskKeyOrId;
  if (!taskHint) return null;

  const normalized = normalizeSearchText(taskHint);
  const numericIndex = numericHint(normalized);
  if (numericIndex) {
    const byIndex = context.recentTasks.find((task) => task.index === numericIndex);
    if (byIndex) return byIndex.key;
  }

  const match = context.recentTasks.find((task) => {
    const fields = [task.key, task.title].map(normalizeSearchText);
    return fields.some((field) => field === normalized || field.includes(normalized) || normalized.includes(field));
  });
  return match?.key || null;
}

function validateAssistantAssignee(
  project: AssistantProjectContext,
  assignee: AssistantUserContext | null,
  wasRequested: boolean
): string | null {
  if (!wasRequested) return null;
  if (!assignee) return 'کاربر مسئول را پیدا نکردم. نام، ایمیل یا شماره کاربر را دقیق‌تر بفرست.';
  if (project.teamId && !assignee.teamIds.includes(project.teamId)) {
    return `کاربر ${assignee.name} عضو تیم پروژه ${project.name} نیست. مسئول را اصلاح کن یا اول او را به تیم پروژه اضافه کن.`;
  }
  return null;
}

function numericHint(value: string): number | null {
  const normalizedDigits = value.replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  const match = normalizedDigits.match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasOwn<T extends object>(value: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assistantErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'در اجرای فرمان خطای نامشخص رخ داد.';
  if (/Project not found/i.test(message)) return 'پروژه را پیدا نکردم یا به آن دسترسی نداری. پروژه را اصلاح کن.';
  if (/Project access denied/i.test(message)) return 'به پروژه انتخاب‌شده دسترسی نداری. پروژه دیگری انتخاب کن یا دسترسی تیم را اصلاح کن.';
  if (/Assignee must belong to this workspace/i.test(message)) return 'کاربر مسئول عضو این workspace نیست. مسئول را اصلاح کن.';
  if (/Assignee must belong to the project team/i.test(message)) return 'کاربر مسئول عضو تیم پروژه نیست. مسئول را اصلاح کن یا اول او را به تیم پروژه اضافه کن.';
  if (/Task not found/i.test(message)) return 'تسک را پیدا نکردم یا به آن دسترسی نداری. کلید تسک را اصلاح کن.';
  if (error instanceof HttpError && error.statusCode >= 400 && error.statusCode < 500) return message;
  return 'نتونستم این کار را انجام بدهم. پیام را کمی دقیق‌تر بفرست یا تنظیمات AI را بررسی کن.';
}

function formatFaDateTime(value: string | null | undefined): string {
  if (!value) return 'ندارد';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'ندارد';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatTaskLineFa(input: {
  key: string;
  title: string;
  status: (typeof TASK_STATUS_VALUES)[number];
  priority: (typeof TASK_PRIORITY_VALUES)[number];
  project: string;
  assignee?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
}): string {
  return [
    `- ${input.key} | ${input.title}`,
    `  وضعیت: ${statusLabel(input.status)} | اولویت: ${priorityLabel(input.priority)} | پروژه: ${input.project}`,
    `  مسئول: ${input.assignee || 'ندارد'} | سررسید: ${formatFaDateTime(input.dueAt || null)} | انجام‌شده: ${formatFaDateTime(input.completedAt || null)}`
  ].join('\n');
}

function meetingStatusFa(status: (typeof MEETING_STATUS_VALUES)[number]): string {
  return {
    PLANNED: 'برنامه‌ریزی‌شده',
    HELD: 'برگزارشده',
    CANCELED: 'لغوشده',
    ARCHIVED: 'بایگانی'
  }[status];
}

function announcementStatusFa(status: (typeof ANNOUNCEMENT_STATUS_VALUES)[number]): string {
  return {
    DRAFT: 'پیش‌نویس',
    PUBLISHED: 'منتشرشده',
    ARCHIVED: 'بایگانی'
  }[status];
}

export async function registerAiReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ai/settings', async (request) => {
    const actor = await getRequestActor(request);
    const accounts = await loadAiCredentialAccounts(actor.workspace.id);
    return serializeWorkspaceSettings(accounts);
  });

  app.post('/ai/assistant/message', async (request) => {
    const actor = await getRequestActor(request);
    const input = aiAssistantMessageSchema.parse(request.body);
    const accounts = await loadAiCredentialAccounts(actor.workspace.id);
    const selectedCredential = resolveActiveCredential(accounts);
    if (!selectedCredential) {
      throw new HttpError(400, 'AI API key is not configured. Set it in settings first.');
    }

    const storedApiKey = resolveStoredApiKey(selectedCredential);
    if (!storedApiKey) {
      throw new HttpError(400, 'AI API key is not configured. Set it in settings first.');
    }

    const aiConfig = normalizeAiConfig(selectedCredential.config);
    const effectiveModel = actor.user.aiModel
      ? normalizeOpenRouterModel(actor.user.aiModel)
      : aiConfig.model;
    let messageText = input.message.trim();
    let transcribedText: string | null = null;

    if (input.audio) {
      const transcription = await transcribeAudioWithOpenRouter({
        apiKey: storedApiKey,
        inputAudioBase64: input.audio.data,
        mimeType: input.audio.mimeType,
        model: input.audio.model,
        language: input.audio.language
      });
      await recordUsageStats(selectedCredential.id, transcription.usage);
      transcribedText = transcription.text;
      if (!messageText) messageText = transcription.text;
    }

    if (!messageText) {
      return {
        ...assistantResponse('needs_clarification', 'پیام صوتی یا متنی معتبر دریافت نشد. دوباره تلاش کن.'),
        ai: {
          provider: aiConfig.provider,
          model: effectiveModel,
          credentialId: selectedCredential.id
        }
      };
    }

    const context = await loadAssistantContext(actor);
    const planner = await generateAssistantCommandPlan({
      apiKey: storedApiKey,
      model: effectiveModel,
      defaultContext: aiConfig.defaultContext,
      message: messageText,
      history: input.history,
      clientNow: input.clientNow,
      timezone: input.timezone,
      actorName: actor.user.name,
      actorUserId: actor.user.id,
      workspaceName: actor.workspace.name,
      context
    }).catch((error) => {
      app.log.warn({ error }, 'Failed to plan AI assistant command');
      return null;
    });

    if (!planner) {
      return {
        ...assistantResponse('blocked', 'نتونستم پیام را با اطمینان به یک فرمان قابل اجرا تبدیل کنم. لطفا پروژه، عنوان تسک، مسئول و سررسید را واضح‌تر بفرست.'),
        ai: {
          provider: aiConfig.provider,
          model: effectiveModel,
          credentialId: selectedCredential.id
        }
      };
    }

    await recordUsageStats(selectedCredential.id, planner.usage);

    const result = await executeAssistantPlan(actor, planner.plan, context);

    await prisma.agentRun.create({
      data: {
        workspaceId: actor.workspace.id,
        kind: 'TRIAGE',
        status: 'COMPLETED',
        input: {
          message: messageText,
          inputMessage: input.message.trim() || null,
          transcribedText,
          history: input.history,
          clientNow: input.clientNow || null,
          timezone: input.timezone || null
        },
        output: {
          plan: planner.plan,
          result
        },
        createdById: actor.user.id,
        completedAt: new Date()
      }
    }).catch(() => undefined);

    return {
      ...result,
      transcribedText,
      ai: {
        provider: aiConfig.provider,
        model: effectiveModel,
        credentialId: selectedCredential.id
      }
    };
  });

  app.post('/ai/tasks/refine', async (request) => {
    const actor = await getRequestActor(request);
    const input = taskTextRefineInputSchema.parse(request.body);
    const title = input.title.trim();
    const description = input.description.trim();

    if (!title && !description) {
      throw new HttpError(400, 'Task title or description is required for AI refinement.');
    }

    const accounts = await loadAiCredentialAccounts(actor.workspace.id);
    const selectedCredential = resolveActiveCredential(accounts);
    if (!selectedCredential) {
      throw new HttpError(400, 'AI API key is not configured. Set it in settings first.');
    }

    const storedApiKey = resolveStoredApiKey(selectedCredential);
    if (!storedApiKey) {
      throw new HttpError(400, 'AI API key is not configured. Set it in settings first.');
    }

    const aiConfig = normalizeAiConfig(selectedCredential.config);
    const effectiveModel = actor.user.aiModel
      ? normalizeOpenRouterModel(actor.user.aiModel)
      : aiConfig.model;

    const prompt = [
      'تو یک دستیار نگارشی برای متن تسک هستی. فقط JSON معتبر برگردان.',
      'وظیفه: متن را پخته‌تر، دقیق‌تر و حرفه‌ای‌تر کن، بدون حذف اطلاعات مهم.',
      'اگر توضیح طولانی است، علاوه بر نسخه بهبودیافته یک خلاصه کوتاه هم پیشنهاد بده.',
      '',
      'قواعد:',
      '1) لحن پاسخ رسمی، کوتاه و شفاف باشد.',
      '2) اطلاعات کلیدی را حذف نکن و معنی متن را عوض نکن.',
      '3) اگر عنوان خالی بود titleSuggestion را null بگذار.',
      '4) اگر توضیح خالی بود descriptionSuggestion و summarySuggestion را null بگذار.',
      '5) summarySuggestion فقط وقتی متن واقعاً طولانی است مقدار داشته باشد؛ در غیر این صورت null.',
      '6) خروجی فقط JSON باشد و هیچ متن اضافه نده.',
      '',
      'فرمت خروجی:',
      JSON.stringify({
        titleSuggestion: 'string | null',
        descriptionSuggestion: 'string | null',
        summarySuggestion: 'string | null',
      }, null, 2),
      '',
      `عنوان فعلی:\n${title || '(خالی)'}`,
      '',
      `توضیح فعلی:\n${description || '(خالی)'}`,
    ].join('\n');

    const result = await generateAnalysis(
      aiConfig.provider,
      storedApiKey,
      effectiveModel,
      prompt,
      aiConfig.defaultContext
    );
    await recordUsageStats(selectedCredential.id, result.usage);

    const parsedJson = extractFirstJsonObject(result.content);
    const parsed = parsedJson ? taskTextRefineOutputSchema.safeParse(parsedJson) : null;
    const payload = parsed?.success ? parsed.data : {};
    const fallbackDescription = description ? result.content.trim().slice(0, 20000) : null;

    const titleSuggestion = sanitizeSuggestionText(payload.titleSuggestion, 300, title);
    const descriptionSuggestion = sanitizeSuggestionText(
      payload.descriptionSuggestion ?? fallbackDescription,
      20000,
      description
    );
    const summarySuggestion = sanitizeSuggestionText(payload.summarySuggestion, 4000, description);

    return {
      titleSuggestion,
      descriptionSuggestion,
      summarySuggestion,
      ai: {
        provider: aiConfig.provider,
        model: effectiveModel,
        credentialId: selectedCredential.id,
      },
    };
  });

  app.patch('/ai/settings', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = aiSettingsUpdateSchema.parse(request.body);

    await prisma.$transaction(async (tx) => {
      const allAccounts = await tx.integrationAccount.findMany({
        where: {
          workspaceId: actor.workspace.id,
          provider: AI_INTEGRATION_PROVIDER
        },
        orderBy: [{ updatedAt: 'desc' }]
      });

      const accounts = filterActiveCredentials(allAccounts);
      const active = resolveActiveCredential(accounts);

      let target = input.credentialId
        ? accounts.find((account) => account.id === input.credentialId) || null
        : active;

      if (input.createNew) {
        const provider = OPENROUTER_PROVIDER;
        const model = input.model ? normalizeOpenRouterModel(input.model) : defaultModelForProvider(provider);
        const name = input.name || defaultCredentialName(provider, accounts.length + 1);
        const hashedApiKey = input.apiKey ? hashApiKey(input.apiKey) : null;
        const encryptedApiKey = input.apiKey ? encryptApiKey(input.apiKey) : null;
        const keyPreview = input.apiKey ? maskKey(input.apiKey) : null;

        target = await tx.integrationAccount.create({
          data: {
            workspaceId: actor.workspace.id,
            provider: AI_INTEGRATION_PROVIDER,
            externalId: `${AI_INTEGRATION_EXTERNAL_ID_PREFIX}${crypto.randomUUID()}`,
            accessToken: input.apiKey === undefined ? null : hashedApiKey,
            config: {
              provider,
              model,
              name,
              apiKeyCipher: encryptedApiKey,
              keyPreview,
              defaultContext: input.defaultContext ?? null,
              active: false,
              kind: 'task-report-ai-key'
            }
          }
        });
      }

      if (!target) {
        const provider = OPENROUTER_PROVIDER;
        const model = input.model ? normalizeOpenRouterModel(input.model) : defaultModelForProvider(provider);
        const name = input.name || defaultCredentialName(provider, 1);
        const hashedApiKey = input.apiKey ? hashApiKey(input.apiKey) : null;
        const encryptedApiKey = input.apiKey ? encryptApiKey(input.apiKey) : null;
        const keyPreview = input.apiKey ? maskKey(input.apiKey) : null;

        target = await tx.integrationAccount.create({
          data: {
            workspaceId: actor.workspace.id,
            provider: AI_INTEGRATION_PROVIDER,
            externalId: AI_INTEGRATION_EXTERNAL_ID,
            accessToken: input.apiKey === undefined ? null : hashedApiKey,
            config: {
              provider,
              model,
              name,
              apiKeyCipher: encryptedApiKey,
              keyPreview,
              defaultContext: input.defaultContext ?? null,
              active: true,
              kind: 'task-report-ai-key'
            }
          }
        });
      } else if (!input.createNew) {
        const existingCfg = normalizeAiConfig(target.config);
        const raw = configObject(target.config);
        const provider = OPENROUTER_PROVIDER;
        const model = input.model ? normalizeOpenRouterModel(input.model) : existingCfg.model;
        const name = input.name ?? existingCfg.name ?? defaultCredentialName(provider, 1);
        const defaultContext = input.defaultContext === undefined ? existingCfg.defaultContext : input.defaultContext;
        const legacyPlainApiKey = target.accessToken && !isHashedApiKey(target.accessToken) ? target.accessToken : null;
        const accessToken = input.apiKey === undefined
          ? (legacyPlainApiKey ? hashApiKey(legacyPlainApiKey) : target.accessToken)
          : (input.apiKey ? hashApiKey(input.apiKey) : null);
        const existingCipher = typeof raw.apiKeyCipher === 'string' ? raw.apiKeyCipher : null;
        const existingPreview = typeof raw.keyPreview === 'string' ? raw.keyPreview : null;
        const apiKeyCipher = input.apiKey === undefined
          ? (existingCipher || (legacyPlainApiKey ? encryptApiKey(legacyPlainApiKey) : null))
          : (input.apiKey ? encryptApiKey(input.apiKey) : null);
        const keyPreview = input.apiKey === undefined
          ? (existingPreview || (legacyPlainApiKey ? maskKey(legacyPlainApiKey) : null))
          : (input.apiKey ? maskKey(input.apiKey) : null);

        target = await tx.integrationAccount.update({
          where: { id: target.id },
          data: {
            accessToken,
            config: {
              ...raw,
              provider,
              model,
              name,
              apiKeyCipher,
              keyPreview,
              defaultContext
            }
          }
        });
      }

      if (input.setActive !== false) {
        await setActiveCredential(tx, actor.workspace.id, target.id);
      }
    });

    const refreshed = await loadAiCredentialAccounts(actor.workspace.id);
    return serializeWorkspaceSettings(refreshed);
  });

  app.post('/ai/settings/select', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = aiSettingsSelectSchema.parse(request.body);

    const accounts = await loadAiCredentialAccounts(actor.workspace.id);
    const target = accounts.find((account) => account.id === input.credentialId);
    if (!target) {
      throw new HttpError(404, 'AI credential not found');
    }

    await prisma.$transaction(async (tx) => {
      await setActiveCredential(tx, actor.workspace.id, target.id);
    });

    const refreshed = await loadAiCredentialAccounts(actor.workspace.id);
    return serializeWorkspaceSettings(refreshed);
  });

  app.delete('/ai/settings/:credentialId', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const params = aiSettingsDeleteParamsSchema.parse(request.params);

    await prisma.$transaction(async (tx) => {
      const allAccounts = await tx.integrationAccount.findMany({
        where: {
          workspaceId: actor.workspace.id,
          provider: AI_INTEGRATION_PROVIDER
        },
        orderBy: [{ updatedAt: 'desc' }]
      });
      const accounts = filterActiveCredentials(allAccounts);
      const target = accounts.find((account) => account.id === params.credentialId);
      if (!target) {
        throw new HttpError(404, 'AI credential not found');
      }

      const targetRawConfig = configObject(target.config);
      await tx.integrationAccount.update({
        where: { id: target.id },
        data: {
          config: {
            ...targetRawConfig,
            active: false,
            deletedAt: new Date().toISOString()
          }
        }
      });

      const remaining = filterActiveCredentials(await tx.integrationAccount.findMany({
        where: {
          workspaceId: actor.workspace.id,
          provider: AI_INTEGRATION_PROVIDER
        },
        orderBy: [{ updatedAt: 'desc' }]
      }));

      if (remaining.length > 0 && !remaining.some((account) => normalizeAiConfig(account.config).active)) {
        await setActiveCredential(tx, actor.workspace.id, remaining[0].id);
      }
    });

    const refreshed = await loadAiCredentialAccounts(actor.workspace.id);
    return serializeWorkspaceSettings(refreshed);
  });

  app.post('/ai/settings/test', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = aiSettingsTestSchema.parse(request.body);

    const accounts = await loadAiCredentialAccounts(actor.workspace.id);
    const active = resolveActiveCredential(accounts);
    const selected = input.credentialId
      ? accounts.find((account) => account.id === input.credentialId) || null
      : active;

    if (input.credentialId && !selected) {
      throw new HttpError(404, 'AI credential not found');
    }

    const selectedConfig = normalizeAiConfig(selected?.config);
    const provider = OPENROUTER_PROVIDER;
    const model = input.model
      ? normalizeOpenRouterModel(input.model)
      : actor.user.aiModel
        ? normalizeOpenRouterModel(actor.user.aiModel)
        : selectedConfig.model;
    const apiKey = input.apiKey === undefined ? resolveStoredApiKey(selected) : input.apiKey;

    if (!apiKey) {
      throw new HttpError(400, 'No API key available for test. Enter key or save it first.');
    }

    const startedAt = Date.now();
    const result = await generateAnalysis(
      provider,
      apiKey,
      model || defaultModelForProvider(provider),
      'فقط عبارت "TEST_OK" را برگردان. هیچ توضیح اضافه نده.',
      selectedConfig.defaultContext
    );
    if (selected) await recordUsageStats(selected.id, result.usage);
    const latencyMs = Date.now() - startedAt;

    return {
      ok: true,
      provider,
      model: model || defaultModelForProvider(provider),
      latencyMs,
      responsePreview: result.content.slice(0, 80)
    };
  });

  app.post('/reports/tasks/analyze', async (request) => {
    const actor = await getRequestActor(request);
    const input = reportAnalyzeInputSchema.parse(request.body);

    const accounts = await loadAiCredentialAccounts(actor.workspace.id);
    const selectedCredential = resolveActiveCredential(accounts);
    if (!selectedCredential) {
      throw new HttpError(400, 'AI API key is not configured. Set it in settings first.');
    }

    const storedApiKey = resolveStoredApiKey(selectedCredential);
    if (!storedApiKey) {
      throw new HttpError(400, 'AI API key is not configured. Set it in settings first.');
    }

    const aiConfig = normalizeAiConfig(selectedCredential.config);
    const effectiveModel = actor.user.aiModel
      ? normalizeOpenRouterModel(actor.user.aiModel)
      : aiConfig.model;
    const access = await resolveWorkspaceAccess(actor);
    const accessibleTeams = await prisma.team.findMany({
      where: teamWhereForAccess(access),
      select: { id: true, slug: true, name: true },
      orderBy: [{ name: 'asc' }]
    });

    const planner = await requestQueryPlan({
      provider: aiConfig.provider,
      apiKey: storedApiKey,
      model: effectiveModel,
      requestText: input.request,
      teams: accessibleTeams.map((team) => ({ slug: team.slug, name: team.name }))
    });
    if (planner.usage) await recordUsageStats(selectedCredential.id, planner.usage);
    const range = resolveDateRangeFromPlan(planner.plan);
    const selectedTeam = resolveTeamFromPlan(planner.plan.teamSlug, accessibleTeams);

    const appliedFilters: ResolvedQueryFilters = {
      request: input.request,
      teamSlug: selectedTeam?.slug || null,
      teamName: selectedTeam?.name || null,
      assigneeHint: planner.plan.assigneeHint || null,
      reporterHint: planner.plan.reporterHint || null,
      statuses: planner.plan.statuses || [],
      priorities: planner.plan.priorities || [],
      keywords: planner.plan.keywords || [],
      guidance: planner.plan.guidance || input.request
    };

    const where: Prisma.TaskWhereInput = {
      AND: [
        taskWhereForAccess(access),
        {
          OR: [
            { createdAt: { gte: range.startsAt, lt: range.endsAt } },
            { updatedAt: { gte: range.startsAt, lt: range.endsAt } },
            { completedAt: { gte: range.startsAt, lt: range.endsAt } }
          ]
        },
        ...(selectedTeam ? [{ project: { teamId: selectedTeam.id } }] : [])
      ]
    };

    const andFilters: Prisma.TaskWhereInput[] = [];
    if (appliedFilters.statuses.length > 0) {
      andFilters.push({ status: { in: appliedFilters.statuses as Array<(typeof TASK_STATUS_VALUES)[number]> } });
    }
    if (appliedFilters.priorities.length > 0) {
      andFilters.push({ priority: { in: appliedFilters.priorities as Array<(typeof TASK_PRIORITY_VALUES)[number]> } });
    }
    if (appliedFilters.assigneeHint) {
      andFilters.push({
        assignee: {
          is: {
            OR: [
              { name: { contains: appliedFilters.assigneeHint, mode: 'insensitive' } },
              { email: { contains: appliedFilters.assigneeHint, mode: 'insensitive' } }
            ]
          }
        }
      });
    }
    if (appliedFilters.reporterHint) {
      andFilters.push({
        reporter: {
          is: {
            OR: [
              { name: { contains: appliedFilters.reporterHint, mode: 'insensitive' } },
              { email: { contains: appliedFilters.reporterHint, mode: 'insensitive' } }
            ]
          }
        }
      });
    }
    if (appliedFilters.keywords.length > 0) {
      const keywordOr = appliedFilters.keywords.flatMap((keyword) => ([
        { title: { contains: keyword, mode: 'insensitive' as const } },
        { description: { contains: keyword, mode: 'insensitive' as const } },
        { key: { contains: keyword, mode: 'insensitive' as const } },
        { project: { name: { contains: keyword, mode: 'insensitive' as const } } },
        { labels: { some: { label: { name: { contains: keyword, mode: 'insensitive' as const } } } } }
      ] satisfies Prisma.TaskWhereInput[]));

      if (keywordOr.length > 0) {
        andFilters.push({ OR: keywordOr });
      }
    }
    if (andFilters.length > 0) {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), ...andFilters];
    }

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        project: {
          select: {
            id: true,
            name: true,
            keyPrefix: true,
            team: { select: { id: true, name: true, slug: true } }
          }
        },
        assignee: { select: { id: true, name: true, email: true } },
        reporter: { select: { id: true, name: true, email: true } },
        labels: {
          include: {
            label: {
              select: {
                id: true,
                name: true
              }
            }
          }
        }
      },
      take: 600
    });

    const filteredTasks = tasks;

    const statusCounts = new Map<string, number>();
    const priorityCounts = new Map<string, number>();
    let doneCount = 0;
    let blockedCount = 0;
    let overdueCount = 0;

    for (const task of filteredTasks) {
      statusCounts.set(task.status, (statusCounts.get(task.status) || 0) + 1);
      priorityCounts.set(task.priority, (priorityCounts.get(task.priority) || 0) + 1);
      if (task.status === 'DONE') doneCount += 1;
      if (task.status === 'BLOCKED') blockedCount += 1;
      if (task.dueAt && task.dueAt < new Date() && task.status !== 'DONE' && task.status !== 'CANCELED') {
        overdueCount += 1;
      }
    }

    const byAssignee = new Map<string, { name: string; total: number; done: number }>();
    for (const task of filteredTasks) {
      const key = task.assigneeId || 'unassigned';
      const name = task.assignee?.name || 'بدون مسئول';
      const current = byAssignee.get(key) || { name, total: 0, done: 0 };
      current.total += 1;
      if (task.status === 'DONE') current.done += 1;
      byAssignee.set(key, current);
    }

    const topAssignees = [...byAssignee.values()]
      .sort((a, b) => {
        if (b.done !== a.done) return b.done - a.done;
        return b.total - a.total;
      })
      .slice(0, 8);

    const taskSamples = filteredTasks.slice(0, 250).map((task) => ({
      key: task.key,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt?.toISOString() || null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt?.toISOString() || null,
      project: task.project?.name || null,
      team: task.project?.team?.name || null,
      assignee: task.assignee?.name || null,
      labels: task.labels.map((item) => item.label.name)
    }));

    const summary = {
      totalTasks: filteredTasks.length,
      doneTasks: doneCount,
      blockedTasks: blockedCount,
      overdueOpenTasks: overdueCount,
      completionRate: filteredTasks.length > 0 ? Number((doneCount / filteredTasks.length).toFixed(4)) : 0,
      statusCounts: Object.fromEntries(statusCounts),
      priorityCounts: Object.fromEntries(priorityCounts),
      topAssignees
    };

    const prompt = buildReportPrompt({
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      guidance: appliedFilters.guidance,
      workspaceName: actor.workspace.name,
      teamLabel: selectedTeam ? `${selectedTeam.name} (${selectedTeam.slug})` : 'همه تیم‌ها',
      appliedFilters,
      summary,
      tasks: taskSamples,
      truncated: filteredTasks.length > taskSamples.length
    });

    const result = await generateAnalysis(
      aiConfig.provider,
      storedApiKey,
      effectiveModel,
      prompt,
      aiConfig.defaultContext
    );
    await recordUsageStats(selectedCredential.id, result.usage);

    return {
      period: {
        startsAt: range.startsAt.toISOString(),
        endsAt: range.endsAt.toISOString()
      },
      summary,
      report: result.content,
      sampleSize: taskSamples.length,
      totalMatchedTasks: filteredTasks.length,
      appliedFilters,
      resolvedQuery: {
        request: input.request,
        startsAt: range.startsAt.toISOString(),
        endsAt: range.endsAt.toISOString(),
        teamSlug: selectedTeam?.slug || null,
        statuses: appliedFilters.statuses,
        priorities: appliedFilters.priorities,
        keywords: appliedFilters.keywords
      },
      ai: {
        provider: aiConfig.provider,
        model: effectiveModel,
        credentialId: selectedCredential.id
      }
    };
  });
}
