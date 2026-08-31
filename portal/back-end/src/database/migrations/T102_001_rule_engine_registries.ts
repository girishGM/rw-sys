import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-102 — the two pluggable-dispatch registry tables that let the rule engine's fact-resolution
 * and comparison-operator vocabulary grow by data, not by code (`rules-reward/
 * rule-engine-mapped-design.md` §1.3/§2.1, `rules-reward/RULE-MASTER-PORTAL-TASKS.md` §2.1).
 *
 * `rule_resolvers` declares *how* to fetch a fact from a specific data source (JSONPath on the
 * event payload, sibling tracker-component lookup, aggregate SQL, cached customer-profile API,
 * schedule context). `rule_operators` declares *how* to compare a fact against a configured
 * value (`equals`, `in`, `between`, `days_since_gte`, ...). Both are inert metadata from this
 * portal's own point of view — same discipline as `rule_master.expression` (T-031): nothing here
 * instantiates a resolver or evaluates an operator. A different microservice (out of scope for
 * this repo) does that, generically, by reading these two tables.
 *
 * Additive-only DDL: 2 brand-new tables, no existing table touched. Permitted under
 * `00-ARCHITECTURE.md` §2 (C1).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.rule_resolvers (
          id             int generated always as identity primary key,
          resolver_code  varchar(50)  not null,
          name           varchar(200) not null,
          description    varchar(500) null,
          handler_class  varchar(200) not null,
          input_schema   text         not null,
          status         varchar(20)  not null default 'active',
          created_at     timestamptz  not null default now(),
          updated_at     timestamptz  not null default now(),
          constraint uq_rr_code unique (resolver_code),
          constraint ck_rr_status check (status in ('active','inactive'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      CREATE TABLE reward_config.rule_operators (
          id                     int generated always as identity primary key,
          operator_code          varchar(30)  not null,
          display_name           varchar(100) not null,
          expected_value_type    varchar(30)  not null,
          handler_class          varchar(200) not null,
          applicable_data_types  text         not null,
          status                 varchar(20)  not null default 'active',
          created_at             timestamptz  not null default now(),
          updated_at             timestamptz  not null default now(),
          constraint uq_ro_code unique (operator_code),
          constraint ck_ro_status check (status in ('active','inactive')),
          constraint ck_ro_value_type check (expected_value_type in ('scalar','array','range','number'))
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    // reward_app needs an explicit GRANT on every reward_config table — no
    // ALTER DEFAULT PRIVILEGES here (T-091's own header explains why). Missing this in the
    // same migration that creates the table is the exact defect T-091 itself fixed once already.
    await context.query(
      `GRANT SELECT, INSERT, UPDATE ON reward_config.rule_resolvers, reward_config.rule_operators
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
      `REVOKE SELECT, INSERT, UPDATE ON reward_config.rule_resolvers, reward_config.rule_operators
         FROM reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(`DROP TABLE IF EXISTS reward_config.rule_operators;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`DROP TABLE IF EXISTS reward_config.rule_resolvers;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
