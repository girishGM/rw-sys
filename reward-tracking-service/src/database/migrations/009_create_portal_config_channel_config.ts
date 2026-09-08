import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-013. `reward_tracking.portal_config_channel_config` — campaign-level REST-vs-gRPC
 * routing for this service's own outbound feed of the portal's `CampaignConfigService`
 * (`ARCHITECTURE.md` finding 2, `TRANSPORT-CONFIG.md`'s `reward-tracking-service` /
 * `portal-config` row), consumed by `CampaignHierarchyClient`
 * (`../../modules/campaign-cache/campaign-hierarchy.client.ts`).
 *
 * Shape ported from `reward-redemption-service`'s own `promo_code_channel_config`
 * (migration `018`) — the reference pattern this whole plan reuses (`ARCHITECTURE.md` §4) — with
 * two deliberate differences, both disclosed in this task's own completion report:
 *
 *  1. **No `kafka_enabled`/`'KAFKA'` option.** `TRANSPORT-CONFIG.md`'s own registry entry for this
 *     leg (and for every other `portal-config` leg in this plan) lists `Options: REST, GRPC` only —
 *     portal campaign-config distribution has never had a Kafka leg anywhere in this plan
 *     (`ARCHITECTURE.md` finding 1: "gRPC (primary) with REST as fallback").
 *  2. **`scope_level` is `'CAMPAIGN' | 'GLOBAL'` only, not the full `REWARD`/`TRACKER`/`CAMPAIGN`/
 *     `GLOBAL` four-level precedence `ARCHITECTURE.md` §4 describes as the general shape.**
 *     `CampaignHierarchyClient` only ever operates per-tenant/per-campaign (it has no reward or
 *     tracker-scoped call site at all — `DEFAULT_CONFIG_SECTIONS` never even requests
 *     RULES/REWARDS) — a REWARD/TRACKER scope level could never be populated with a meaningful
 *     `scope_ref_code` from this client's own call sites, so the column stays `varchar(10)` (room
 *     to widen later without a migration) but only `CAMPAIGN`/`GLOBAL` rows are ever written or
 *     queried by this task's own resolver.
 *
 * Seeded `GLOBAL` row: `primary_channel='REST'` (R1 — Render's free tier can't run gRPC today),
 * `fallback_channel='GRPC'`, both `rest_enabled`/`grpc_enabled` true (R1: gRPC must stay fully
 * implemented and locally testable even though REST is primary) — the exact same
 * "reproduces today's actual behavior for the general case, deliberately switchable via
 * `set-transport-primary.js` only" contract migration `018`'s own header documents.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_tracking.portal_config_channel_config (
      id                int         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      scope_level       varchar(10) NOT NULL,
      scope_ref_code    varchar(80) NULL,
      tenant_id         int         NULL,
      rest_enabled      boolean     NOT NULL DEFAULT true,
      grpc_enabled      boolean     NOT NULL DEFAULT true,
      primary_channel   varchar(10) NOT NULL DEFAULT 'REST',
      fallback_channel  varchar(10) NOT NULL DEFAULT 'GRPC',
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_pccc_scope UNIQUE (scope_level, scope_ref_code, tenant_id),
      CONSTRAINT ck_pccc_scope_level CHECK (scope_level IN ('CAMPAIGN', 'GLOBAL')),
      CONSTRAINT ck_pccc_primary_channel CHECK (primary_channel IN ('REST', 'GRPC')),
      CONSTRAINT ck_pccc_fallback_channel CHECK (fallback_channel IN ('REST', 'GRPC'))
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `INSERT INTO reward_tracking.portal_config_channel_config
       (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
     VALUES ('GLOBAL', NULL, NULL, true, true, 'REST', 'GRPC');`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_tracking.portal_config_channel_config;', {
    type: QueryTypes.RAW,
  });
}
