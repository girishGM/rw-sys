import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_user_roles` — verbatim from 01-DATABASE.md §2.6. Forward
 * compatibility for multi-role support; not used in v1 (every user has exactly one role
 * via `portal_users.role`).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `
    CREATE TABLE reward_portal.portal_user_roles (
        id         int generated always as identity primary key,
        user_id    int         not null references reward_portal.portal_users(id) on delete cascade,
        role       varchar(20) not null,
        granted_by int         null references reward_portal.portal_users(id),
        granted_at timestamptz not null default now(),
        revoked_at timestamptz null,
        constraint uq_pur_user_role unique (user_id, role)
    );
    `,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_user_roles CASCADE;', {
    type: QueryTypes.RAW,
  });
}
