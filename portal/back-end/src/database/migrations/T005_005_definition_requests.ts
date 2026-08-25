import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `definition_requests` — verbatim from 06-VERSIONING.md §5/§9, the "please build me a
 * rule/reward" workflow (G12 in progress.json). `entity_id` is set only for `update_rule` /
 * `update_reward` requests; `fulfilled_version_id` resolves to either `rule_versions.id` or
 * `reward_versions.id` depending on `request_type` — same polymorphic-FK reasoning as
 * `version_blasts.version_id` in `T005_004`, so it deliberately has no FK either.
 *
 * `origin_request_id` on `rule_versions`/`reward_versions`/`version_blasts` (all created in
 * earlier T005 migrations) is the other half of this traceability chain — from a version
 * back to the request that caused it, and from a request forward to what shipped
 * (06-VERSIONING.md §9's closing paragraph).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.definition_requests (
          id                     int generated always as identity primary key,
          request_type           varchar(20)   not null,
          entity_id              int           null,
          requested_by           int           not null,
          requesting_country_id  int           null,
          requesting_tenant_id   int           null,
          title                  varchar(200)  not null,
          description            text          not null,
          business_justification text          null,
          desired_by             date          null,
          priority               varchar(10)   not null default 'normal',
          status                 varchar(20)   not null default 'submitted',
          reviewed_by            int           null,
          reviewed_at            timestamptz   null,
          review_comment         varchar(1000) null,
          fulfilled_version_id   int           null,
          fulfilled_at           timestamptz   null,
          created_at             timestamptz   not null default now(),
          updated_at             timestamptz   not null default now(),
          constraint ck_dr_type     check (request_type in ('new_rule','update_rule','new_reward','update_reward')),
          constraint ck_dr_status   check (status in ('submitted','under_review','approved','rejected','fulfilled','withdrawn')),
          constraint ck_dr_priority check (priority in ('low','normal','high','urgent'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_dr_status ON reward_config.definition_requests(status, created_at DESC);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_config.definition_requests CASCADE;', {
    type: QueryTypes.RAW,
  });
}
