import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `rule_version_country_assignments` and its reward-side mirror
 * `reward_version_country_assignments` — verbatim shape from 06-VERSIONING.md §5, deliberately
 * NEW tables rather than a change to the legacy `uq_rule_country_assignments(rule_id,
 * country_id)` / `uq_reward_country_assignments` constraints, because those permit only one
 * row per country and cannot express "this country holds v2 and v3 at once" — G10 in
 * progress.json, and the core requirement this whole task exists to satisfy (TC-12).
 *
 * The legacy `*_country_assignments` tables are kept and dual-written by the blast API
 * (T-041), unchanged here — 06-VERSIONING.md §5.2. This migration adds the new, finer
 * table only.
 *
 * `blast_id` has no FK here: `version_blasts` is created one migration later (`T005_004`),
 * and 06-VERSIONING.md §5 does not add that FK either — a forward reference would require
 * a chicken-and-egg migration ordering. It is populated by the blast API once
 * `version_blasts` exists.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.rule_version_country_assignments (
          id               int generated always as identity primary key,
          rule_version_id  int         not null references reward_config.rule_versions(id),
          rule_id          int         not null references reward_config.rule_master(id),
          country_id       int         not null references reward_config.countries(id),
          blast_id         int         null,
          status           varchar(20) not null default 'active',
          effective_from   timestamptz not null default now(),
          effective_to     timestamptz null,
          assigned_by      int         not null,
          assigned_at      timestamptz not null default now(),
          constraint uq_rvca unique (rule_version_id, country_id),
          constraint ck_rvca_status check (status in ('active','superseded','withdrawn'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_rvca_country_rule
           ON reward_config.rule_version_country_assignments(country_id, rule_id, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      CREATE TABLE reward_config.reward_version_country_assignments (
          id                 int generated always as identity primary key,
          reward_version_id  int         not null references reward_config.reward_versions(id),
          reward_id          int         not null references reward_config.reward_systems(id),
          country_id         int         not null references reward_config.countries(id),
          blast_id           int         null,
          status             varchar(20) not null default 'active',
          effective_from     timestamptz not null default now(),
          effective_to       timestamptz null,
          assigned_by        int         not null,
          assigned_at        timestamptz not null default now(),
          constraint uq_rewvca unique (reward_version_id, country_id),
          constraint ck_rewvca_status check (status in ('active','superseded','withdrawn'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_rewvca_country_reward
           ON reward_config.reward_version_country_assignments(country_id, reward_id, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Reverse creation order: reward-side mirror first, then the rule-side table. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    'DROP TABLE IF EXISTS reward_config.reward_version_country_assignments CASCADE;',
    { type: QueryTypes.RAW },
  );
  await context.query(
    'DROP TABLE IF EXISTS reward_config.rule_version_country_assignments CASCADE;',
    { type: QueryTypes.RAW },
  );
}
