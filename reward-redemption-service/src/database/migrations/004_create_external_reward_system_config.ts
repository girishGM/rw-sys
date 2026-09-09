import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `external_reward_system_config` — connector config + retryable-error-code cache source
 * (`01-DATABASE.md` §3). This service needs its own copy of what `ARCHITECTURE.md` §8 explains
 * the portal's gRPC feed never serves (`reward_config.reward_systems.connector_config` is never
 * exposed to any consumer, R9) — `endpoint_url`/`auth_secret_ref`/`retryable_error_codes` all
 * live here instead, authored operationally (not seeded by this migration — T-RR-003 note 3).
 *
 * `tenant_key = coalesce(tenant_id, -1)` is the same generated-column uniqueness trick root
 * `CLAUDE.md`'s AR-02 decision established for the portal's own `campaign_caps`/
 * `grpc_service_grants` (confirmed by direct read of `portal/back-end/src/database/migrations/
 * T006_001_campaign_caps.ts`'s own `dedupe_key` column) — reused here rather than requiring
 * Postgres 15's `NULLS NOT DISTINCT`, for the identical "no minimum Postgres version" reason. A
 * NULL `tenant_id` row (applies to every tenant) and a real-`tenant_id` row for the same
 * `system_code` can coexist; two NULL rows for the same `system_code` cannot (TC-2).
 *
 * `retryable_error_codes` defaults to `'[]'::jsonb`, never `NULL` (TC-3) — the retry
 * classification module (T-RR-023, R7) reads this column directly as "the list to check
 * membership against," and a `NULL` there would make every error code look retryable-checkable
 * against nothing rather than deterministically non-retryable.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.external_reward_system_config (
      id                          int          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      system_code                 varchar(50)  NOT NULL,
      tenant_id                   int          NULL,
      connector_type              varchar(30)  NOT NULL,
      endpoint_url                text         NOT NULL,
      auth_secret_ref             varchar(200) NOT NULL,
      retryable_error_codes       jsonb        NOT NULL DEFAULT '[]',
      max_retry_attempts          int          NOT NULL DEFAULT 5,
      retry_backoff_base_ms       int          NOT NULL DEFAULT 500,
      retry_backoff_max_ms        int          NOT NULL DEFAULT 30000,
      status                      varchar(20)  NOT NULL DEFAULT 'active',
      created_at                  timestamptz  NOT NULL DEFAULT now(),
      updated_at                  timestamptz  NOT NULL DEFAULT now(),
      tenant_key                  int GENERATED ALWAYS AS (coalesce(tenant_id, -1)) STORED,
      CONSTRAINT uq_ersc_system_tenant UNIQUE (system_code, tenant_key)
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.external_reward_system_config;', {
    type: QueryTypes.RAW,
  });
}
