import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_config.rule_versions` — verbatim from 06-VERSIONING.md §5. `rule_master` stays
 * exactly as it is and becomes the logical identity of a rule (its code, name, category);
 * this table holds the frozen behaviour — `expression` / `parameters` — one immutable row
 * per version.
 *
 * `uq_rv_one_draft` is the concurrency guard: at most one `draft` row per rule at a time,
 * so two admins can't silently overwrite each other's in-progress edit (06-VERSIONING.md
 * §5, "Exactly one draft per rule at a time"). Immutability itself (a published row can
 * never change its `expression`/`parameters`/`version_no`/`is_breaking`) and the
 * undeletability of published rows are enforced by triggers added in `T005_007`, not here
 * — this migration only creates the table shape and its declarative constraints.
 *
 * This is a new table in `reward_config`, authorised by C1 (06-VERSIONING.md §3): new
 * tables are allowed; nothing existing is altered or dropped.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.rule_versions (
          id                    int generated always as identity primary key,
          rule_id               int          not null references reward_config.rule_master(id),
          version_no            int          not null,
          expression            text         null,
          parameters            text         null,
          change_summary        varchar(500) null,
          is_breaking           boolean      not null default false,
          status                varchar(20)  not null default 'draft',
          supersedes_version_id int          null references reward_config.rule_versions(id),
          origin_request_id     int          null,
          created_by            int          not null,
          created_at            timestamptz  not null default now(),
          published_by          int          null,
          published_at          timestamptz  null,
          deprecated_at         timestamptz  null,
          retired_at            timestamptz  null,
          updated_at            timestamptz  not null default now(),
          constraint uq_rv_rule_version unique (rule_id, version_no),
          constraint ck_rv_status check (status in ('draft','published','deprecated','retired')),
          constraint ck_rv_published_fields
              check (status = 'draft' or (published_at is not null and published_by is not null))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_rv_rule_status ON reward_config.rule_versions(rule_id, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE UNIQUE INDEX uq_rv_one_draft
           ON reward_config.rule_versions(rule_id) WHERE status = 'draft';`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * `CASCADE` drops the two indexes above along with the table — nothing else references
 * `rule_versions` yet at this point in the migration set (the additive FK-bearing columns
 * added in `T005_003`/`T005_006`/`T005_007` all roll back before this one, in Umzug's
 * default reverse-application order).
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_config.rule_versions CASCADE;', {
    type: QueryTypes.RAW,
  });
}
