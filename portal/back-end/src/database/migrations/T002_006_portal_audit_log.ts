import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_audit_log` — verbatim from 01-DATABASE.md §2.5. Division of audit
 * responsibility: auth/access-control events land here; domain/campaign events stay in
 * `reward_config.campaign_audit_trail` (00-ARCHITECTURE.md §4).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.portal_audit_log (
          id           bigint generated always as identity primary key,
          event_type   varchar(60)  not null,
          actor_id     int          null references reward_portal.portal_users(id) on delete set null,
          actor_role   varchar(20)  null,
          target_type  varchar(60)  null,
          target_id    varchar(60)  null,
          country_id   int          null,
          tenant_id    int          null,
          ip_address   inet         null,
          detail       jsonb        null,
          occurred_at  timestamptz  not null default now()
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_pal_event_time ON reward_portal.portal_audit_log(event_type, occurred_at DESC);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_pal_actor_time ON reward_portal.portal_audit_log(actor_id, occurred_at DESC);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_audit_log CASCADE;', {
    type: QueryTypes.RAW,
  });
}
