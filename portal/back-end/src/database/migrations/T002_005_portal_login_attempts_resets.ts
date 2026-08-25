import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/** `portal_login_attempts` and `portal_password_resets` — verbatim from 01-DATABASE.md §2.5. */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.portal_login_attempts (
          id           int generated always as identity primary key,
          email        varchar(200) not null,
          user_id      int          null references reward_portal.portal_users(id) on delete set null,
          success      boolean      not null,
          failure_code varchar(40)  null,
          ip_address   inet         null,
          user_agent   varchar(400) null,
          attempted_at timestamptz  not null default now()
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_pla_email_time ON reward_portal.portal_login_attempts(lower(email), attempted_at DESC);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_pla_ip_time ON reward_portal.portal_login_attempts(ip_address, attempted_at DESC);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      CREATE TABLE reward_portal.portal_password_resets (
          id         uuid         primary key default gen_random_uuid(),
          user_id    int          not null references reward_portal.portal_users(id) on delete cascade,
          token_hash varchar(128) not null,
          expires_at timestamptz  not null,
          consumed_at timestamptz null,
          created_at timestamptz  not null default now()
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE UNIQUE INDEX uq_ppr_token_hash ON reward_portal.portal_password_resets(token_hash);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_password_resets CASCADE;', {
    type: QueryTypes.RAW,
  });
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_login_attempts CASCADE;', {
    type: QueryTypes.RAW,
  });
}
