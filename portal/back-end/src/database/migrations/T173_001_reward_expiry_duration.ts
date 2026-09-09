import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-173 — the per-version expiry **duration** on `reward_config.reward_versions`:
 * `expiry_value` + `expiry_unit`. Exactly the same shape, and for exactly the same reason, as
 * `T119_001`'s own additive pair (`reward_kind`/`value_config`): both columns are nullable, so
 * every existing row and every existing INSERT keeps working untouched.
 *
 * ### `NULL` means "never expires", not "not yet configured"
 *
 * Most rewards in this system (cashback, most voucher types) do not expire at all, so a `NULL`
 * pair has to read as a deliberate *"this reward never expires"* — the same way
 * `tenant_budget_ceilings` already treats "no ceiling row" as unlimited rather than blocked
 * (`T006_003_tenant_budget_ceilings.ts:18`). That is why there is no default, no sentinel `0`,
 * and no backfill: a reward that predates this migration is not misconfigured, it is a reward
 * that never expires, and reward-redemption-service (`T-RR-063`) computes no `expires_at` for it.
 *
 * ### Why a duration rather than a date
 *
 * The expiry a customer is told about is *"this expires 15 minutes after you earned it"*, not
 * *"this expires on 3 March"* — the clock starts at redemption, an event this portal never sees.
 * So the portal stores the duration and reward-redemption-service does the arithmetic; this
 * migration deliberately adds no timestamp column anywhere.
 *
 * ### The three constraints, and what each one is actually preventing
 *
 *  - `ck_rewv_expiry_unit` — the vocabulary, written `is null or in (...)` like `ck_rewv_unit_type`
 *    and `ck_rewv_reward_kind` beside it. `minutes|hours|days` and nothing else: the unit crosses
 *    a wire to a service that switches on it, and an unrecognised unit there is a reward with no
 *    computable expiry at all.
 *  - `ck_rewv_expiry_pair` — both columns are set together or neither is. A value with no unit is
 *    not a partial state this system has a reading for; it is `15` of *nothing*.
 *  - `ck_rewv_expiry_positive` — a zero or negative duration would mean "already expired when
 *    granted", which is never a thing a maker means to configure. `NULL` is how you say "no
 *    expiry"; `0` is how you say nothing at all.
 *
 * The `ck_rewv_*` prefix follows `T005_002`'s own convention for this table.
 *
 * **On R1** (no DDL against `reward_config`): this migration is authorised by the T-173 task file,
 * which specifies these columns and this ALTER verbatim — the same standing under which `T119_001`
 * added `reward_kind`/`value_config` to this table. It is additive only: no table is created, no
 * column altered, no constraint dropped.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.reward_versions
         ADD COLUMN expiry_value int         NULL,
         ADD COLUMN expiry_unit  varchar(10) NULL,
         ADD CONSTRAINT ck_rewv_expiry_unit
             CHECK (expiry_unit IS NULL OR expiry_unit IN ('minutes','hours','days')),
         ADD CONSTRAINT ck_rewv_expiry_pair
             CHECK ((expiry_value IS NULL AND expiry_unit IS NULL)
                 OR (expiry_value IS NOT NULL AND expiry_unit IS NOT NULL)),
         ADD CONSTRAINT ck_rewv_expiry_positive
             CHECK (expiry_value IS NULL OR expiry_value > 0);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Dropping the columns drops the three CHECKs with them; naming them anyway keeps the rollback
 * readable and safe if a future migration ever detaches one first — `T119_001`'s own `down()`
 * makes the same choice.
 *
 * **Roll back `T173_002` before this** (the task file's Rollback section says "in reverse order"
 * for this reason): that migration's trigger body references `NEW.expiry_value`, and a trigger
 * function referring to a column that no longer exists fails every UPDATE on the table, not just
 * one touching expiry.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.reward_versions
         DROP CONSTRAINT IF EXISTS ck_rewv_expiry_positive,
         DROP CONSTRAINT IF EXISTS ck_rewv_expiry_pair,
         DROP CONSTRAINT IF EXISTS ck_rewv_expiry_unit,
         DROP COLUMN IF EXISTS expiry_unit,
         DROP COLUMN IF EXISTS expiry_value;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
