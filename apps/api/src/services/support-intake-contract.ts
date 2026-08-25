import { z } from 'zod';
import {
  supportCallDispositionSchema,
  supportCaseImpactSchema,
  supportCasePrioritySchema,
  supportCaseTypeKeySchema,
  supportCaseUrgencySchema,
  supportInteractionKindSchema,
  supportRecordingConsentSchema
} from '@taskara/shared';

const connectorContactSchema = z.object({
  externalCustomerId: z.string().trim().min(1).max(240).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().regex(/^\+?\d{7,15}$/).optional()
}).strict().refine(
  (value) => Boolean(value.externalCustomerId || value.name || value.email || value.phone),
  'At least one contact identifier is required'
);

const connectorCaseSnapshotSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(50_000).optional(),
  typeKey: supportCaseTypeKeySchema,
  priority: supportCasePrioritySchema.default('NORMAL'),
  impact: supportCaseImpactSchema.optional(),
  urgency: supportCaseUrgencySchema.optional(),
  contact: connectorContactSchema.optional()
}).strict();

const connectorInteractionSchema = z.object({
  externalId: z.string().trim().min(1).max(240),
  kind: supportInteractionKindSchema.default('MESSAGE'),
  occurredAt: z.string().datetime().optional(),
  body: z.string().min(1).max(100_000).optional(),
  format: z.enum(['text/plain', 'text/markdown']).default('text/plain')
}).strict();

const connectorCallSchema = z.object({
  disposition: supportCallDispositionSchema,
  startedAt: z.string().datetime(),
  answeredAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  durationSeconds: z.coerce.number().int().nonnegative().optional(),
  recordingConsent: supportRecordingConsentSchema.default('UNKNOWN'),
  recordingExists: z.boolean().default(false),
  callbackDueAt: z.string().datetime().optional(),
  externalCallId: z.string().trim().min(1).max(240).optional()
}).strict();

/**
 * The connector is intentionally unable to submit lifecycle, ownership, assignee, resolution,
 * workspace, key, SLA, author or outbound-message fields. `.strict()` makes those attempts fail
 * instead of being silently ignored. Every event carries a bounded Case snapshot, which lets an
 * out-of-order interaction create the source thread without rolling staff-owned state backward.
 */
export const supportIntakeEventSchema = z.object({
  schemaVersion: z.literal(1),
  externalCaseId: z.string().trim().min(1).max(240),
  sourceSequence: z.string().regex(/^\d{1,40}$/).optional(),
  occurredAt: z.string().datetime().optional(),
  case: connectorCaseSnapshotSchema,
  interaction: connectorInteractionSchema.optional(),
  call: connectorCallSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.call && value.interaction?.kind !== 'CALL') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['interaction', 'kind'],
      message: 'A call detail requires a CALL interaction'
    });
  }
  if (value.call?.recordingExists) {
    // The indicator is retained for compliance/audit, but no URL or bytes are accepted. Keeping
    // this explicit prevents somebody later slipping a permanent media capability into `case`.
    const unknownCall = value.call as Record<string, unknown>;
    if ('recordingUrl' in unknownCall || 'recording' in unknownCall) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['call'],
        message: 'Support recordings are excluded until revocable media is available'
      });
    }
  }
});

export type SupportIntakeEvent = z.infer<typeof supportIntakeEventSchema>;

export const supportIntakeHeadersSchema = z.object({
  timestamp: z.string().regex(/^\d{10,13}$/),
  eventId: z.string().trim().min(1).max(240),
  signature: z.string().regex(/^v1=[0-9a-fA-F]{64}$/),
  idempotencyKey: z.string().trim().min(8).max(200).optional()
});
