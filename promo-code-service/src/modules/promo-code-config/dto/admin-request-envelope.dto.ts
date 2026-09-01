/**
 * T-PC-011. The `tenantId`/`actorId` envelope every admin CRUD request carries alongside its
 * own field-specific body — this service has no portal user session to derive either from
 * (`AGENT-PROTOCOL.md` R3's own framing: "there is no portal user session inside this
 * service... every write is still re-validated against the resource it targets"), so the
 * verified internal caller (the portal backend) supplies both explicitly, and
 * `PromoCodeConfigRepository` (T-PC-010) is what actually enforces the `tenantId` boundary —
 * this DTO only checks *shape* (present, well-formed UUID), never trust.
 *
 * `actorId` becomes `created_by`/`updated_by` on the row and the audit trail's `changed_by`
 * (`01-DATABASE.md` §5) — required on every write, per implementation note 4's "every write is
 * audited" and this task's own DoD note tying Gate G1 to that guarantee.
 *
 * `create`/`update` request bodies also carry the field-specific payload
 * (`name`/`codeLength`/... for create, a partial subset for update) alongside this envelope.
 * Those fields are validated by `PromoCodeConfigService`'s own `zod` schemas
 * (`dto/create-promo-code-config.dto.ts`/`dto/update-promo-code-config.dto.ts`, T-PC-010) when
 * the full body is forwarded to `create`/`update` — `zod`'s default "strip unknown keys"
 * behaviour on a plain (non-`.strict()`) object means `tenantId`/`actorId` are silently dropped
 * before they'd ever reach a query, so passing the whole body through is safe, not just
 * convenient.
 */
import { z } from 'zod';
import { PromoCodeConfigValidationError } from '../promo-code-config.errors';

const adminRequestEnvelopeSchema = z.object({
  tenantId: z.string().uuid('tenantId must be a valid UUID'),
  actorId: z.string().uuid('actorId must be a valid UUID'),
});

export interface AdminRequestEnvelope {
  tenantId: string;
  actorId: string;
}

export function parseAdminRequestEnvelope(input: unknown): AdminRequestEnvelope {
  const result = adminRequestEnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw new PromoCodeConfigValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
