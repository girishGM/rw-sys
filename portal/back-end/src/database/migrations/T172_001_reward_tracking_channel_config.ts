import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.reward_tracking_channel_config` — T-INT-030
 * (`reward-service-integration-plan/tasks/T-INT-030-portal-rts-admin-client.md`). Leg 8 (portal →
 * reward-tracking-service admin dashboards) — REST/gRPC only, **no Kafka option**
 * (`ARCHITECTURE.md` §1 point 8: this leg is a pull query, not an event, resolved with the user).
 * Same `scope_level`/`scope_ref_code`/`tenant_id` + `primary_channel`/`fallback_channel` +
 * `rest_enabled`/`grpc_enabled` shape as every other configurable leg this plan builds
 * (`ARCHITECTURE.md` §4), reserved by `set-transport-primary.js`'s own registry under
 * `--service=portal-back-end --leg=rts-admin-rewards`.
 *
 * ### Why the `scope_key` generated column, not RR's own plain `UNIQUE(scope_level, scope_ref_code,
 * tenant_id)`
 *
 * RR's `promo_code_channel_config`/`dispatch_channel_config` (migrations `018`/`006`) use a plain
 * multi-column `UNIQUE` directly over the two nullable columns — that service's own migration
 * comments acknowledge this leaves duplicate `GLOBAL`-shaped rows theoretically insertable
 * (Postgres treats every `NULL` as distinct) and accept the risk for that codebase. This table
 * lives in `reward_portal`, not `reward_redemption`, and **this portal already has its own, more
 * careful precedent for the identical problem** — `grpc_service_grants.tenant_key`
 * (`T047_001`, AR-02) and `campaign_caps.dedupe_key` (`T006_001`, AR-02) both use a
 * `GENERATED ALWAYS AS (...) STORED` column that normalises the nullable discriminators into one
 * comparable string, so the real unique constraint actually keys on what the row means. Matching
 * this codebase's own established convention over the sibling service's looser one, per
 * `reward-service-integration-plan/AGENT-PROTOCOL.md` §3 ("Follow existing code conventions in
 * whichever service(s) your task touches ... do not import one service's conventions into
 * another's codebase just because you're editing both in the same task"). Flagged as a deliberate
 * deviation from the literal RR migration shape in T-INT-030's own completion report.
 *
 * `primary_channel`/`fallback_channel` are constrained to `('REST','GRPC')` only — this leg
 * genuinely has no Kafka option (unlike RR's three-way tables), so the CHECK constraint encodes
 * that rather than leaving a column that would silently accept a value nothing on either side of
 * this leg implements.
 *
 * Exactly one `GLOBAL` row is seeded: `rest_enabled=true`, `grpc_enabled=false`,
 * `primary_channel='REST'`, `fallback_channel='REST'` (R1 — every `GLOBAL` row this plan creates
 * defaults to REST; Render's free tier cannot run gRPC yet). `grpc_enabled=false` also reflects a
 * real, confirmed fact about RTS's own surface today, not just caution: RTS's gRPC service is
 * ingest-only (`RewardTrackingIngestService`, `ARCHITECTURE.md` finding 8) — there is no
 * read-facing RPC for admin summaries to dial (T-INT-030 implementation note 4). The row can still
 * be flipped to `primary_channel='GRPC'` via `set-transport-primary.js` (TC-6) — that is exactly
 * what proves the client fails closed with a clear error instead of hanging or crashing.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.reward_tracking_channel_config (
          id                int          generated always as identity primary key,
          scope_level       varchar(10)  not null,
          scope_ref_code    varchar(80)  null,
          tenant_id         int          null,
          rest_enabled      boolean      not null default true,
          grpc_enabled      boolean      not null default false,
          primary_channel   varchar(10)  not null default 'REST',
          fallback_channel  varchar(10)  not null default 'REST',
          created_at        timestamptz  not null default now(),
          updated_at        timestamptz  not null default now(),

          constraint ck_rtcc_scope_level
              check (scope_level in ('REWARD','TRACKER','CAMPAIGN','GLOBAL')),
          constraint ck_rtcc_primary_channel check (primary_channel in ('REST','GRPC')),
          constraint ck_rtcc_fallback_channel check (fallback_channel in ('REST','GRPC')),

          -- Uniqueness-only normalisation (AR-02 — see this file's header). Without it, two
          -- "GLOBAL, every tenant" rows would not collide: Postgres treats NULL <> NULL.
          scope_key varchar(90) generated always as (
              coalesce(scope_ref_code, '') || '|' || coalesce(tenant_id::text, '')
          ) stored,
          constraint uq_rtcc unique (scope_level, scope_key)
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `INSERT INTO reward_portal.reward_tracking_channel_config
         (scope_level, scope_ref_code, tenant_id, rest_enabled, grpc_enabled, primary_channel, fallback_channel)
       VALUES ('GLOBAL', NULL, NULL, true, false, 'REST', 'REST');`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // 01-DATABASE.md §3's least-privilege convention: DELETE stays granted (this is ordinary
    // operational config, not an access-control record like `grpc_service_grants` — deleting a
    // stale scope-specific override is a normal administrative action, matching
    // `activity_external_codes`'s own reasoning, T171_001). TRUNCATE is revoked, as on every
    // `reward_portal` table (T-080).
    await context.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON reward_portal.reward_tracking_channel_config TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `REVOKE TRUNCATE ON reward_portal.reward_tracking_channel_config FROM reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** R7 — a working `down()`. The table is portal-owned and nothing references it, so the drop is
 * unconditional; `CASCADE` removes the generated column and constraints with it. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `DROP TABLE IF EXISTS reward_portal.reward_tracking_channel_config CASCADE;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
