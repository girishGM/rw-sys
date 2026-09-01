/**
 * T-PC-010. Structural + cross-field validation for a new `promo_code_config`, using `zod` —
 * the same validation library `src/config/config.schema.ts` already uses (this project has no
 * `class-validator`/`class-transformer` dependency; introducing one would mean editing
 * `package.json`, which is outside this task's file scope — `project.config.json` grants that
 * file only to `agent-promo-foundation`).
 *
 * Every numeric/length bound here matches the DB `CHECK` constraint it stands in front of
 * (`01-DATABASE.md` §1) — a config that fails this check is rejected before it ever reaches
 * Postgres (implementation note 3, TC-5).
 */
import { z } from 'zod';
import { PromoCodeConfigValidationError } from '../promo-code-config.errors';

/**
 * `rewardUnit` legality for a given `rewardValueType` (implementation note 2): `FIXED_AMOUNT`
 * requires an ISO-4217-shaped currency code (three uppercase letters), `PERCENTAGE` requires
 * the literal string `%`, `POINTS` requires a non-empty points-unit name. Exported so the
 * service layer can reuse the exact same rule when validating an update that only partially
 * touches these fields (see `update-promo-code-config.dto.ts`).
 */
export function isValidRewardUnit(rewardValueType: string, rewardUnit: string): boolean {
  switch (rewardValueType) {
    case 'FIXED_AMOUNT':
      return /^[A-Z]{3}$/.test(rewardUnit);
    case 'PERCENTAGE':
      return rewardUnit === '%';
    case 'POINTS':
      return rewardUnit.trim().length > 0;
    default:
      return false;
  }
}

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

export const createPromoCodeConfigSchema = z
  .object({
    // T-PC-053: portal-sourced id (T-PC-052 widened `merchant_id` to varchar(64)); no longer
    // required to be UUID-shaped.
    merchantId: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1, 'name is required').max(120),
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

export type CreatePromoCodeConfigDto = z.infer<typeof createPromoCodeConfigSchema>;

export function parseCreatePromoCodeConfigDto(input: unknown): CreatePromoCodeConfigDto {
  const result = createPromoCodeConfigSchema.safeParse(input);
  if (!result.success) {
    throw new PromoCodeConfigValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
