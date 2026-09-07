import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-PC-059 — the DB immutability/undeletability trigger for `promo_code_config_version`
 * (created by migration `_001`), ported **verbatim in shape** from the portal's own
 * `reward_config.reward_versions` pattern (T-PC-058 Implementation note 2, citing
 * `portal/back-end/src/database/migrations/T005_007_immutability_triggers.ts`'s
 * `fn_reward_version_immutable`/`fn_reward_version_undeletable`).
 *
 * Two triggers:
 *  - `fn_promo_code_config_version_immutable` / `trg_..._immutable` — **BEFORE UPDATE**. Once
 *    `status <> 'draft'`, the frozen payload columns (every payout column plus `version_no`) may
 *    never change again. `status` itself may still move forward along the lifecycle
 *    (`draft -> published -> deprecated -> retired`) — only the frozen payload is locked.
 *  - `fn_promo_code_config_version_undeletable` / `trg_..._undeletable` — **BEFORE DELETE**. A
 *    published version is never deleted, only `deprecated`/`retired` — `promo_code.promo_code`
 *    records `promo_code_config_version_id` on every code generated under it (migration `_004`),
 *    and if this service ever deleted that row, every one of those historical records would point
 *    at nothing. A `draft` row has no external references yet, so it may still be discarded.
 *
 * `RAISE EXCEPTION ... USING ERRCODE = 'check_violation'` (not a bespoke code), same reasoning as
 * the portal's own version — the error surfaces the same way an ordinary CHECK-constraint
 * violation would to Sequelize/`psql`/any future caller, without inventing a new error class the
 * application layer needs special-case handling for.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE FUNCTION promo_code.fn_promo_code_config_version_immutable() RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'draft' AND (
             NEW.code_prefix              IS DISTINCT FROM OLD.code_prefix              OR
             NEW.code_postfix             IS DISTINCT FROM OLD.code_postfix             OR
             NEW.code_length              IS DISTINCT FROM OLD.code_length              OR
             NEW.character_set            IS DISTINCT FROM OLD.character_set            OR
             NEW.exclude_ambiguous_chars  IS DISTINCT FROM OLD.exclude_ambiguous_chars  OR
             NEW.reward_value_type        IS DISTINCT FROM OLD.reward_value_type        OR
             NEW.reward_value             IS DISTINCT FROM OLD.reward_value             OR
             NEW.reward_unit              IS DISTINCT FROM OLD.reward_unit              OR
             NEW.max_redemptions_per_code IS DISTINCT FROM OLD.max_redemptions_per_code OR
             NEW.code_expiry_days         IS DISTINCT FROM OLD.code_expiry_days         OR
             NEW.version_no               IS DISTINCT FROM OLD.version_no) THEN
          RAISE EXCEPTION 'promo_code_config_version.% is published and immutable', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `
      CREATE FUNCTION promo_code.fn_promo_code_config_version_undeletable() RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'draft' THEN
          RAISE EXCEPTION 'promo_code_config_version.% is published and cannot be deleted — deprecate or retire it instead', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE TRIGGER trg_promo_code_config_version_immutable
           BEFORE UPDATE ON promo_code.promo_code_config_version
           FOR EACH ROW EXECUTE FUNCTION promo_code.fn_promo_code_config_version_immutable();`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE TRIGGER trg_promo_code_config_version_undeletable
           BEFORE DELETE ON promo_code.promo_code_config_version
           FOR EACH ROW EXECUTE FUNCTION promo_code.fn_promo_code_config_version_undeletable();`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Triggers first, then the functions they depend on — reverse of creation order. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `DROP TRIGGER IF EXISTS trg_promo_code_config_version_undeletable
         ON promo_code.promo_code_config_version;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `DROP TRIGGER IF EXISTS trg_promo_code_config_version_immutable
         ON promo_code.promo_code_config_version;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `DROP FUNCTION IF EXISTS promo_code.fn_promo_code_config_version_undeletable();`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `DROP FUNCTION IF EXISTS promo_code.fn_promo_code_config_version_immutable();`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
