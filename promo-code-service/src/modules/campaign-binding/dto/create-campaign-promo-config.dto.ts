/**
 * T-PC-012. Structural validation for `POST /api/v1/campaign-promo-configs`
 * (`04-API-CONTRACT.md` §2), using `zod` — same library/convention as
 * `promo-code-config/dto/create-promo-code-config.dto.ts` (T-PC-010), no
 * `class-validator`/`class-transformer` dependency in this project.
 *
 * Implementation note 4: `bindRefId` is validated only as a well-formed UUID, never resolved
 * against the portal's own campaign/tracker/component existence — this service's database "must
 * never depend on the portal's schema being reachable" (`01-DATABASE.md` §2). `bindLevel` is
 * validated against exactly the three enum values the DB `CHECK` constraint also enforces
 * (TC-9: an invalid value like `'CAMPAIGNX'` is a `400`, caught here before ever reaching
 * Postgres).
 */
import { z } from 'zod';
import { CampaignBindingValidationError } from '../campaign-binding.errors';

export const createCampaignPromoConfigSchema = z.object({
  promoCodeConfigId: z.string().uuid('promoCodeConfigId must be a valid UUID'),
  tenantId: z.string().uuid('tenantId must be a valid UUID'),
  bindLevel: z.enum(['CAMPAIGN', 'TRACKER', 'COMPONENT'], {
    errorMap: () => ({ message: 'bindLevel must be one of CAMPAIGN, TRACKER, COMPONENT' }),
  }),
  bindRefId: z.string().uuid('bindRefId must be a valid UUID'),
  boundBy: z.string().uuid('boundBy must be a valid UUID'),
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
