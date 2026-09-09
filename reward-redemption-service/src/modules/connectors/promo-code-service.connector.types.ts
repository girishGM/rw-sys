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
  /** T-RR-090. The frozen `reward_redemption_entry.promo_code_config_version_no` (`T-RR-062`) this
   * entry was claimed under — read, never re-resolved (this task's own implementation note 1) —
   * coerced to a string per `promo-code-service-plan/04-API-CONTRACT.md`'s own `versionNo` (string
   * \| null) addendum, mirrored identically by `02-KAFKA-CONTRACTS.md` §3 and
   * `03-GRPC-CONTRACT.md` §1's `GenerateCodeRequest.version_no`. `null` is the legitimate,
   * backward-compatible value for any entry that predates that stamping (implementation note 2) —
   * never synthesized. **Not necessarily what actually goes on the wire as-is**: the real REST
   * server schema (`generate-code-request.dto.ts`, confirmed by direct read) declares this field
   * `z.string().min(1).optional()`, not `.nullable()` — sending a literal JSON `null` fails that
   * validation (`400`) instead of falling back to the binding's own pin the way an *absent* field
   * does, so the REST call site omits the key entirely when this is `null` rather than serializing
   * it (see `toRestRequestBody` in `promo-code-service.connector.ts`). The gRPC/Kafka call sites
   * each apply their own transport's correct null-representation at their own boundary instead
   * (proto3 empty-string default for gRPC, JSON `null` for Kafka, per those two contracts' own
   * documented conventions) — this field itself stays the one canonical `string | null` shape every
   * transport starts from, never three independently-typed copies. Typed **optional** (`?`), not
   * just nullable — this connector's own request-building code (`buildRequestBody`) always sets it
   * explicitly, but several object-literal fixtures across the tree predate this field
   * (`test/e2e/fixtures/reward-entry.fixtures.ts`, outside this task's file scope, R3) and must keep
   * compiling unchanged; `undefined` is treated identically to `null` everywhere this is read. */
  versionNo?: string | null;
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
  /** T-RR-090. The `promo_code_config_version.version_no` actually used to generate this code —
   * echoed back by promo-code-service (`04-API-CONTRACT.md`'s `T-PC-060` addendum: "the resolved
   * version actually used, `null` on `FAILED`"), genuinely `string | null` (unlike every field
   * above, which use this response's always-present-empty-string convention) — the design doc
   * itself specifies this one field as nullable, not empty-string-on-absence. Logged into
   * `external_system_call_log.response_summary` automatically (`writeCallLog` serializes the whole
   * response body), which is what lets a support engineer answer "which recipe generated this
   * specific code" without a separate query (implementation note 4). Typed **optional** (`?`) for
   * the identical "pre-existing fixtures across the tree must keep compiling" reason the request's
   * own `versionNo` doc comment (above) explains. */
  versionNo?: string | null;
}
