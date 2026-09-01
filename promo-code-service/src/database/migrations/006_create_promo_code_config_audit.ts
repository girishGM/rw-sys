import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `promo_code_config_audit` — config change history (01-DATABASE.md §5). `changed_fields`
 * holds only the diff (old/new pairs for fields actually touched), not a full row snapshot —
 * matches the append-only, diff-shaped audit style already established elsewhere in this repo.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE promo_code.promo_code_config_audit (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      promo_code_config_id  uuid NOT NULL REFERENCES promo_code.promo_code_config(id),
      action                varchar(20) NOT NULL CHECK (action IN ('CREATE','UPDATE','ARCHIVE')),
      changed_fields         jsonb NOT NULL,
      changed_by             uuid NOT NULL,
      changed_at             timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_promo_code_config_audit_config
       ON promo_code.promo_code_config_audit (promo_code_config_id, changed_at DESC);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS promo_code.promo_code_config_audit;', {
    type: QueryTypes.RAW,
  });
}
