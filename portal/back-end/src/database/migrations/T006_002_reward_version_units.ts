import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_versions.unit_type` / `unit_code` (11-BUDGETS-AND-LIMITS.md §3.1) — the payout
 * unit a `campaign_caps` row must match to consume a grant. This task's own file list names
 * this migration for adding them via `ALTER TABLE`, per Implementation notes §7 ("extend
 * its migration rather than altering afterwards" — i.e. extend `T005_002`, not this file).
 *
 * **That extension already happened.** `T005_002_reward_versions.ts` (T-005, `done`) built
 * `reward_versions` with `unit_type varchar(14)` / `unit_code varchar(10)` and
 * `ck_rewv_unit_type` present from its very first `CREATE TABLE` — T-005's own task
 * guidance named these exact columns as part of the reward-specific payload to mirror from
 * `rule_versions`, and T-005 delivered them up front rather than leaving a gap for this
 * migration to fill in later. `T005_007`'s immutability trigger
 * (`fn_reward_version_immutable`) already locks both columns once a version leaves `draft`.
 *
 * So this migration is a **defensive verification step, not a schema change**: it confirms
 * both columns and the CHECK exist with the expected shape, and — only if some future
 * `reward_versions` genuinely predates that decision — adds what's missing, idempotently.
 * In this repository's real history that add-branch never executes; TC-43 passes because
 * T-005 already satisfies it. `down()` is deliberately a no-op: these columns are part of
 * `reward_versions`' own table shape (owned by T-005), and `fn_reward_version_immutable`
 * (T005_007) reads them on every UPDATE for as long as `reward_versions` exists — dropping
 * them from a T-006 rollback while T-005's migrations remain applied would strand that
 * trigger. A migration this task did not add is not this task's to remove.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'reward_config'
             AND table_name   = 'reward_versions'
             AND column_name  = 'unit_type'
        ) THEN
          ALTER TABLE reward_config.reward_versions ADD COLUMN unit_type varchar(14) NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'reward_config'
             AND table_name   = 'reward_versions'
             AND column_name  = 'unit_code'
        ) THEN
          ALTER TABLE reward_config.reward_versions ADD COLUMN unit_code varchar(10) NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ck_rewv_unit_type'
        ) THEN
          ALTER TABLE reward_config.reward_versions
              ADD CONSTRAINT ck_rewv_unit_type
              CHECK (unit_type IS NULL OR unit_type IN ('currency','points','voucher'));
        END IF;
      END $$;
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * No-op — see this file's own doc comment. `unit_type`/`unit_code` belong to
 * `reward_versions`' own shape (T-005), not to anything this migration itself created.
 */
export async function down(): Promise<void> {
  // Intentionally empty.
}
