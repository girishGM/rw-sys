import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-011. `portal_config_channel_config` — this leg's own copy of the configurable-transport
 * standard (`reward-service-integration-plan/ARCHITECTURE.md` §4, `TRANSPORT-CONFIG.md`'s own
 * "DB-backed legs" table row for `realtime-activity-processing-service`/`portal-config`), shaped
 * exactly like `reward_redemption.dispatch_channel_config`
 * (`reward-redemption-service/src/database/migrations/006_create_dispatch_channel_config.ts`) —
 * `scope_level`/`scope_ref_code`/`tenant_id`, `UNIQUE(scope_level, scope_ref_code, tenant_id)`,
 * one seeded `GLOBAL` row — with two deliberate differences:
 *
 * 1. **No `kafka_enabled` column, no `KAFKA` option.** This leg was never specified with a Kafka
 *    option — `ARCHITECTURE.md` §1 point 3 names it "gRPC (primary) with REST as fallback" only,
 *    and `TRANSPORT-CONFIG.md`'s own leg table lists `Options: REST, GRPC` for both
 *    `realtime-activity-processing-service`/`portal-config` and its RR/RTS siblings.
 * 2. **The seeded `GLOBAL` row defaults `primary_channel = 'REST'` directly**, not `'KAFKA'` /
 *    needing a later flip like `dispatch_channel_config`'s own migration `006` did (fixed only by
 *    T-INT-001's migration `023`) — R1 applies from this table's very first row, since there is no
 *    pre-existing default here to confirm or correct.
 *
 * **Migration number**: this task's own file (`T-INT-011-rap-campaign-config-rest-fallback.md`,
 * "Files owned") names `017_create_portal_config_channel_config.ts`, written before this session
 * started. The actual next free number in this directory at the time this task ran was `016`
 * (migrations `001`-`015` already exist; no `016` was claimed by any other in-flight task) — same
 * "next free number, not the number a task file guessed before it ran" precedent
 * `TRANSPORT-CONFIG.md`'s own migration-numbering note already records for
 * `023_flip_dispatch_channel_config_default_to_rest.ts` (planned as `022`, actually `023` because
 * `022` was taken by the time that task ran). Recorded here, and in this task's own completion
 * report under "Deviations", rather than silently renumbering without a trace.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.portal_config_channel_config (
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
    `INSERT INTO realtime_activity_processing.portal_config_channel_config
       (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
     VALUES ('GLOBAL', NULL, NULL, true, true, 'REST', 'GRPC');`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS realtime_activity_processing.portal_config_channel_config;',
    { type: QueryTypes.RAW },
  );
}
