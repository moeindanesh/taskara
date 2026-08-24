import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import {
  createSupportCalendar,
  createSupportSlaPolicyVersion,
  deactivateSupportSlaPolicy,
  getSupportOperationalReport,
  listSupportCalendars,
  listSupportSlaPolicies,
  resumeSupportCaseAttention,
  searchSupportContacts,
  snoozeSupportCaseAttention,
  updateSupportCalendar
} from '../services/support-operations';
import {
  supportSlaConditionsSchema,
  supportSlaPauseRulesSchema,
  supportSlaTargetsSchema
} from '../services/support-sla';

const calendarPeriodSchema = z.object({
  dayOfWeek: z.number().int().min(1).max(7),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440)
}).strict().refine((period) => period.endMinute > period.startMinute, {
  message: 'Calendar period endMinute must be after startMinute'
});

const calendarHolidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().trim().min(1).max(160),
  working: z.boolean().default(false)
}).strict();

const createCalendarSchema = z.object({
  name: z.string().trim().min(1).max(160),
  timezone: z.string().trim().min(1).max(120),
  departmentId: z.string().uuid().nullable().optional(),
  periods: z.array(calendarPeriodSchema).min(1).max(28),
  holidays: z.array(calendarHolidaySchema).max(1000).default([])
}).strict();

const updateCalendarSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  timezone: z.string().trim().min(1).max(120).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
  periods: z.array(calendarPeriodSchema).min(1).max(28).optional(),
  holidays: z.array(calendarHolidaySchema).max(1000).optional()
}).strict().refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: 'At least one calendar field is required'
});

const createSlaPolicySchema = z.object({
  calendarId: z.string().uuid(),
  policyKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  name: z.string().trim().min(1).max(160),
  priority: z.number().int().min(0).max(10_000).default(100),
  conditions: supportSlaConditionsSchema,
  targets: supportSlaTargetsSchema,
  pauseRules: supportSlaPauseRulesSchema,
  effectiveFrom: z.string().datetime({ offset: true }),
  effectiveUntil: z.string().datetime({ offset: true }).nullable().optional()
}).strict();

const caseSnoozeSchema = z.object({
  snoozedUntil: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(3).max(1000),
  baseVersion: z.number().int().positive()
}).strict();

const caseResumeSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  baseVersion: z.number().int().positive()
}).strict();

const contactSearchSchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(10)
});

const reportQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  departmentId: z.string().uuid().optional()
});

export async function registerSupportOperationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/config/calendars', async (request) => ({
    items: await listSupportCalendars(await getRequestActor(request))
  }));

  app.post('/support/config/calendars', async (request, reply) => {
    const calendar = await createSupportCalendar(
      await getRequestActor(request),
      createCalendarSchema.parse(request.body)
    );
    return reply.code(201).send(calendar);
  });

  app.patch('/support/config/calendars/:id', async (request) => {
    const { id } = request.params as { id: string };
    return updateSupportCalendar(
      await getRequestActor(request),
      id,
      updateCalendarSchema.parse(request.body)
    );
  });

  app.get('/support/config/sla-policies', async (request) => ({
    items: await listSupportSlaPolicies(await getRequestActor(request))
  }));

  app.post('/support/config/sla-policies', async (request, reply) => {
    const input = createSlaPolicySchema.parse(request.body);
    const policy = await createSupportSlaPolicyVersion(await getRequestActor(request), {
      ...input,
      effectiveFrom: new Date(input.effectiveFrom),
      effectiveUntil: input.effectiveUntil ? new Date(input.effectiveUntil) : null
    });
    return reply.code(201).send(policy);
  });

  app.post('/support/config/sla-policies/:id/deactivate', async (request) => {
    const { id } = request.params as { id: string };
    return deactivateSupportSlaPolicy(await getRequestActor(request), id);
  });

  app.post('/support/cases/:idOrKey/snooze', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    const input = caseSnoozeSchema.parse(request.body);
    return snoozeSupportCaseAttention(await getRequestActor(request), idOrKey, {
      ...input,
      snoozedUntil: new Date(input.snoozedUntil)
    });
  });

  app.post('/support/cases/:idOrKey/resume', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return resumeSupportCaseAttention(
      await getRequestActor(request),
      idOrKey,
      caseResumeSchema.parse(request.body)
    );
  });

  app.get('/support/contacts/search', async (request) => {
    const actor = await getRequestActor(request);
    const query = contactSearchSchema.parse(request.query);
    return { items: await searchSupportContacts(actor, query.q, query.limit) };
  });

  app.get('/support/reports/overview', async (request) => {
    const actor = await getRequestActor(request);
    const query = reportQuerySchema.parse(request.query);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (from >= to) throw new HttpError(400, 'Report from must be before to');
    if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
      throw new HttpError(400, 'Support reports are limited to a 366-day cohort');
    }
    return getSupportOperationalReport(actor, { from, to, departmentId: query.departmentId });
  });
}
