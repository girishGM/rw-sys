import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `field_encryption_config` — `01-DATABASE.md` §10, copied verbatim from that section's own DDL
 * (T-RR-003 note 5). **Deviation flagged for the completion report:** the task file's own note 5
 * claims this shape was "confirmed identical" to RAP's real, shipped
 * `012_create_field_encryption_config.ts` — a direct read of that file shows RAP's actual table
 * has a materially different, richer shape (`scope_level`/`scope_ref`/`is_encrypted`/`added_at`/
 * `added_by`, unique on `(scope_level, scope_ref, field_name)`) than this section's simple
 * `(field_name UNIQUE, enabled)` shape. Per `AGENT-PROTOCOL.md` §3 ("if the task description
 * conflicts with a design doc, the design doc wins"), this migration follows `01-DATABASE.md` §10
 * literally rather than RAP's own file — the design doc is internally consistent on its own
 * terms (single global on/off per field name, no per-scope override), it's only the task file's
 * own commentary about RAP's file that's stale/incorrect. Flagging per that same section rather
 * than silently reconciling the two.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.field_encryption_config (
      id          int         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      field_name  varchar(50) NOT NULL UNIQUE,
      enabled     boolean     NOT NULL DEFAULT true,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.field_encryption_config;', {
    type: QueryTypes.RAW,
  });
}
