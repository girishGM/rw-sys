/**
 * T-PC-058. Structural + cross-field validation for `POST /api/v1/promo-code-configs/:id/versions`
 * — a brand-new `draft` version's own payout-defining fields, deliberately the same field set (and
 * the same bounds/enum values) as `create-promo-code-config.dto.ts`'s `createPromoCodeConfigSchema`
 * minus the identity-only `name`/`merchantId` pair, since those never move to a new version (they
 * stay on the enduring identity row).
 *
 * Reuses `isValidRewardUnit` from `create-promo-code-config.dto.ts` rather than redefining the
 * cross-check — a single source of truth for "what `rewardUnit` values are legal for a given
 * `rewardValueType`", the same rule this task's own DB trigger/migration never re-derives either.
 */
import { z } from 'zod';
import { PromoCodeConfigValidationError } from '../promo-code-config.errors';
import { isValidRewardUnit } from './create-promo-code-config.dto';

const rewardUnitCrossCheck = (
  data: { rewardValueType: string; rewardUnit: string },
  ctx: z.RefinementCtx,
): void => {
  if (!isValidRewardUnit(data.rewardValueType, data.rewardUnit)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rewardUnit'],
      message: `"${data.rewardUnit}" is not a legal rewardUnit for rewardValueType "${data.rewardValueType}"`,
    });
  }
};

export const createPromoCodeConfigVersionSchema = z
  .object({
    codePrefix: z.string().max(10).optional(),
    codePostfix: z.string().max(10).optional(),
    codeLength: z
      .number()
      .int('codeLength must be an integer')
      .min(4, 'codeLength must be >= 4')
      .max(32, 'codeLength must be <= 32'),
    characterSet: z.enum(['NUMERIC', 'ALPHA', 'ALPHANUMERIC']),
    excludeAmbiguousChars: z.boolean().default(true),
    rewardValueType: z.enum(['FIXED_AMOUNT', 'PERCENTAGE', 'POINTS']),
    rewardValue: z.number().positive('rewardValue must be > 0'),
    rewardUnit: z.string().trim().min(1, 'rewardUnit is required').max(10),
    maxRedemptionsPerCode: z.number().int().positive().default(1),
    codeExpiryDays: z.number().int().positive().optional(),
  })
  .superRefine(rewardUnitCrossCheck);

export type CreatePromoCodeConfigVersionDto = z.infer<typeof createPromoCodeConfigVersionSchema>;

export function parseCreatePromoCodeConfigVersionDto(
  input: unknown,
): CreatePromoCodeConfigVersionDto {
  const result = createPromoCodeConfigVersionSchema.safeParse(input);
  if (!result.success) {
    throw new PromoCodeConfigValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
