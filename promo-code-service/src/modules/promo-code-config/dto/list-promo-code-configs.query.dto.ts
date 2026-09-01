/**
 * T-PC-011. Query-param validation for `GET /api/v1/promo-code-configs` (`04-API-CONTRACT.md`
 * §1, implementation note 6): `tenantId` required, `merchantId` optional, `status` optional and
 * defaulting server-side to `'ACTIVE'` — the default is applied **here**, not left to whatever
 * `PromoCodeConfigRepository.list` happens to default to (T-PC-010), so the REST contract is
 * self-documenting at the API boundary rather than depending on an implementation detail one
 * layer down.
 *
 * Uses `zod`, matching this module's existing convention (`dto/create-promo-code-config.dto.ts`'s
 * own header explains why: this project has no `class-validator`/`class-transformer` dependency,
 * and adding one means editing `package.json`, which `project.config.json` grants only to
 * `agent-promo-foundation` — outside this task's own file scope). See the completion report's
 * "Deviations from spec" for the same note against the task file's mention of `class-validator`.
 */
import { z } from 'zod';
import { PromoCodeConfigValidationError } from '../promo-code-config.errors';

export const listPromoCodeConfigsQuerySchema = z.object({
  // T-PC-053: portal-sourced ids (T-PC-052 widened both columns to varchar(64)); no longer
  // required to be UUID-shaped — validate at the same boundary the DB will actually accept.
  tenantId: z.string().min(1, 'tenantId is required').max(64, 'tenantId must be <= 64 characters'),
  merchantId: z
    .string()
    .min(1, 'merchantId is required')
    .max(64, 'merchantId must be <= 64 characters')
    .optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).default('ACTIVE'),
});

export type ListPromoCodeConfigsQueryDto = z.infer<typeof listPromoCodeConfigsQuerySchema>;

export function parseListPromoCodeConfigsQuery(input: unknown): ListPromoCodeConfigsQueryDto {
  const result = listPromoCodeConfigsQuerySchema.safeParse(input);
  if (!result.success) {
    throw new PromoCodeConfigValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
