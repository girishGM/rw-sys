import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-080. `promo_code_channel_config` — campaign/tracker/reward-level REST-vs-gRPC routing for
 * this service's own *synchronous* outbound call to promo-code-service (`08-EXTERNAL-INTEGRATION-
 * CONTRACTS.md` §2, T-RR-080's own task file). Resolution precedence (`PromoCodeChannelResolverService`):
 * `REWARD` → `TRACKER` → `CAMPAIGN` → the one `GLOBAL` row — first match wins, the exact same shape
 * `dispatch_channel_config`'s own resolver already established (migration `006`, T-RR-033), ported
 * in shape only (T-RR-080's own task file, implementation note 1) — not the same table, because this
 * one governs a call this redemption's own outcome blocks on, never an outbound-reporting event
 * nobody waits on (T-RR-080's own "Why this reuses dispatch_channel_config's shape but isn't the
 * same table" section).
 *
 * `uq_pccc`'s plain `UNIQUE (scope_level, scope_ref_code, tenant_id)` mirrors `uq_dcc_scope`'s own
 * choice (migration `006`'s own header) over the `tenant_key`/`coalesce` generated-column trick
 * `external_reward_system_config` uses — a `GLOBAL` row's `scope_ref_code = NULL` by definition and
 * a tenant-agnostic row at any other scope (`tenant_id = NULL`) both need to stay independently
 * unique.
 *
 * Exactly one `GLOBAL` row is seeded as part of this migration, with `rest_enabled=true`,
 * `grpc_enabled=false`, `primary_channel='REST'`, `fallback_channel='REST'` — the task's own note:
 * "Defaults ... reproduce today's actual behavior exactly for any campaign with no explicit row,
 * once a GLOBAL default row is seeded — no existing redemption changes behavior because this table
 * now exists."
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.promo_code_channel_config (
      id                int         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      scope_level       varchar(10) NOT NULL,
      scope_ref_code    varchar(80) NULL,
      tenant_id         int         NULL,
      rest_enabled      boolean     NOT NULL DEFAULT true,
      grpc_enabled      boolean     NOT NULL DEFAULT false,
      primary_channel   varchar(10) NOT NULL DEFAULT 'REST',
      fallback_channel  varchar(10) NOT NULL DEFAULT 'REST',
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_pccc UNIQUE (scope_level, scope_ref_code, tenant_id)
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `INSERT INTO reward_redemption.promo_code_channel_config
       (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
     VALUES ('GLOBAL', NULL, NULL, true, false, 'REST', 'REST');`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.promo_code_channel_config;', {
    type: QueryTypes.RAW,
  });
}
