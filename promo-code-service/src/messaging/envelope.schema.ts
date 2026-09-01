/**
 * T-PC-030. Structural validation for `02-KAFKA-CONTRACTS.md` §2's common envelope — the strict
 * half of this adapter's two schemas (implementation note 6: "a structurally malformed message is
 * this adapter's problem [DLQ]"). Every field here is envelope wire-structure, never business
 * content — `eventId`/`eventType`/`eventVersion`/`occurredAt`/`correlationId`/`tenantId`/`source`
 * must all be present and well-formed or the message is poison (TC-3: missing `correlationId`).
 * `data` itself must be an object (its own *contents* are `generate-requested-payload.schema.ts`'s
 * much looser job — see that file's header for exactly where and why the split falls).
 */
import { z } from 'zod';

export const envelopeSchema = z.object({
  eventId: z.string().uuid('eventId must be a valid UUID'),
  eventType: z.string().min(1, 'eventType is required'),
  eventVersion: z.string().min(1, 'eventVersion is required'),
  occurredAt: z.string().datetime({ message: 'occurredAt must be an ISO 8601 datetime string' }),
  correlationId: z.string().uuid('correlationId must be a valid UUID'),
  // Portal-sourced, not this service's own key — a plain external identifier, never required to
  // be UUID-shaped (T-PC-055, matching T-PC-052's `varchar(64)` column and T-PC-053/054's same
  // bound on every other portal-sourced id field). `eventId`/`correlationId` above stay UUID:
  // those are this service's own keys.
  tenantId: z
    .string()
    .min(1, 'tenantId is required')
    .max(64, 'tenantId must be at most 64 characters'),
  source: z.string().min(1, 'source is required'),
  data: z.record(z.unknown()),
});

export type Envelope = z.infer<typeof envelopeSchema>;

export type EnvelopeParseResult = { ok: true; data: Envelope } | { ok: false; message: string };

/**
 * Never throws — returns a typed result, same "outcome, not exception" discipline
 * `parseGenerationRequest` (T-PC-021) already established, so `generate-requested.consumer.ts`
 * can treat a validation failure identically to any other retry-then-DLQ candidate.
 */
export function parseEnvelope(input: unknown): EnvelopeParseResult {
  const result = envelopeSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, message: `Invalid envelope: ${message}` };
  }
  return { ok: true, data: result.data };
}
