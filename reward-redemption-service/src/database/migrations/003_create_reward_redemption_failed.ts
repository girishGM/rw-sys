import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_redemption_failed` — the permanent-failure ledger, `01-DATABASE.md` §2. `fk_rrf_entry`
 * is a real, in-schema foreign key to `reward_redemption_entry` — correct precisely because both
 * tables live in `reward_redemption` (R5 only forbids a *cross-schema* FK). Written exactly once,
 * by the same transaction that flips `reward_redemption_entry.status` to `'failed'` (Wave 2's own
 * concern, not this task's).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.reward_redemption_failed (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id       uuid NOT NULL,
      tenant_id             int  NOT NULL,
      campaign_code         varchar(50) NOT NULL,
      reward_code           varchar(80) NOT NULL,
      total_attempts        int  NOT NULL,
      final_error_code      varchar(50) NULL,
      final_error_message   text NOT NULL,
      failed_at             timestamptz NOT NULL DEFAULT now(),
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fk_rrf_entry FOREIGN KEY (reward_entry_id)
        REFERENCES reward_redemption.reward_redemption_entry (id)
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_rrf_campaign ON reward_redemption.reward_redemption_failed (campaign_code);`,
    { type: QueryTypes.RAW },
  );
}

/**
 * Drops before `reward_redemption_entry` would ever be dropped in a normal, in-order rollback
 * (`003` reverts before `002` — Umzug's own default order) — `fk_rrf_entry` never blocks this
 * table's own drop either way (`DROP TABLE` on the referencing side never needs the FK dropped
 * first), so no explicit `DROP CONSTRAINT` step is needed here.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.reward_redemption_failed;', {
    type: QueryTypes.RAW,
  });
}
