import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Three additive, nullable columns on existing `reward_config` tables — 06-VERSIONING.md
 * §5.1, and the only kind of change C1 (06-VERSIONING.md §3) permits on a table this task
 * didn't create. All three are `NULL`-default, so every existing INSERT from other
 * services (and the live `create-campaign*` agents) keeps working untouched — nothing here
 * requires a backfill.
 *
 * - `tracker_component_rules.rule_version_id` is the **binding pin** (06-VERSIONING.md §7):
 *   the concrete version a campaign is running, written once at bind time and never
 *   rewritten by a later blast. Existing rows keep `NULL`, read as "pre-versioning /
 *   version 1 by convention" (§5.1's own wording).
 * - `reward_campaign_assignments.reward_version_id` mirrors the same pin on the reward
 *   side.
 * - `tenant_campaigns.definition_pinned_at` records when a campaign's rule/reward
 *   selection was pinned, for the audit trail.
 *
 * No FK on `rule_version_id`/`reward_version_id` pointing back at `rule_versions` /
 * `reward_versions`: adding one now would be safe (both target tables already exist, from
 * `T005_001`/`T005_002`), so one *is* added here — it costs nothing and catches a bad pin
 * at write time rather than at read time.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.tracker_component_rules
           ADD COLUMN rule_version_id int NULL
           REFERENCES reward_config.rule_versions(id);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE reward_config.reward_campaign_assignments
           ADD COLUMN reward_version_id int NULL
           REFERENCES reward_config.reward_versions(id);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE reward_config.tenant_campaigns
           ADD COLUMN definition_pinned_at timestamptz NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Drop the additive columns last, in reverse order — see the task file's own note 6. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_config.tenant_campaigns DROP COLUMN IF EXISTS definition_pinned_at;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE reward_config.reward_campaign_assignments DROP COLUMN IF EXISTS reward_version_id;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE reward_config.tracker_component_rules DROP COLUMN IF EXISTS rule_version_id;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
