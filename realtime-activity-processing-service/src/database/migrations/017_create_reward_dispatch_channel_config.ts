import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-006. `reward_dispatch_channel_config` — this leg's own copy of the configurable-transport
 * standard (`reward-service-integration-plan/ARCHITECTURE.md` §4, `TRANSPORT-CONFIG.md`'s own
 * "DB-backed legs" table row `realtime-activity-processing-service`/`rap-to-rr` — table name
 * `realtime_activity_processing.reward_dispatch_channel_config` is RESERVED, exactly this name, by
 * `reward-service-integration-plan/scripts/set-transport-primary.js`'s own registry), shaped
 * exactly like `reward_redemption.dispatch_channel_config`
 * (`reward-redemption-service/src/database/migrations/006_create_dispatch_channel_config.ts`) —
 * `scope_level`/`scope_ref_code`/`tenant_id`, `varchar(10)` `primary_channel`/`fallback_channel`
 * with no `CHECK` constraint (enum enforced at the TypeScript level only — this service's own
 * migration `018`'s precedent for the identical choice, per this task's own implementation note 1),
 * `UNIQUE(scope_level, scope_ref_code, tenant_id)`, one seeded `GLOBAL` row.
 *
 * **Precedence**: `REWARD` -> `TRACKER` -> `CAMPAIGN` -> `GLOBAL`, the same four-level walk every
 * other `REWARD`/`TRACKER`/`CAMPAIGN`/`GLOBAL`-scoped table in this plan uses (RR's own
 * `dispatch_channel_config`) — wider than this service's own `portal_config_channel_config`
 * (migration `016`, `CAMPAIGN`/`GLOBAL` only), because this leg's caller
 * (`OutboxPublisherService.processRow`) always has a real reward/tracker/campaign code on hand from
 * the `reward_entry_outbox` row it is dispatching, unlike the portal-config leg's own
 * before-any-reward-is-known call sites.
 *
 * **R1 (this plan's own `AGENT-PROTOCOL.md`)**: the seeded `GLOBAL` row defaults
 * `primary_channel = 'REST'` directly, not `'KAFKA'`/needing a later flip like RR's own
 * `dispatch_channel_config` (migration `006`, fixed only by T-INT-001's migration `023`) — there is
 * no pre-existing default here to confirm or correct, this table's very first row already complies.
 * `fallback_channel = 'KAFKA'`: the spec's own original wording for this leg
 * (`ARCHITECTURE.md` §1 point 4 — "Kafka (primary), REST or gRPC (fallback)") named Kafka as the
 * *previously*-primary transport; once REST takes over as primary per R1, Kafka is the most
 * natural "next-best" fallback to preserve from that original design, rather than picking gRPC
 * arbitrarily — either is a legal fallback value (`grpc_enabled`/`kafka_enabled` both default
 * `true`, so both remain fully selectable per-row via `set-transport-primary.js` regardless of this
 * seed's own choice).
 *
 * **Migration number**: this task's own file (`T-INT-006-rap-to-rr-dispatch-resolver.md`, "Files
 * owned") names `016_create_reward_dispatch_channel_config.ts`, written before this session
 * started. The actual next free number in this directory at the time this task ran was `017`
 * (migration `016` was already claimed by `016_create_portal_config_channel_config.ts`, T-INT-011)
 * — same "next free number, not the number a task file guessed before it ran" precedent
 * `023_flip_dispatch_channel_config_default_to_rest.ts`'s own header and
 * `016_create_portal_config_channel_config.ts`'s own header already record. Recorded here, and in
 * this task's own completion report under "Deviations", rather than silently renumbering without a
 * trace.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE realtime_activity_processing.reward_dispatch_channel_config (
      id                int          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      scope_level       varchar(10)  NOT NULL,
      scope_ref_code    varchar(80)  NULL,
      tenant_id         int          NULL,
      kafka_enabled     boolean      NOT NULL DEFAULT true,
      rest_enabled      boolean      NOT NULL DEFAULT true,
      grpc_enabled      boolean      NOT NULL DEFAULT true,
      primary_channel   varchar(10)  NOT NULL DEFAULT 'REST',
      fallback_channel  varchar(10)  NOT NULL DEFAULT 'KAFKA',
      created_at        timestamptz  NOT NULL DEFAULT now(),
      updated_at        timestamptz  NOT NULL DEFAULT now(),
      CONSTRAINT uq_reward_dispatch_channel_config_scope UNIQUE (scope_level, scope_ref_code, tenant_id)
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `INSERT INTO realtime_activity_processing.reward_dispatch_channel_config
       (scope_level, scope_ref_code, tenant_id, kafka_enabled, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
     VALUES ('GLOBAL', NULL, NULL, true, true, true, 'REST', 'KAFKA');`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS realtime_activity_processing.reward_dispatch_channel_config;',
    { type: QueryTypes.RAW },
  );
}
