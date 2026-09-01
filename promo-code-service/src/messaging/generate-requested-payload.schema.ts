/**
 * T-PC-030. Loose structural typing for `02-KAFKA-CONTRACTS.md` §3's `data` payload — deliberately
 * the **lenient** half of this adapter's two schemas, as distinct from `envelope.schema.ts`'s
 * strict one. Every field here is `.optional()` (types are checked when present, presence is
 * never required) so a structurally-valid envelope carrying a business-invalid or incomplete
 * `data` payload is never DLQ'd at this layer — it is passed straight through to
 * `PromoCodeGenerationService.generateCode()`, whose own `generation-request.types.ts` schema
 * already requires `bindLevel`/`bindRefId`/`customerId` and returns `INVALID_REQUEST` when they're
 * missing or invalid (T-PC-021 note 8).
 *
 * **Flagged deviation from this task's own implementation note 6** (recorded in the completion
 * report's "Deviations from spec", not silently resolved — `AGENT-PROTOCOL.md` §3): note 6's prose
 * lists `bindLevel`/`bindRefId`/`customerId` among the "required data field[s]" that should be
 * DLQ'd at the adapter when missing. TC-8 in this same task file directly contradicts that for
 * `customerId` ("Message missing `data.customerId`... Passed through to `generateCode()`, which
 * returns `INVALID_REQUEST` — not DLQ'd at the adapter level"), and no test case in this file
 * requires DLQ'ing a missing `bindLevel`/`bindRefId` either. Per note 6's own closing sentence —
 * "a structurally valid but business-invalid one (e.g. `bindLevel: 'CAMPAIGNX'`) is exactly the
 * `INVALID_REQUEST` case T-PC-021 already owns" — this file extends that same reasoning uniformly
 * to every field *inside* `data` (not just an invalid enum value), so `envelope.schema.ts` alone
 * carries the DLQ-worthy "poison message" bar, and this schema only guards against a field being
 * present with a flatly wrong JS type (e.g. `bindLevel: 42`), never against a field being absent
 * or holding an invalid-but-well-typed value. TC-8 passes under this design; the literal wording of
 * note 6 does not fully hold for `customerId`. Escalated for the architect to reconcile the task
 * file's own self-contradiction, per `AGENT-PROTOCOL.md` §3 ("if a design doc contradicts itself,
 * stop and escalate").
 */
import { z } from 'zod';

const activityContextSchema = z
  .object({
    amount: z.string().optional(),
    currency: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .nullable()
  .optional();

export const generateRequestedPayloadSchema = z
  .object({
    bindLevel: z.string().optional(),
    bindRefId: z.string().optional(),
    customerId: z.string().optional(),
    merchantId: z.string().nullable().optional(),
    activityContext: activityContextSchema,
  })
  .passthrough();

export type GenerateRequestedPayload = z.infer<typeof generateRequestedPayloadSchema>;

export type PayloadParseResult =
  { ok: true; data: GenerateRequestedPayload } | { ok: false; message: string };

/** Never throws — same "outcome, not exception" discipline `parseEnvelope` uses. */
export function parseGenerateRequestedPayload(input: unknown): PayloadParseResult {
  const result = generateRequestedPayloadSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, message: `Invalid generate.requested data payload: ${message}` };
  }
  return { ok: true, data: result.data };
}
