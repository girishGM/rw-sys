import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * The immutability and undeletability triggers — 06-VERSIONING.md §4.2, and the reason
 * this task is flagged **high risk** in its own task file: "immutability triggers on a
 * live schema". Application-level discipline is not enough for an audit trail the
 * transaction microservice's own history depends on forever (§8.1) — it has to be
 * physically impossible for a published version's frozen behaviour to change or vanish,
 * even via a direct `UPDATE`/`DELETE` that bypasses this portal's own API.
 *
 * Four triggers, two per side (rule / reward), all attached to the version tables created
 * in `T005_001`/`T005_002`:
 *
 * - `fn_rule_version_immutable` / `trg_rule_versions_immutable` — **BEFORE UPDATE**, given
 *   verbatim in the task file's own "Implementation notes" §3. Once `status <> 'draft'`,
 *   the frozen behaviour columns (`expression`, `parameters`, `version_no`, `is_breaking`)
 *   may never change again. `status` itself may still move forward along the lifecycle
 *   (TC-8) — only the frozen payload is locked.
 * - `fn_rule_version_undeletable` / `trg_rule_versions_undeletable` — **BEFORE DELETE**,
 *   not given verbatim in the task file ("write them analogously"). A published version is
 *   never deleted, only `deprecated` or `retired` (§4.3): the transaction microservice
 *   records `(rule_id, version_no)` on every decision it makes, and if this portal ever
 *   deleted that row, every one of those historical records would point at nothing
 *   (task file, Implementation notes §4). A `draft` row has no external references yet, so
 *   it may still be discarded (TC-15).
 * - `fn_reward_version_immutable` / `trg_reward_versions_immutable` and
 *   `fn_reward_version_undeletable` / `trg_reward_versions_undeletable` — the reward-side
 *   mirror, also not given verbatim ("the reward-side mirror trigger" per the task file).
 *   The frozen payload columns mirror `reward_versions`' own shape from `T005_002`:
 *   `connector_config`, `delivery_mode`, `retry_config`, `policies_snapshot`, and the
 *   payout unit (`unit_type`/`unit_code`, 11-BUDGETS-AND-LIMITS.md §3.1) — the unit a
 *   budget matches against must be just as immutable as the behaviour it pays out, since
 *   there is no conversion rate anywhere in the design (T-005 Implementation notes §0).
 *
 * `RAISE EXCEPTION ... USING ERRCODE = 'check_violation'` (not a bespoke code) so the error
 * surfaces the same way an ordinary CHECK-constraint violation would to any caller —
 * Sequelize, `psql`, or a future consumer — without inventing a new class of error the
 * application layer would need special-case handling for.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    // ───────────────────────── rule side ─────────────────────────
    await context.query(
      `
      CREATE FUNCTION reward_config.fn_rule_version_immutable() RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'draft' AND (
             NEW.expression   IS DISTINCT FROM OLD.expression   OR
             NEW.parameters   IS DISTINCT FROM OLD.parameters   OR
             NEW.version_no   IS DISTINCT FROM OLD.version_no   OR
             NEW.is_breaking  IS DISTINCT FROM OLD.is_breaking) THEN
          RAISE EXCEPTION 'rule_versions.% is published and immutable', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `
      CREATE FUNCTION reward_config.fn_rule_version_undeletable() RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'draft' THEN
          RAISE EXCEPTION 'rule_versions.% is published and cannot be deleted — deprecate or retire it instead', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE TRIGGER trg_rule_versions_immutable
           BEFORE UPDATE ON reward_config.rule_versions
           FOR EACH ROW EXECUTE FUNCTION reward_config.fn_rule_version_immutable();`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE TRIGGER trg_rule_versions_undeletable
           BEFORE DELETE ON reward_config.rule_versions
           FOR EACH ROW EXECUTE FUNCTION reward_config.fn_rule_version_undeletable();`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // ─────────────────────── reward side (mirror) ───────────────────────
    await context.query(
      `
      CREATE FUNCTION reward_config.fn_reward_version_immutable() RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'draft' AND (
             NEW.connector_config  IS DISTINCT FROM OLD.connector_config  OR
             NEW.delivery_mode     IS DISTINCT FROM OLD.delivery_mode     OR
             NEW.retry_config      IS DISTINCT FROM OLD.retry_config      OR
             NEW.policies_snapshot IS DISTINCT FROM OLD.policies_snapshot OR
             NEW.unit_type         IS DISTINCT FROM OLD.unit_type         OR
             NEW.unit_code         IS DISTINCT FROM OLD.unit_code         OR
             NEW.version_no        IS DISTINCT FROM OLD.version_no        OR
             NEW.is_breaking       IS DISTINCT FROM OLD.is_breaking) THEN
          RAISE EXCEPTION 'reward_versions.% is published and immutable', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `
      CREATE FUNCTION reward_config.fn_reward_version_undeletable() RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'draft' THEN
          RAISE EXCEPTION 'reward_versions.% is published and cannot be deleted — deprecate or retire it instead', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE TRIGGER trg_reward_versions_immutable
           BEFORE UPDATE ON reward_config.reward_versions
           FOR EACH ROW EXECUTE FUNCTION reward_config.fn_reward_version_immutable();`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE TRIGGER trg_reward_versions_undeletable
           BEFORE DELETE ON reward_config.reward_versions
           FOR EACH ROW EXECUTE FUNCTION reward_config.fn_reward_version_undeletable();`,
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
      `DROP TRIGGER IF EXISTS trg_reward_versions_undeletable ON reward_config.reward_versions;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `DROP TRIGGER IF EXISTS trg_reward_versions_immutable ON reward_config.reward_versions;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(`DROP FUNCTION IF EXISTS reward_config.fn_reward_version_undeletable();`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`DROP FUNCTION IF EXISTS reward_config.fn_reward_version_immutable();`, {
      type: QueryTypes.RAW,
      transaction: t,
    });

    await context.query(
      `DROP TRIGGER IF EXISTS trg_rule_versions_undeletable ON reward_config.rule_versions;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `DROP TRIGGER IF EXISTS trg_rule_versions_immutable ON reward_config.rule_versions;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(`DROP FUNCTION IF EXISTS reward_config.fn_rule_version_undeletable();`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`DROP FUNCTION IF EXISTS reward_config.fn_rule_version_immutable();`, {
      type: QueryTypes.RAW,
      transaction: t,
    });

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
