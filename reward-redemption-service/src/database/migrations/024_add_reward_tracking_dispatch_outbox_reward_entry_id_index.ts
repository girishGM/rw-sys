import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-007 (filed per `reward-service-integration-plan/AGENT-PROTOCOL.md` §7.1, discovered
 * incidentally while implementing T-INT-004 — not caused by it and outside its own "Files owned"
 * list). `010_create_reward_tracking_dispatch_outbox.ts` declares
 * `reward_entry_id uuid NOT NULL REFERENCES reward_redemption.reward_redemption_entry (id)` with
 * no accompanying index on that FK column. Postgres does not automatically index a referencing FK
 * column (only the referenced side gets one, via the primary key it references) — without one, the
 * RI trigger's own per-deleted-parent-row `SELECT 1 FROM reward_tracking_dispatch_outbox WHERE
 * reward_entry_id = $1 FOR KEY SHARE` cascade-check falls back to a full sequential scan of this
 * table, once per deleted parent row. Confirmed by direct `EXPLAIN ANALYZE` against the real local
 * table (21,760 rows): 13.2 ms/row via `Seq Scan ... Rows Removed by Filter: 21760` — at that
 * per-row cost, `reward-redemption-entry.migration.spec.ts`'s own `TC-5` fixture (15,000 parent rows
 * bulk-inserted, then bulk-deleted in its `afterAll`) drove that single `DELETE` past Jest's default
 * 5s `afterAll` hook timeout.
 *
 * A plain `CREATE INDEX` (not `CONCURRENTLY`) matches this project's existing precedent for every
 * other index-adding change in this chain (e.g. `002`/`003`/`013`'s own inline index DDL) —
 * `CONCURRENTLY` cannot run inside a transaction, and `umzug.ts`'s `SequelizeStorage` wraps each
 * migration's `up()`/`down()` in one; this project's migrations already run inside a maintenance
 * window, not against a live-traffic table (T-INT-007's own "Implementation notes" #1).
 *
 * Numbered `024` — the next free number in this directory's own strictly-increasing sequence as of
 * this task being picked up (`023_flip_dispatch_channel_config_default_to_rest.ts` is the highest
 * existing number; `017` remains a deliberately reserved/skipped number per `020`'s own header).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE INDEX ix_rtdo_reward_entry_id
       ON reward_redemption.reward_tracking_dispatch_outbox (reward_entry_id);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP INDEX IF EXISTS reward_redemption.ix_rtdo_reward_entry_id;', {
    type: QueryTypes.RAW,
  });
}
