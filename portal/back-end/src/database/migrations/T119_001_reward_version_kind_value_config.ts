import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-119 — the Kind/value columns on `reward_config.reward_versions`: `reward_kind` and
 * `value_config`. Exactly parallel to what `T103_001` added to `rule_versions`
 * (`resolver_id`/`resolver_config`) — 13-REWARD-MASTER-VALUE-SOURCES.md §5 states the parallel
 * outright — and additive in the same way: both columns are nullable, so every existing row and
 * every existing INSERT keeps working untouched.
 *
 * `reward_kind IS NULL` reads as "kind not yet set" (TC-7), the same way `resolver_id IS NULL`
 * reads as "not yet wired to the registry-driven engine".
 *
 * These live on `reward_versions`, not `reward_systems`, for `T103_001`'s own reason applied to
 * the reward side (06-VERSIONING.md §4.1): a reward's Kind and value are *what it paid out*, and
 * a v2 that switches a fixed amount to a percentage must not silently rewrite what v1 did. The
 * companion `T119_002` is what actually makes that true, by extending the immutability trigger —
 * without it these two columns would stay mutable on an already-published row.
 *
 * `value_config` is `text` holding JSON, not `jsonb` — the same JSON-in-text treatment
 * `rule_versions.parameters` and `reward_versions.connector_config` already get in this schema
 * (01-DATABASE.md §6: "these tables predate the portal"), read through the tolerant
 * `parseJsonColumn`/`stringifyJsonColumn` getter/setter pair on the model.
 *
 * The CHECK is named `ck_rewv_reward_kind`, following `T005_002`'s own `ck_rewv_*` convention for
 * this table, and is written `is null or in (...)` like `ck_rewv_unit_type` beside it.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.reward_versions
         ADD COLUMN reward_kind  varchar(20) NULL,
         ADD COLUMN value_config text        NULL,
         ADD CONSTRAINT ck_rewv_reward_kind
             CHECK (reward_kind IS NULL OR reward_kind IN
                    ('FIXED_AMOUNT','PERCENTAGE','POINTS','PHYSICAL','PROMO_CODE'));`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    // Dropping the columns drops `ck_rewv_reward_kind` with them; naming it anyway keeps the
    // rollback readable and safe if a future migration ever detaches the constraint first.
    await context.query(
      `ALTER TABLE reward_config.reward_versions
         DROP CONSTRAINT IF EXISTS ck_rewv_reward_kind,
         DROP COLUMN IF EXISTS value_config,
         DROP COLUMN IF EXISTS reward_kind;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
