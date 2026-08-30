import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-116 — `reward_categories`/`reward_sub_categories`: rewards have no category/sub-category
 * concept at all today (confirmed: no `reward_categories` table exists). Built as a straight
 * mirror of `rule_categories`/`rule_sub_categories` (T-102/T-105/T-106) — same two-level
 * structure, same column shape (`reward-category.model.ts`/`reward-sub-category.model.ts` are
 * the exact reference) — so T-118 has something to point `reward_systems` at.
 *
 * A category may legitimately have **zero** sub-categories (confirmed product decision: e.g.
 * Points never needs one) — no constraint here requires at least one.
 *
 * Additive-only DDL: 2 brand-new tables, no existing table touched. Permitted under
 * `00-ARCHITECTURE.md` §2 (C1), same citation `T102_001`'s own header uses.
 *
 * `GRANT SELECT, INSERT, UPDATE` to `reward_app` in this same migration — the `T-091` lesson: a
 * table created without its grant in the same migration is a defect.
 *
 * Also seeds one default category, `UNCATEGORIZED`/`Uncategorized`, at `tenant_id = 1` — the
 * same "global reference data, `tenant_id` is a NOT NULL technicality" convention `T105_001`
 * documents for `rule_categories`. T-118 backfills every existing `reward_systems` row to point
 * at it by this stable code; that backfill is that task's own migration, not this one.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.reward_categories (
          id            int generated always as identity primary key,
          tenant_id     int             not null,
          category_code varchar(50)     not null,
          name          varchar(200)    not null,
          description   varchar(500)    null,
          status        varchar(20)     not null default 'active',
          created_at    timestamptz     not null default now(),
          updated_at    timestamptz     not null default now(),
          constraint uq_rwc_tenant_code unique (tenant_id, category_code),
          constraint ck_rwc_status      check (status in ('active','inactive'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_rwc_tenant_id ON reward_config.reward_categories (tenant_id);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      CREATE TABLE reward_config.reward_sub_categories (
          id                 int generated always as identity primary key,
          category_id        int             not null,
          sub_category_code  varchar(50)     not null,
          name               varchar(200)    not null,
          description        varchar(500)    null,
          status             varchar(20)     not null default 'active',
          created_at         timestamptz     not null default now(),
          updated_at         timestamptz     not null default now(),
          constraint uq_rwsc_category_code unique (category_id, sub_category_code),
          constraint ck_rwsc_status         check (status in ('active','inactive')),
          constraint fk_rwsc_category       foreign key (category_id)
              references reward_config.reward_categories (id)
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_rwsc_category_id ON reward_config.reward_sub_categories (category_id);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // reward_app needs an explicit GRANT on every reward_config table — no
    // ALTER DEFAULT PRIVILEGES here (T-091's own header explains why). Missing this in the
    // same migration that creates the table is the exact defect T-091 itself fixed once already.
    await context.query(
      `GRANT SELECT, INSERT, UPDATE ON reward_config.reward_categories,
         reward_config.reward_sub_categories TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // The one default category T-118's backfill needs — stable code, idempotent on a second run.
    await context.query(
      `INSERT INTO reward_config.reward_categories (tenant_id, category_code, name, status)
       SELECT 1, 'UNCATEGORIZED', 'Uncategorized', 'active'
       WHERE NOT EXISTS (
         SELECT 1 FROM reward_config.reward_categories
         WHERE tenant_id = 1 AND category_code = 'UNCATEGORIZED'
       );`,
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
      `REVOKE SELECT, INSERT, UPDATE ON reward_config.reward_categories,
         reward_config.reward_sub_categories FROM reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(`DROP TABLE IF EXISTS reward_config.reward_sub_categories;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`DROP TABLE IF EXISTS reward_config.reward_categories;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
