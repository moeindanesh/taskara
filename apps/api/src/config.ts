import { z } from 'zod';

const optionalString = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.string().optional());

const optionalUrl = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.string().url().optional());

const optionalBoolean = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.enum(['true', 'false']).default('true').transform((value) => value === 'true'));

const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().positive(),
  WEB_ORIGIN: z.string().url(),
  TASKARA_ALLOWED_ORIGINS: z.string().default(''),
  TASKARA_CDN_UPLOAD_URL: optionalUrl,
  TASKARA_CDN_MEDIA_BASE_URL: optionalUrl,
  TASKARA_CDN_APP: z.string().min(1),
  TASKARA_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  TASKARA_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  TASKARA_INVITE_TTL_DAYS: z.coerce.number().int().positive().default(14),
  MATTERMOST_SLASH_TOKEN: optionalString,
  MATTERMOST_BASE_URL: optionalUrl,
  MATTERMOST_BOT_TOKEN: optionalString,
  MATTERMOST_SYNTHETIC_EMAIL_DOMAIN: z.string().min(1),
  MATTERMOST_WORKSPACE_SLUG: optionalString,
  SMS_KAVEH_KEY: optionalString,
  SMS_KAVEH_SENDER: optionalString,
  SMS_TEMPLATE_NO_PLAN: optionalString,
  SMS_TEMPLATE_TODAY_REMINDER: optionalString,
  SMS_TEMPLATE_TASK_CREATED: optionalString,
  TASKARA_SMS_DAILY_REMINDERS_ENABLED: optionalBoolean
});

export const config = envSchema.parse(process.env);
