/**
 * T-PC-012. Structural validation for `POST /api/v1/campaign-promo-configs`
 * (`04-API-CONTRACT.md` §2), using `zod` — same library/convention as
 * `promo-code-config/dto/create-promo-code-config.dto.ts` (T-PC-010), no
 * `class-validator`/`class-transformer` dependency in this project.
 *
 * Implementation note 4: `bindRefId` is validated only as a well-formed, portal-shaped id (T-PC-053:
 * non-empty, <= 64 characters — matching the `varchar(64)` column T-PC-052 widened it to; not
 * required to be a UUID), never resolved against the portal's own campaign/tracker/component
 * existence — this service's database "must never depend on the portal's schema being reachable"
 * (`01-DATABASE.md` §2). `bindLevel` is
 * validated against exactly the three enum values the DB `CHECK` constraint also enforces
 * (TC-9: an invalid value like `'CAMPAIGNX'` is a `400`, caught here before ever reaching
 * Postgres).
 */
import { z } from 'zod';
import { CampaignBindingValidationError } from '../campaign-binding.errors';

export const createCampaignPromoConfigSchema = z.object({
  // This service's own generated key — stays a genuine UUID, untouched by T-PC-053.
  promoCodeConfigId: z.string().uuid('promoCodeConfigId must be a valid UUID'),
  // T-PC-053: portal-sourced ids (T-PC-052 widened these columns to varchar(64)); no longer
  // required to be UUID-shaped — validate at the same boundary the DB will actually accept.
  tenantId: z.string().min(1, 'tenantId is required').max(64, 'tenantId must be <= 64 characters'),
  bindLevel: z.enum(['CAMPAIGN', 'TRACKER', 'COMPONENT'], {
    errorMap: () => ({ message: 'bindLevel must be one of CAMPAIGN, TRACKER, COMPONENT' }),
  }),
  bindRefId: z
    .string()
    .min(1, 'bindRefId is required')
    .max(64, 'bindRefId must be <= 64 characters'),
  boundBy: z.string().min(1, 'boundBy is required').max(64, 'boundBy must be <= 64 characters'),
});

export type CreateCampaignPromoConfigDto = z.infer<typeof createCampaignPromoConfigSchema>;

export function parseCreateCampaignPromoConfigDto(input: unknown): CreateCampaignPromoConfigDto {
  const result = createCampaignPromoConfigSchema.safeParse(input);
  if (!result.success) {
    throw new CampaignBindingValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
