/**
 * T-PC-010. Partial update — every field optional, `status` deliberately excluded (archiving is
 * its own explicit `PromoCodeConfigService.archive(...)` operation, not a side effect of a
 * general-purpose field update — implementation note 4: archive "sets `status = 'ARCHIVED'`,
 * never deletes the row", and only that one dedicated path may make that transition).
 *
 * The `rewardUnit`-vs-`rewardValueType` cross-field rule (`create-promo-code-config.dto.ts`'s
 * `isValidRewardUnit`) is **not** re-applied inside this schema: an update may touch only one of
 * the two fields, and this schema has no visibility into the row's current value for the field
 * left unset. The service layer merges this DTO onto the existing row and re-runs
 * `isValidRewardUnit` against the merged result before persisting (see
 * `promo-code-config.service.ts`), so the same invariant still holds — just one layer up, where
 * the full picture is actually available.
 */
import { z } from 'zod';
import { PromoCodeConfigValidationError } from '../promo-code-config.errors';

export const updatePromoCodeConfigSchema = z
  .object({
    merchantId: z.string().uuid().nullable(),
    name: z.string().trim().min(1, 'name is required').max(120),
    codePrefix: z.string().max(10).nullable(),
    codePostfix: z.string().max(10).nullable(),
    codeLength: z
      .number()
      .int('codeLength must be an integer')
      .min(4, 'codeLength must be >= 4')
      .max(32, 'codeLength must be <= 32'),
    characterSet: z.enum(['NUMERIC', 'ALPHA', 'ALPHANUMERIC']),
    excludeAmbiguousChars: z.boolean(),
    rewardValueType: z.enum(['FIXED_AMOUNT', 'PERCENTAGE', 'POINTS']),
    rewardValue: z.number().positive('rewardValue must be > 0'),
    rewardUnit: z.string().trim().min(1, 'rewardUnit is required').max(10),
    maxRedemptionsPerCode: z.number().int().positive(),
    codeExpiryDays: z.number().int().positive().nullable(),
  })
  .partial();

export type UpdatePromoCodeConfigDto = z.infer<typeof updatePromoCodeConfigSchema>;

export function parseUpdatePromoCodeConfigDto(input: unknown): UpdatePromoCodeConfigDto {
  const result = updatePromoCodeConfigSchema.safeParse(input);
  if (!result.success) {
    throw new PromoCodeConfigValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
