import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `external_system_call_log` — observability audit of every connector call (`01-DATABASE.md`
 * §9). `request_summary`/`response_summary` must never carry PII or credentials (R8/R9) — that
 * is each connector's own (later-task) responsibility when constructing the summary, not
 * something this migration can enforce structurally. Same FK-ordering requirement as `010`-`012`
 * (T-RR-003 note 4) — must migrate after `reward_redemption_entry` exists.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `CREATE TABLE reward_redemption.external_system_call_log (
      id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      reward_entry_id   uuid        NOT NULL REFERENCES reward_redemption.reward_redemption_entry (id),
      system_code       varchar(50) NOT NULL,
      attempt_number    int         NOT NULL,
      request_summary   jsonb       NOT NULL,
      response_summary  jsonb       NULL,
      result            varchar(20) NOT NULL,
      error_code        varchar(50) NULL,
      latency_ms        int         NOT NULL,
      called_at         timestamptz NOT NULL DEFAULT now()
    );`,
    { type: QueryTypes.RAW },
  );

  await context.query(
    `CREATE INDEX ix_escl_entry ON reward_redemption.external_system_call_log (reward_entry_id);`,
    { type: QueryTypes.RAW },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_redemption.external_system_call_log;', {
    type: QueryTypes.RAW,
  });
}
