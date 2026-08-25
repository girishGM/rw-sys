import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.portal_user_credentials` — verbatim from 01-DATABASE.md §2.2. Split from
 * `portal_users` so a plain `SELECT *` on the user table can never return a hash (gap G2).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `
    CREATE TABLE reward_portal.portal_user_credentials (
        id                    int generated always as identity primary key,
        user_id               int not null unique
            references reward_portal.portal_users(id) on delete cascade,
        password_hash         varchar(255)  not null,
        password_algo         varchar(20)   not null default 'argon2id',
        password_updated_at   timestamptz   not null default now(),
        password_expires_at   timestamptz   null,
        previous_hashes       jsonb         null,
        failed_attempts       int           not null default 0,
        locked_until          timestamptz   null,
        created_at            timestamptz   not null default now(),
        updated_at            timestamptz   not null default now()
    );
    `,
    { type: QueryTypes.RAW },
  );
}

/**
 * Deviation from 01-DATABASE.md, documented per AGENT-PROTOCOL §3: `previous_hashes` is
 * `jsonb` here, not the `text` the design doc originally specified. This is the exact
 * varchar/text-holding-JSON pattern AR-13 already flagged and fixed elsewhere in this same
 * schema (`portal_audit_log.detail`, `data_protection_policies.reveal_roles`,
 * `grpc_service_grants.allowed_sections`) — `reward_portal` is a brand-new schema with no
 * legacy constraint forcing the `reward_config` convention. Applying the same fix here for
 * consistency rather than reproducing an inconsistency AR-13 was raised to close.
 */

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_portal.portal_user_credentials CASCADE;', {
    type: QueryTypes.RAW,
  });
}
