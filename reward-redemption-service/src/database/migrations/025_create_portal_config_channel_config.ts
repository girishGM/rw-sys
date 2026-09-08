import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-012. `portal_config_channel_config` — this leg's own copy of the configurable-transport
 * standard (`reward-service-integration-plan/ARCHITECTURE.md` §4, `TRANSPORT-CONFIG.md`'s own
 * "DB-backed legs" table row for `reward-redemption-service`/`portal-config`), an explicit direct
 * port of RAP's own identical table
 * (`realtime-activity-processing-service/src/database/migrations/016_create_portal_config_channel_config.ts`,
 * T-INT-011 — confirmed by direct read before writing this migration, per this task's own
 * implementation note 1) — same `scope_level`/`scope_ref_code`/`tenant_id` shape, same
 * `UNIQUE(scope_level, scope_ref_code, tenant_id)` constraint, same seeded `GLOBAL` row, shaped
 * identically to `reward_redemption.dispatch_channel_config`
 * (`006_create_dispatch_channel_config.ts`) too, minus the Kafka option:
 *
 * 1. **No `kafka_enabled` column, no `KAFKA` option** — this leg was never specified with a Kafka
 *    option (`ARCHITECTURE.md` §1 point 3 names it "gRPC (primary) with REST as fallback" only, and
 *    `TRANSPORT-CONFIG.md`'s own leg table lists `Options: REST, GRPC` for this service's own
 *    `portal-config` leg, identically to its RAP/RTS siblings).
 * 2. **The seeded `GLOBAL` row defaults `primary_channel = 'REST'` directly** (R1) — no later flip
 *    migration needed, unlike `dispatch_channel_config`'s own `006` → `023` history.
 *
 * **Migration number**: this task's own file (`T-INT-012-rr-campaign-config-rest-fallback.md`,
 * "Files owned") names `023_create_portal_config_channel_config.ts`, written before this session
 * started, at a time when `023` was still assumed free. By the time this task actually ran, this
 * directory already had migrations through `024` (`023_flip_dispatch_channel_config_default_to_rest.ts`,
 * T-INT-001; `024_add_reward_tracking_dispatch_outbox_reward_entry_id_index.ts`, T-INT-007) — so
 * `025` is the genuine next-free number. Same "next free number, not the number a task file guessed
 * before it ran" precedent `TRANSPORT-CONFIG.md`'s own migration-numbering note already records for
 * `023_flip_dispatch_channel_config_default_to_rest.ts` itself (planned as `022`, actually `023`)
 * and for RAP's own `016_create_portal_config_channel_config.ts` (planned as `017`, actually `016`).
 * Recorded here, and in this task's own completion report under "Deviations", rather than silently
 * renumbering without a trace.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.portal_config_channel_config (
      id                int          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      scope_level       varchar(10)  NOT NULL,
      scope_ref_code    varchar(80)  NULL,
      tenant_id         int          NULL,
      rest_enabled      boolean      NOT NULL DEFAULT true,
      grpc_enabled      boolean      NOT NULL DEFAULT true,
      primary_channel   varchar(10)  NOT NULL DEFAULT 'REST',
      fallback_channel  varchar(10)  NOT NULL DEFAULT 'GRPC',
      created_at        timestamptz  NOT NULL DEFAULT now(),
      updated_at        timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT uq_portal_config_channel_config_scope UNIQUE (scope_level, scope_ref_code, tenant_id)
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `INSERT INTO reward_redemption.portal_config_channel_config
       (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
     VALUES ('GLOBAL', NULL, NULL, true, true, 'REST', 'GRPC');`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.portal_config_channel_config;', {
    type: QueryTypes.RAW,
  });
}
