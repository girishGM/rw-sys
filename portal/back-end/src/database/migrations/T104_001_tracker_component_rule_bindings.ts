import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-104 — gives a rule *binding* (`tracker_component_rules`) a first-class comparison contract
 * (`operator`, `value`, `priority`, `resolved_data_key_path`) instead of everything living inside
 * the opaque `config` JSON blob with no dedicated comparison concept. Gives a *component*
 * (`tracker_components`) its own rule-combination logic (`rule_logic`/`rule_threshold`),
 * mirroring the pattern `trackers.completion_logic`/`.completion_threshold` already uses one
 * level up.
 *
 * All 6 columns nullable — additive, matching `06-VERSIONING.md` §5.1's own precedent verbatim
 * ("nullable, so every existing INSERT keeps working"). Application code treats `NULL priority`
 * as `100` and `NULL rule_logic` as `'all'`, rather than a DB-level `NOT NULL DEFAULT`, to stay
 * inside the exact pattern this codebase has already used rather than introduce a new one.
 *
 * Deliberately does **not** touch `tracker_components.completion_criteria` — confirmed unused
 * (only a `null`-write in `journey.service.ts`, no read anywhere), but `00-ARCHITECTURE.md` §2
 * (C1) forbids `DROP COLUMN` even on a genuinely dead column; only additive DDL is permitted.
 * It stays, unused, alongside the two new columns.
 *
 * Deliberately does **not** add `rule_group`/`rule_group_logic` per binding row — see
 * `rule-engine-mapped-design.md` §2.2 and this task's own file for the reasoning: combination
 * logic belongs on the component (one rule_logic per component), not repeated on every row.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.tracker_component_rules
         ADD COLUMN operator               varchar(30)  NULL,
         ADD COLUMN value                  text         NULL,
         ADD COLUMN priority               int          NULL,
         ADD COLUMN resolved_data_key_path varchar(200) NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE reward_config.tracker_components
         ADD COLUMN rule_logic     varchar(10) NULL,
         ADD COLUMN rule_threshold int         NULL;`,
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
      `ALTER TABLE reward_config.tracker_components
         DROP COLUMN IF EXISTS rule_threshold,
         DROP COLUMN IF EXISTS rule_logic;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE reward_config.tracker_component_rules
         DROP COLUMN IF EXISTS resolved_data_key_path,
         DROP COLUMN IF EXISTS priority,
         DROP COLUMN IF EXISTS value,
         DROP COLUMN IF EXISTS operator;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
