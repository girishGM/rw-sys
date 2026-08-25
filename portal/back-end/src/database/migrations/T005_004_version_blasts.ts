import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `version_blasts` + `version_blast_targets` — verbatim from 06-VERSIONING.md §5. One
 * table serves both rules and rewards (`entity_type in ('rule','reward')`) rather than a
 * pair of mirrored tables, because a blast event's shape (who, when, scope, target count)
 * doesn't differ between the two — only the config it distributes does.
 *
 * `version_id` deliberately has no FK: it resolves to either `rule_versions.id` or
 * `reward_versions.id` depending on `entity_type`, and Postgres has no polymorphic FK.
 * Referential integrity for that column is a service-layer concern (T-041's blast API),
 * same as `rule_version_country_assignments.blast_id` in `T005_003`.
 *
 * Publish and blast are two separate acts (06-VERSIONING.md §6) — this table records only
 * the blast; publishing is just a `status` transition on the version row itself.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.version_blasts (
          id                int generated always as identity primary key,
          entity_type       varchar(10)  not null,
          entity_id         int          not null,
          version_id        int          not null,
          version_no        int          not null,
          scope             varchar(20)  not null,
          target_count      int          not null,
          note              varchar(500) null,
          origin_request_id int          null,
          blasted_by        int          not null,
          blasted_at        timestamptz  not null default now(),
          constraint ck_vb_entity check (entity_type in ('rule','reward')),
          constraint ck_vb_scope  check (scope in ('all_countries','selected'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      CREATE TABLE reward_config.version_blast_targets (
          id             int generated always as identity primary key,
          blast_id       int          not null references reward_config.version_blasts(id),
          country_id     int          not null references reward_config.countries(id),
          status         varchar(20)  not null default 'delivered',
          failure_reason varchar(300) null,
          constraint uq_vbt unique (blast_id, country_id),
          constraint ck_vbt_status check (status in ('delivered','failed','skipped'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_config.version_blast_targets CASCADE;', {
    type: QueryTypes.RAW,
  });
  await context.query('DROP TABLE IF EXISTS reward_config.version_blasts CASCADE;', {
    type: QueryTypes.RAW,
  });
}
