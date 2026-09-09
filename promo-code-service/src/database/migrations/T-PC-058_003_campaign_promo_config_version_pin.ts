import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-PC-059 — `campaign_promo_config` gains `promo_code_config_version_id`, the version a
 * campaign/tracker/component binding is actually pinned to (T-PC-058 Scope: "`campaign_promo_config`
 * gains a `promo_code_config_version_id` column, pinned at bind time"). Bind-time pin *logic*
 * (the app-level write path) is T-PC-058's own job (`src/modules/campaign-binding/**`, outside
 * this migration's scope) — this migration only adds the column, backfills existing bindings, and
 * makes it mandatory going forward.
 *
 * **Backfill** (T-PC-058 Implementation note 1): every existing `campaign_promo_config` row
 * backfills to its config's own version_no=1 row — the only version any config has at the point
 * this migration runs (`_001`'s own backfill created exactly one per config, immediately before
 * this migration in the same up-migration batch). Picked via "currently published, else highest
 * version_no" rather than a hardcoded `version_no = 1` literal, so this stays correct even if
 * these migrations are ever re-run against a database where more version history has already
 * accumulated by the time this step executes.
 *
 * `NOT NULL` after backfill, not left nullable — T-PC-058's own Scope line ("pinned at bind time")
 * treats this as a mandatory fact about a binding, not an optional one; every existing row gets a
 * value from the backfill above, so the constraint is satisfiable immediately.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE promo_code.campaign_promo_config
         ADD COLUMN promo_code_config_version_id uuid NULL
           REFERENCES promo_code.promo_code_config_version(id);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `UPDATE promo_code.campaign_promo_config c
         SET promo_code_config_version_id = v.id
        FROM (
          SELECT DISTINCT ON (promo_code_config_id) id, promo_code_config_id
            FROM promo_code.promo_code_config_version
           ORDER BY promo_code_config_id, (status = 'published') DESC, version_no DESC
        ) v
       WHERE v.promo_code_config_id = c.promo_code_config_id;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `ALTER TABLE promo_code.campaign_promo_config
         ALTER COLUMN promo_code_config_version_id SET NOT NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE promo_code.campaign_promo_config DROP COLUMN promo_code_config_version_id;`,
    { type: QueryTypes.RAW },
  );
}
