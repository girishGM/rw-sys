/**
 * The wire shape of `promo-code-service`'s `POST /api/v1/promo-codes/generate`
 * (`promo-code-service/src/modules/generation/dto/generate-code-{request,response}.dto.ts`,
 * T-PC-056) — hand-declared here for the same reason `portal-client/types.ts` hand-declares the
 * portal's own shapes: this app has no dependency on that service's own workspace.
 */

export const BIND_LEVELS = ['CAMPAIGN', 'TRACKER', 'COMPONENT'] as const;
export type BindLevel = (typeof BIND_LEVELS)[number];

export interface GenerateCodeRequest {
  readonly correlationId: string;
  /** The portal's own tenant id, as a decimal string — never a UUID (see
   * `promo-code-service/CLAUDE.md`'s "Traps already hit once" #1). */
  readonly tenantId: string;
  readonly bindLevel: BindLevel;
  readonly bindRefId: string;
  readonly customerId: string;
  readonly merchantId?: string;
  readonly activityContext?: {
    readonly amount?: string;
    readonly currency?: string;
    readonly metadata?: Record<string, unknown>;
  };
}

/** Always HTTP 200 from the real endpoint — `status` carries the business outcome. */
export interface GenerateCodeResult {
  readonly status: 'SUCCESS' | 'FAILED';
  readonly promoCodeId: string | null;
  readonly code: string | null;
  readonly rewardValueType: string | null;
  readonly rewardValue: string | null;
  readonly rewardUnit: string | null;
  readonly expiresAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}
