import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-046. Demo `external_reward_system_config` row (`01-DATABASE.md` §3) for
 * `connector_type = 'PROMO_CODE_SERVICE'`, per this task's own scope note and
 * `ARCHITECTURE.md` §8/`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §2 — `retryable_error_codes` seeded
 * with exactly `["GENERATION_EXHAUSTED"]`, the one retryable error code promo-code-service's own
 * `04-API-CONTRACT.md` documents for its generate endpoint.
 *
 * `system_code`/`connector_type` both `'PROMO_CODE_SERVICE'` — matches the value this service's
 * own test fixtures already use for this exact scenario
 * (`test/e2e/fixtures/reward-entry.fixtures.ts`'s `buildPromoCodeConnectorConfig`), so this demo
 * row is shaped exactly like what a real, working row looks like, not an invented shape.
 *
 * `tenant_id: NULL` — applies to every tenant (no tenant-specific override needed for a demo).
 *
 * `endpoint_url` points at this service's own local-dev expectation for promo-code-service
 * (`localhost:3010`, `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1's own port-allocation note) —
 * this is data, not a secret (R1 only forbids a credential/connection-string, not a plain
 * hostname), but it is NOT a real Render URL: `docs/render-migration-runbook.md` §"Post-seed
 * follow-up" tells the operator to update this row's `endpoint_url` to the actual deployed
 * promo-code-service address before this demo row is relied on outside local dev.
 *
 * `auth_secret_ref` is the environment variable **name** this service's own
 * `PromoCodeServiceConnector` already reads for its outbound credential
 * (`GENERATION_SERVICE_TOKEN`, `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1) — never the secret
 * value itself (R9).
 */
const DEMO_SYSTEM_CODE = 'PROMO_CODE_SERVICE';
const DEMO_CONNECTOR_TYPE = 'PROMO_CODE_SERVICE';
const DEMO_ENDPOINT_URL = 'http://localhost:3010/api/v1/promo-codes/generate';
const DEMO_AUTH_SECRET_REF = 'GENERATION_SERVICE_TOKEN';
const DEMO_RETRYABLE_ERROR_CODES = JSON.stringify(['GENERATION_EXHAUSTED']);

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `INSERT INTO reward_redemption.external_reward_system_config
       (system_code, tenant_id, connector_type, endpoint_url, auth_secret_ref,
        retryable_error_codes, max_retry_attempts, retry_backoff_base_ms, retry_backoff_max_ms,
        status)
     VALUES (:systemCode, NULL, :connectorType, :endpointUrl, :authSecretRef,
             :retryableErrorCodes::jsonb, 5, 500, 30000, 'active');`,
    {
      type: QueryTypes.RAW,
      replacements: {
        systemCode: DEMO_SYSTEM_CODE,
        connectorType: DEMO_CONNECTOR_TYPE,
        endpointUrl: DEMO_ENDPOINT_URL,
        authSecretRef: DEMO_AUTH_SECRET_REF,
        retryableErrorCodes: DEMO_RETRYABLE_ERROR_CODES,
      },
    },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `DELETE FROM reward_redemption.external_reward_system_config
     WHERE system_code = :systemCode AND tenant_id IS NULL;`,
    { type: QueryTypes.RAW, replacements: { systemCode: DEMO_SYSTEM_CODE } },
  );
}
