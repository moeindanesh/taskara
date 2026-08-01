import { z } from 'zod';

const optionalString = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.string().optional());

const optionalUrl = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.string().url().optional());

const ENV_FLAG_OFF = ['0', 'false', 'no', 'off'];
const ENV_FLAG_ON = ['1', 'true', 'yes', 'on'];

/**
 * Reads a boolean environment variable, or refuses to answer.
 *
 * `z.coerce.boolean()` is truthiness on a string, so it reads "false" and "0" as **true**: there is
 * no spelling of "off" at all, and a flag that defaults off is turned *on* by the word `false`. The
 * earlier fix here read the off-words correctly but still treated everything unrecognized as `true`,
 * so `TASKARA_EMAIL_HEADER_AUTH=flase` left the legacy authentication path open and said nothing.
 *
 * So: an unrecognized value is echoed back unchanged rather than guessed at, and the `z.boolean()`
 * behind it rejects it — which, for a variable read once at boot, means the process refuses to
 * start with the offending variable named in the Zod error path. That is the counterpart of the 400
 * that `strictQueryBooleanSchema` returns for a query parameter: same rule, never silently
 * reinterpret, and the loudest thing available in each context. Falling back to the default is the
 * option deliberately rejected — the default is exactly what the operator was trying to change, so
 * the fallback is indistinguishable from the bug.
 *
 * The vocabulary is wider than the query string's `true`/`false` on purpose. This value is written
 * by a person in a shell or a compose file, `1`/`yes`/`on` already work today, and narrowing them
 * would break running deployments to prevent nothing.
 */
export function parseEnvFlag(value: unknown, fallback: boolean): boolean | unknown {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (ENV_FLAG_OFF.includes(normalized)) return false;
  if (ENV_FLAG_ON.includes(normalized)) return true;
  return value;
}

const envFlag = (fallback: boolean) => z.preprocess((value) => parseEnvFlag(value, fallback), z.boolean());

export const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().positive(),
  WEB_ORIGIN: z.string().url(),
  TASKARA_ALLOWED_ORIGINS: z.string().default(''),
  TASKARA_CDN_MEDIA_BASE_URL: optionalUrl,
  TASKARA_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  TASKARA_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Legacy `x-user-email` authentication. Defaults on so shipped consumers keep working; set it to
  // `false` once they have moved, which turns the path off for the whole deployment.
  TASKARA_EMAIL_HEADER_AUTH: envFlag(true),
  TASKARA_INVITE_TTL_DAYS: z.coerce.number().int().positive().default(14),
  MATTERMOST_SLASH_TOKEN: optionalString,
  MATTERMOST_BASE_URL: optionalUrl,
  MATTERMOST_BOT_TOKEN: optionalString,
  MATTERMOST_SYNTHETIC_EMAIL_DOMAIN: z.string().min(1),
  MATTERMOST_WORKSPACE_SLUG: optionalString,
  SMS_KAVEH_KEY: optionalString,
  SMS_KAVEH_SENDER: optionalString,
  TASKARA_AI_CREDENTIAL_SECRET: optionalString,
  TASKARA_WORKSPACE_TIMEZONE: z.string().min(1).default('Asia/Tehran'),
  TASKARA_SCHEDULED_JOBS_ENABLED: envFlag(false),
  TASKARA_DAILY_REPORT_SMS_ENABLED: envFlag(false)
});

export const config = envSchema.parse(process.env);
