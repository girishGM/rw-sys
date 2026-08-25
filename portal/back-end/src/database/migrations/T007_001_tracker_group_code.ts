import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_config.tracker_tracker_components.group_code` — 12-CAMPAIGN-STRUCTURE.md §1.4.
 *
 * The portal standardises on `tracker_tracker_components` as the single authoritative
 * tracker/component link (§1.3) — it carries `is_mandatory`, which a confirmed requirement
 * needs today, and the older, now-superseded groups table does not (see
 * `tracker-group-def.model.ts`'s header comment for the full deprecation note). This
 * column is the cheap half of making group-based completion a future *feature* rather
 * than a future *migration over live campaign data*: additive, nullable, C1-compliant.
 *
 * `group_code IS NULL` (every row in v1 — the wizard writes nothing else, Implementation
 * notes §3) means the component participates directly in the tracker's own
 * `completion_logic`. A non-NULL value means it belongs to a group defined in
 * `tracker_group_defs` (T007_002) and the GROUP participates instead — see that
 * migration's own doc comment for the two-level evaluation order (§1.4). Nothing in v1
 * reads this column; it is inert until the group UI and two-level completion evaluator
 * are built (deliberately deferred, §1.5).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_config.tracker_tracker_components
         ADD COLUMN group_code varchar(10) NULL;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE reward_config.tracker_tracker_components DROP COLUMN IF EXISTS group_code;`,
    { type: QueryTypes.RAW },
  );
}
