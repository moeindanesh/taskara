import type { FastifyInstance } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { prisma, type IntegrationAccount, type Prisma } from '@taskara/db';
import { z } from 'zod';
import { config } from '../config';
import { getRequestActor, requireWorkspaceAdmin } from '../services/actor';
import { HttpError } from '../services/http';
import { assertActorCanAccessTeamSlug, listAccessibleTeamIds } from '../services/team-access';

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
  teamId: z.string().min(1).default('all'),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  guidance: z.string().trim().max(4000).optional()
}).superRefine((value, ctx) => {
  if (!value.startsAt || !value.endsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startsAt'],
      message: 'Both startsAt and endsAt must be provided'
    });
  }
});

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

async function recordUsageStats(credentialId: string, snapshot: AiUsageSnapshot): Promise<void> {
  const meaningfulUsage =
    snapshot.promptTokens > 0 ||
    snapshot.completionTokens > 0 ||
    snapshot.totalTokens > 0 ||
    (snapshot.costUsd !== null && snapshot.costUsd > 0);
  if (!meaningfulUsage) return;

  await prisma.$transaction(async (tx) => {
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
    usage: extractUsageStats(active?.config),
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

function resolveDateRange(input: z.infer<typeof reportAnalyzeInputSchema>): ReportDateRange {
  const startsAt = new Date(input.startsAt || '');
  const endsAt = new Date(input.endsAt || '');

  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
    throw new HttpError(400, 'Invalid report date range');
  }

  return { startsAt, endsAt };
}

function buildReportPrompt(params: {
  startsAt: Date;
  endsAt: Date;
  guidance?: string;
  workspaceName: string;
  teamId: string;
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
    '',
    `فضای کاری: ${params.workspaceName}`,
    `تیم انتخابی: ${params.teamId === 'all' ? 'همه تیم‌ها' : params.teamId}`,
    `بازه گزارش: ${periodLabel}`,
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
  defaultContext?: string | null
): Promise<AiAnalysisResult> {
  const systemMessage = defaultContext?.trim()
    ? `You are a project analytics assistant. Answer in Persian.\n\nDefault instructions:\n${defaultContext.trim()}`
    : 'You are a project analytics assistant. Answer in Persian.';

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

  return {
    content,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd: costCandidate !== null && costCandidate >= 0 ? costCandidate : null,
    },
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

export async function registerAiReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ai/settings', async (request) => {
    const actor = await getRequestActor(request);
    const accounts = await loadAiCredentialAccounts(actor.workspace.id);
    return serializeWorkspaceSettings(accounts);
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
    const range = resolveDateRange(input);

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
    const accessibleTeamIds = await listAccessibleTeamIds(actor);

    const where: Prisma.TaskWhereInput = {
      workspaceId: actor.workspace.id,
      OR: [
        { createdAt: { gte: range.startsAt, lt: range.endsAt } },
        { updatedAt: { gte: range.startsAt, lt: range.endsAt } },
        { completedAt: { gte: range.startsAt, lt: range.endsAt } }
      ]
    };

    if (input.teamId !== 'all') {
      await assertActorCanAccessTeamSlug(actor, input.teamId);
      where.project = {
        team: {
          workspaceId: actor.workspace.id,
          slug: input.teamId
        }
      };
    } else if (accessibleTeamIds) {
      where.project = { OR: [{ teamId: null }, { teamId: { in: accessibleTeamIds } }] };
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

    const statusCounts = new Map<string, number>();
    const priorityCounts = new Map<string, number>();
    let doneCount = 0;
    let blockedCount = 0;
    let overdueCount = 0;

    for (const task of tasks) {
      statusCounts.set(task.status, (statusCounts.get(task.status) || 0) + 1);
      priorityCounts.set(task.priority, (priorityCounts.get(task.priority) || 0) + 1);
      if (task.status === 'DONE') doneCount += 1;
      if (task.status === 'BLOCKED') blockedCount += 1;
      if (task.dueAt && task.dueAt < new Date() && task.status !== 'DONE' && task.status !== 'CANCELED') {
        overdueCount += 1;
      }
    }

    const byAssignee = new Map<string, { name: string; total: number; done: number }>();
    for (const task of tasks) {
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

    const taskSamples = tasks.slice(0, 250).map((task) => ({
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
      totalTasks: tasks.length,
      doneTasks: doneCount,
      blockedTasks: blockedCount,
      overdueOpenTasks: overdueCount,
      completionRate: tasks.length > 0 ? Number((doneCount / tasks.length).toFixed(4)) : 0,
      statusCounts: Object.fromEntries(statusCounts),
      priorityCounts: Object.fromEntries(priorityCounts),
      topAssignees
    };

    const prompt = buildReportPrompt({
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      guidance: input.guidance,
      workspaceName: actor.workspace.name,
      teamId: input.teamId,
      summary,
      tasks: taskSamples,
      truncated: tasks.length > taskSamples.length
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
      totalMatchedTasks: tasks.length,
      ai: {
        provider: aiConfig.provider,
        model: effectiveModel,
        credentialId: selectedCredential.id
      }
    };
  });
}
