import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.encryption_keys` — 07-DATA-PROTECTION.md §3, column-for-column.
 *
 * **This table never contains a key.** `key_ref` names where the key lives — an environment
 * variable or a KMS ARN — and nothing else. Key bytes stored next to the ciphertext they
 * protect means one stolen backup contains both halves, which is the same as not encrypting
 * at all. The design doc calls a seed that inserts key bytes here "an automatic task
 * failure"; this migration makes it a constraint violation as well.
 *
 * ### Three constraints added beyond the design doc's DDL, and why
 *
 * `ck_ek_key_ref_pointer` — the doc states the pointer rule in prose only. Prose does not
 * stop an INSERT. The regex admits exactly two shapes: `env:<POSIX env var name>` and
 * `kms:arn:...`. Standard base64 needs `+`, `/` and `=`, none of which the `env:` branch
 * allows, so the obvious paste is rejected by the database itself. It is *not* sufficient on
 * its own — a 43-character alphanumeric blob is a syntactically valid env var name — which
 * is why `KeyRegistryService` re-checks at boot with `looksLikeKeyMaterial()` (TC-12). Two
 * independent layers, because this is the one mistake nobody notices from the outside.
 *
 * `uq_ek_active_purpose` — a partial unique index allowing at most one `active` key per
 * purpose. Rotation is defined as "add a new active key, the previous becomes rotating"; two
 * active keys for the same purpose makes "which key encrypts?" undefined, and the answer
 * would silently be whichever row sorted first. `RotateKeysCommand.activateKey()` demotes
 * before it promotes precisely because this index is enforced per statement.
 *
 * `ck_ek_purpose` / `ck_ek_algorithm` — the doc lists the legal values as SQL comments. A
 * typo'd purpose (`'feild'`) would otherwise insert cleanly and then simply never be found
 * by `getActiveKey('field')`, i.e. the portal would boot fine and fail at the first write.
 *
 * `ck_ek_retired_at` — a retired key with no `retired_at` loses the audit answer to "when
 * did this key stop being able to decrypt anything?", which is the first question asked
 * after a key-compromise incident.
 *
 * No rows are seeded here. Which kids exist, and which env vars hold them, is a deployment
 * decision (T-004 seeds / T-052 ops), and seeding a placeholder would either be a fake key
 * or a real one in git.
 *
 * Grants: `T002_008_grants.ts` set `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal GRANT
 * ALL ON TABLES TO reward_app`, and this migration runs as the same privileged role, so
 * `reward_app` picks up access to this table automatically. Nothing to grant here.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.encryption_keys (
          id           int generated always as identity primary key,
          kid          varchar(40)  not null unique,   -- travels inside every ciphertext
          purpose      varchar(40)  not null,          -- field|blind_index|transport|token
          algorithm    varchar(30)  not null,          -- AES-256-GCM|HMAC-SHA256|RSA-OAEP-256
          key_ref      varchar(200) not null,          -- 'env:NAME' or 'kms:arn:...' — NEVER a key
          status       varchar(20)  not null default 'active',  -- active|rotating|retired
          activated_at timestamptz  not null default now(),
          retired_at   timestamptz  null,
          created_at   timestamptz  not null default now(),

          constraint ck_ek_status check (status in ('active','rotating','retired')),
          constraint ck_ek_purpose check (purpose in ('field','blind_index','transport','token')),
          constraint ck_ek_algorithm
              check (algorithm in ('AES-256-GCM','HMAC-SHA256','RSA-OAEP-256')),
          constraint ck_ek_retired_at
              check (status <> 'retired' or retired_at is not null),

          -- key_ref is a POINTER, never key material. See this file's header.
          constraint ck_ek_key_ref_pointer check (
              key_ref ~ '^env:[A-Za-z_][A-Za-z0-9_]{0,127}$'
           or key_ref ~ '^kms:arn:[A-Za-z0-9-]+:kms:[A-Za-z0-9-]*:[0-9]*:[A-Za-z0-9:/_-]+$'
          )
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    // At most one active key per purpose — see the header. Partial unique index rather than
    // a constraint because Postgres has no partial UNIQUE constraint syntax.
    await context.query(
      `CREATE UNIQUE INDEX uq_ek_active_purpose
           ON reward_portal.encryption_keys(purpose)
        WHERE status = 'active';`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Boot reads every row; rotation reads by purpose+status. Small table, but the index
    // also documents the two access paths.
    await context.query(
      `CREATE INDEX ix_ek_purpose_status ON reward_portal.encryption_keys(purpose, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Drops the table (and with it both indexes).
 *
 * **This is one-way once anything has been encrypted.** Rolling back removes the registry
 * that maps a ciphertext's `kid` to the key that decrypts it. The key material itself lives
 * in the environment or KMS and survives, so recovery is possible in principle — but only by
 * recreating the exact rows that were here. T-016's Rollback section says the same thing;
 * it is repeated at the point of no return on purpose.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS reward_portal.encryption_keys CASCADE;`, {
    type: QueryTypes.RAW,
  });
}
