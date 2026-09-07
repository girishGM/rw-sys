/**
 * T-RR-031. Wire shapes for `PromoCodeServiceConnector`'s outbound
 * `POST /api/v1/promo-codes/generate` call — quoted verbatim from `04-REST-CONTRACT.md` §2 (the
 * authoritative shape; confirmed identical in spirit to
 * `promo-code-service-plan/02-KAFKA-CONTRACTS.md` §3's own Kafka-transport sibling of the same
 * contract). Kept in their own file, separate from `promo-code-service.connector.ts`, purely so
 * the wire shape and the connector logic that builds/consumes it are easy to diff against the doc
 * independently — same file-split convention `reward-tracking-outbox.repository.ts`'s own
 * `RewardTrackingDispatchPayload` establishes for its sibling wire shape.
 */

/** `01-DATABASE.md` §1's own three campaign-structure levels a reward can hang off, reused here
 * as the request's `bindLevel` enum — `promo-code-service-plan/01-DATABASE.md` §3 confirms these
 * are the only three values `campaign_promo_config.bind_level`'s own CHECK constraint accepts. */
export type PromoCodeBindLevel = 'CAMPAIGN' | 'TRACKER' | 'COMPONENT';

/** The exact request body `04-REST-CONTRACT.md` §2 quotes — every field a string (including
 * `tenantId`, despite being an `int` column on `reward_redemption_entry`, per that section's own
 * "confirm the exact string coercion against the quoted JSON" note), nothing invented, nothing
 * omitted. */
export interface PromoCodeGenerateRequest {
  correlationId: string;
  tenantId: string;
  bindLevel: PromoCodeBindLevel;
  bindRefId: string;
  customerId: string;
  merchantId: string;
  activityContext: {
    amount: string;
    currency: string;
    metadataJson: string;
  };
}

/** The exact `200` response body shape `04-REST-CONTRACT.md` §2 quotes — "response is always
 * `200`, with the business outcome inside the body" (also confirmed directly against
 * `promo-code-service-plan/04-API-CONTRACT.md` §5's identical framing). `errorCode`/`errorMessage`
 * are empty strings (not absent keys) on a `SUCCESS` response, and the reward-shape fields are
 * empty strings on a `FAILED` one — mirrored here as always-present, never optional, exactly as
 * the quoted JSON shows. */
export interface PromoCodeGenerateResponse {
  status: 'SUCCESS' | 'FAILED';
  promoCodeId: string;
  code: string;
  rewardValueType: string;
  rewardValue: string;
  rewardUnit: string;
  expiresAt: string;
  errorCode: string;
  errorMessage: string;
}
