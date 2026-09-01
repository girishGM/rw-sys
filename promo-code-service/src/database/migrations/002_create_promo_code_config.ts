import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `promo_code_config` — the reusable recipe a Maker picks by name (01-DATABASE.md §1). Copied
 * verbatim — column names, types, CHECK constraints, default expressions, index definitions —
 * from the design doc; see that section's own "Notes" subsection for the reasoning behind each
 * constraint (`code_length BETWEEN 4 AND 32`, `reward_unit` as free-form varchar, soft delete
 * over hard delete).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE promo_code.promo_code_config (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id          uuid NOT NULL,
      merchant_id        uuid NULL,
      name               varchar(120) NOT NULL,
      code_prefix        varchar(10) NULL,
      code_postfix       varchar(10) NULL,
      code_length        smallint NOT NULL CHECK (code_length BETWEEN 4 AND 32),
      character_set      varchar(20) NOT NULL
                            CHECK (character_set IN ('NUMERIC','ALPHA','ALPHANUMERIC')),
      exclude_ambiguous_chars boolean NOT NULL DEFAULT true,
      reward_value_type  varchar(20) NOT NULL
                            CHECK (reward_value_type IN ('FIXED_AMOUNT','PERCENTAGE','POINTS')),
      reward_value       decimal(18,4) NOT NULL,
      reward_unit        varchar(10) NOT NULL,
      max_redemptions_per_code smallint NOT NULL DEFAULT 1,
      code_expiry_days   integer NULL,
      status             varchar(20) NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
      created_by         uuid NOT NULL,
      updated_by         uuid NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      deleted_at         timestamptz NULL
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE UNIQUE INDEX uc_promo_code_config_name
       ON promo_code.promo_code_config (tenant_id, name) WHERE deleted_at IS NULL;`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `CREATE INDEX ix_promo_code_config_active
       ON promo_code.promo_code_config (tenant_id, status) WHERE deleted_at IS NULL;`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS promo_code.promo_code_config;', {
    type: QueryTypes.RAW,
  });
}
