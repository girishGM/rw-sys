import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-103 — resolver-wiring columns on `reward_config.rule_versions`: `resolver_id`,
 * `resolver_config`, `evaluation_context`, `default_operators`. Nullable, additive — every
 * existing row and every existing INSERT keeps working untouched (same pattern `T005_006`
 * itself uses, verbatim: "nullable, so every existing INSERT keeps working").
 *
 * These live on `rule_versions`, not `rule_master` — `06-VERSIONING.md` §4.1: "`rule_master`
 * stays exactly as it is... all behaviour moves into immutable version rows." A resolver-wired
 * rule's *resolver* can legitimately change between versions (v1 reads the transaction payload;
 * v2 might switch to an aggregate), so it belongs with the rest of "what the rule DID, frozen".
 *
 * `resolver_id IS NULL` reads as "not yet wired to the registry-driven engine" — identical in
 * spirit to `tracker_component_rules.rule_version_id IS NULL` reading as "pre-versioning".
 *
 * See `T103_002` for the immutability-trigger extension this table needs as a companion —
 * without it, these four columns would be silently mutable on an already-published row.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.rule_versions
         ADD COLUMN resolver_id        int          NULL REFERENCES reward_config.rule_resolvers(id),
         ADD COLUMN resolver_config    text         NULL,
         ADD COLUMN evaluation_context varchar(50)  NULL,
         ADD COLUMN default_operators  text         NULL;`,
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
    await context.query(
      `ALTER TABLE reward_config.rule_versions
         DROP COLUMN IF EXISTS default_operators,
         DROP COLUMN IF EXISTS evaluation_context,
         DROP COLUMN IF EXISTS resolver_config,
         DROP COLUMN IF EXISTS resolver_id;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
