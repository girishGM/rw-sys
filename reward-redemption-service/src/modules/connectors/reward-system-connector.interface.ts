/**
 * T-RR-030. `RewardSystemConnector` — the one call shape every external-system connector
 * (`PromoCodeServiceConnector`, T-RR-031; `CoreBankingConnector`, T-RR-032) implements, and the
 * only thing `05-PROCESSING-PIPELINE.md` §4/§5/§6/§7's resolution/classification/orchestration
 * code (Wave 2, already built) ever calls into or inspects
 * (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §1, exactly).
 *
 * `RedemptionResult`'s three outcome literals (`SUCCESS`/`RETRYABLE_FAILURE`/`PERMANENT_FAILURE`)
 * are not this task's own invention — they are the exact three strings T-RR-021/T-RR-024's
 * transaction handling already matches on (implementation note 1). Do not add a fourth outcome and
 * do not rename any of the three that exist; a connector's own job is to reduce whatever
 * transport/business error it actually hit down to one of these (§1's own framing), never to leak
 * a connector-specific shape past this boundary.
 *
 * `ClaimedRewardEntry`/`ExternalRewardSystemConfig` reuse this service's own existing row types
 * (`@/database/models/reward-redemption-entry.model`, `@/database/models/external-reward-system-config.model`)
 * rather than re-declaring a parallel shape that could drift from them: a connector receives
 * exactly the claimed row — with whatever `06-CACHING-AND-TENANT-CONFIG.md` §5 enrichment (e.g.
 * `country_code`/`tenant_code`) is already stamped onto it by the time it reaches this step — and
 * the resolved connector-config row field-for-field (implementation note 4: `retryable_error_codes`,
 * `max_retry_attempts`, `retry_backoff_base_ms`, `retry_backoff_max_ms`, `endpoint_url`,
 * `auth_secret_ref`, and the rest of the row), so a connector never needs a second lookup of its
 * own. Importing these two model files only (never anything from `src/modules/redemption/**` or
 * `src/modules/processing/**`) keeps this module a pure lookup/type boundary, per implementation
 * note 6.
 */
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';

/** The claimed `reward_redemption_entry` row (`01-DATABASE.md` §1) a connector redeems, including
 * whatever tenant/country enrichment `06-CACHING-AND-TENANT-CONFIG.md` §5 has already stamped onto
 * it by the time the pipeline reaches this step. */
export type ClaimedRewardEntry = RewardRedemptionEntryRow;

/** The resolved `external_reward_system_config` row (`01-DATABASE.md` §3) for the entry's
 * `system_code`/tenant, mirrored field-for-field — including `auth_secret_ref` (a *reference*
 * only, never the credential value itself, R9) and the cached `retryable_error_codes` a connector
 * does not classify against directly (that judgment belongs to `RetryClassificationService`,
 * T-RR-023) but may need to pass through to it. */
export type ExternalRewardSystemConfig = ExternalRewardSystemConfigRow;

/** A connector's own observable outcome, reduced to exactly one of these three
 * (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §1). Discriminated on `outcome` so a caller checks it
 * once and TypeScript narrows the rest, matching `RetryClassificationService`'s own
 * `ClassificationResult` convention (R2). */
export type RedemptionResult =
  | { outcome: 'SUCCESS'; externalReferenceId: string; responseSummary: Record<string, unknown> }
  | { outcome: 'RETRYABLE_FAILURE'; errorCode: string | null; errorMessage: string }
  | { outcome: 'PERMANENT_FAILURE'; errorCode: string | null; errorMessage: string };

/** Implemented once per `connector_type` (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §4) — the
 * pipeline never branches on which concrete connector it is talking to (R10 applied to
 * external-system adapters). */
export interface RewardSystemConnector {
  redeem(
    entry: ClaimedRewardEntry,
    connectorConfig: ExternalRewardSystemConfig,
  ): Promise<RedemptionResult>;
}
