import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_sessions` and `portal_refresh_tokens` — verbatim from
 * 01-DATABASE.md §2.3–2.4, **including `transport_key_enc`** (architect review AR-03,
 * 2026-08-14): that column was specified in 07-DATA-PROTECTION.md §5 but originally
 * missing from this table's own DDL — schema drift between two design docs, caught and
 * fixed before this migration was ever written. See ARCHITECT-REVIEW.md AR-03 for the
 * full trace.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.portal_sessions (
          id                 uuid          primary key default gen_random_uuid(),
          user_id            int           not null references reward_portal.portal_users(id) on delete cascade,
          status             varchar(20)   not null default 'active',
          ip_address         inet          null,
          user_agent         varchar(400)  null,
          transport_key_enc  varchar(512)  null,
          issued_at          timestamptz   not null default now(),
          last_seen_at       timestamptz   not null default now(),
          expires_at         timestamptz   not null,
          revoked_at         timestamptz   null,
          revoked_reason     varchar(60)   null,
          constraint ck_portal_sessions_status check (status in ('active','expired','revoked'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_portal_sessions_user ON reward_portal.portal_sessions(user_id) WHERE status = 'active';`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_portal_sessions_expiry ON reward_portal.portal_sessions(expires_at) WHERE status = 'active';`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      CREATE TABLE reward_portal.portal_refresh_tokens (
          id              uuid         primary key default gen_random_uuid(),
          session_id      uuid         not null references reward_portal.portal_sessions(id) on delete cascade,
          user_id         int          not null references reward_portal.portal_users(id) on delete cascade,
          token_hash      varchar(128) not null,
          parent_token_id uuid         null references reward_portal.portal_refresh_tokens(id),
          status          varchar(20)  not null default 'active',
          issued_at       timestamptz  not null default now(),
          expires_at      timestamptz  not null,
          consumed_at     timestamptz  null,
          constraint ck_prt_status check (status in ('active','consumed','revoked'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE UNIQUE INDEX uq_prt_token_hash ON reward_portal.portal_refresh_tokens(token_hash);`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_prt_session ON reward_portal.portal_refresh_tokens(session_id);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_refresh_tokens CASCADE;', {
    type: QueryTypes.RAW,
  });
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_sessions CASCADE;', {
    type: QueryTypes.RAW,
  });
}
