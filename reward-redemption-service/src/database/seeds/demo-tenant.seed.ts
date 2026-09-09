import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-046. Demo `tenant_schema_config` row (`01-DATABASE.md` §4) — requirement #12's "at least
 * one demo tenant/campaign/reward" ask. Values match the tenant/country pair this plan's own
 * design docs already use as their running example throughout `02-KAFKA-CONTRACTS.md`
 * (`"tenantCode": "TEN-MY"`) and `04-REST-CONTRACT.md` (same), not a placeholder-looking
 * `test-tenant-1`/`foo` — this is exactly what a stakeholder demo would show.
 *
 * `environment: 'production'` — this row models what a real deployed tenant's row would look
 * like (the shape this task's own runbook, `docs/render-migration-runbook.md`, walks an operator
 * through applying to the shared Render Postgres), not this local dev box's own `NODE_ENV`
 * (`development`). `TenantSchemaConfigCache`'s own resolution key is `(tenant_id, environment)`
 * (`tenant-schema-config.cache.ts`), so this row only resolves for a caller running with
 * `NODE_ENV=production` — a deliberate choice, not an oversight, flagged in this task's own
 * completion report: local verification here means "the row exists with the right shape and can
 * be inserted/removed cleanly," not "resolves live against this dev box's own `NODE_ENV`."
 *
 * `database_name`/`schema_name` reflect `ARCHITECTURE.md` §10's own "v1 reality" note: every
 * tenant this service handles today shares the one `reward_redemption` schema on the one
 * `reward_system` database (root `CLAUDE.md`) — there is no real per-tenant schema split live
 * anywhere in this repo yet.
 */
const DEMO_TENANT_ID = 1;
const DEMO_TENANT_CODE = 'TEN-MY';
const DEMO_COUNTRY_CODE = 'MY';
const DEMO_ENVIRONMENT = 'production';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `INSERT INTO reward_redemption.tenant_schema_config
       (tenant_id, tenant_code, country_code, environment, database_name, schema_name, is_active)
     VALUES (:tenantId, :tenantCode, :countryCode, :environment, :databaseName, :schemaName, true);`,
    {
      type: QueryTypes.RAW,
      replacements: {
        tenantId: DEMO_TENANT_ID,
        tenantCode: DEMO_TENANT_CODE,
        countryCode: DEMO_COUNTRY_CODE,
        environment: DEMO_ENVIRONMENT,
        databaseName: 'reward_system',
        schemaName: 'reward_redemption',
      },
    },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `DELETE FROM reward_redemption.tenant_schema_config
     WHERE tenant_id = :tenantId AND country_code = :countryCode AND environment = :environment;`,
    {
      type: QueryTypes.RAW,
      replacements: {
        tenantId: DEMO_TENANT_ID,
        countryCode: DEMO_COUNTRY_CODE,
        environment: DEMO_ENVIRONMENT,
      },
    },
  );
}
