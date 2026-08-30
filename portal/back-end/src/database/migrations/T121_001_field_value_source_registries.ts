import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-121 — the two "where does this field's dropdown get its options from?" registries
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §3). Same pluggable-metadata discipline as `rule_resolvers`/
 * `rule_operators` (T-102): adding a value source is a data change, not a code deploy.
 *
 * `field_context_providers` — sources that read the in-progress campaign draft itself, with no
 * network call (`SIBLING_COMPONENTS`, `JOURNEY_COMPONENTS`).
 * `field_api_lookup_providers` — sources that call a pre-registered HTTP endpoint. Nothing in
 * *this* task ever calls one; T-123 owns the runtime lookup. This migration only creates the
 * shape the registry rows live in.
 *
 * Additive-only DDL: 2 brand-new tables, no existing table touched. Permitted under
 * `00-ARCHITECTURE.md` §2 (C1) — same citation `T102_001` makes for the same reason.
 *
 * ### Why `auth_config_enc`, not `auth_config`
 *
 * `T-121-field-value-source-registries.md`'s implementation note 1 names this column
 * `auth_config`; `13-REWARD-MASTER-VALUE-SOURCES.md` §3 — the design doc the task file itself
 * cites — names it `auth_config_enc`. AGENT-PROTOCOL §3 ("if the task description conflicts with
 * a design doc, the design doc wins") resolves it to `auth_config_enc`, which is also the more
 * honest name: the `_enc` suffix makes it visible at the schema level that a plaintext credential
 * must never be written here. Flagged in the completion report.
 *
 * ### Why `auth_type` is a `varchar` + `CHECK` rather than a Postgres `enum`
 *
 * Per the task file: none of these providers' real auth requirements are confirmed with their
 * data owners yet. A `CHECK` constraint is widened by an ordinary `ALTER TABLE ... DROP/ADD
 * CONSTRAINT` in a later additive migration; a real `enum` type needs `ALTER TYPE ... ADD VALUE`,
 * which cannot run inside a transaction block in older Postgres and is not reversible at all.
 * The set below is a starting point, deliberately not a commitment.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.field_context_providers (
          id             int generated always as identity primary key,
          provider_code  varchar(50)  not null,
          name           varchar(200) not null,
          description    varchar(500) null,
          status         varchar(20)  not null default 'active',
          created_at     timestamptz  not null default now(),
          updated_at     timestamptz  not null default now(),
          constraint uq_fcp_code unique (provider_code),
          constraint ck_fcp_status check (status in ('active','inactive'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      CREATE TABLE reward_config.field_api_lookup_providers (
          id                  int generated always as identity primary key,
          provider_code       varchar(50)  not null,
          name                varchar(200) not null,
          description         varchar(500) null,
          endpoint_url        varchar(500) not null,
          http_method         varchar(10)  not null default 'GET',
          auth_type           varchar(30)  not null default 'none',
          -- Encrypted at rest by \`field-api-lookup-config.crypto.ts\` (AES-256-GCM via
          -- FieldCryptoService, AAD-bound to this row's id). Never write plaintext here.
          auth_config_enc     text         null,
          response_value_key  varchar(100) not null,
          response_label_key  varchar(100) not null,
          status              varchar(20)  not null default 'planned',
          created_at          timestamptz  not null default now(),
          updated_at          timestamptz  not null default now(),
          constraint uq_falp_code unique (provider_code),
          constraint ck_falp_status check (status in ('active','planned','inactive')),
          constraint ck_falp_http_method check (http_method in ('GET','POST')),
          constraint ck_falp_auth_type check (auth_type in ('none','api_key','bearer','mtls'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    // reward_app needs an explicit GRANT on every reward_config table — no ALTER DEFAULT
    // PRIVILEGES here (T-091's own header explains why). Missing this in the same migration that
    // creates the table is the exact defect T-091 itself fixed once already.
    await context.query(
      `GRANT SELECT, INSERT, UPDATE
         ON reward_config.field_context_providers, reward_config.field_api_lookup_providers
         TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `REVOKE SELECT, INSERT, UPDATE
         ON reward_config.field_context_providers, reward_config.field_api_lookup_providers
         FROM reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(`DROP TABLE IF EXISTS reward_config.field_api_lookup_providers;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`DROP TABLE IF EXISTS reward_config.field_context_providers;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
