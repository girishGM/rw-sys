import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-068. Seeds the one GLOBAL `service_config` row `015_seed_service_config_defaults.ts` never
 * added: `cache.ttl.campaignConfig.seconds` — the fifth cache `06-CACHING-AND-TENANT-CONFIG.md` §1/§2
 * lists (`campaignConfig`), resolved by `CampaignConfigCache.ttlMs()`
 * (`src/modules/processing/campaign-config.cache.ts`, `agent-rr-processing`'s own file scope — not
 * touched by this task, R3).
 *
 * **Root cause (filed by T-RR-044, diagnosed here).** `015_seed_service_config_defaults.ts`'s own
 * header enumerates "every `service_config` key this service's own code actually resolves ... as of
 * this writing" and seeds one `GLOBAL` row per key — but `cache.ttl.campaignConfig.seconds` is
 * missing from that list. `CampaignConfigCache.ttlMs()` does call
 * `serviceConfigCache.resolve(CAMPAIGN_CONFIG_TTL_KEY, 'int', {})` first, but with no seed row at
 * any scope that call always throws `ServiceConfigNotFoundError`, so its own catch block's
 * `DEFAULT_CAMPAIGN_CONFIG_TTL_MS` (300_000ms, a compiled-in literal) governs this cache's actual
 * TTL 100% of the time in every real/deployed environment — a second, undocumented
 * hardcoded-TTL exception beyond the one `06-CACHING-AND-TENANT-CONFIG.md` §2 names (the
 * `serviceConfig` cache's own bootstrap-only default). Confirmed by direct query against the local
 * dev DB: `SELECT config_key FROM reward_redemption.service_config WHERE config_key LIKE 'cache.%'`
 * returns `serviceConfig`/`tenantSchemaConfig`/`externalRewardSystemConfig`/`dispatchChannelConfig`/
 * `reconciliationPoll` only — `campaignConfig` absent — and by grep across every migration file (no
 * migration ever inserts this key before this one).
 *
 * **Fix chosen.** Add the missing `GLOBAL` seed row, value `300` (seconds) — matching
 * `DEFAULT_CAMPAIGN_CONFIG_TTL_MS`'s own 300_000ms exactly, so the resolved, DB-sourced TTL and the
 * class's own defensive compiled-in fallback agree once this row exists, and matching the same
 * "5-minute default, aligned with `cache.reconciliationPoll.intervalSeconds`" reasoning
 * `015_seed_service_config_defaults.ts` already used for the other three read-mostly-table caches'
 * TTLs. `CampaignConfigCache.ttlMs()`'s own try/catch fallback is left exactly as-is (that file is
 * outside this task's scope, R3, and the fallback remains a legitimate defensive guard for a
 * genuinely un-seeded scope/environment — see this task's own completion report) — this migration
 * only removes the *only* path that was ever actually exercised, the missing-row case.
 *
 * A separate migration from both `007_create_service_config.ts` and
 * `015_seed_service_config_defaults.ts` (never editing either), for the identical reason
 * `015_seed_service_config_defaults.ts`'s own header already gives for being separate from `007`:
 * a database that already applied 015 before this task landed still picks up this row via a normal
 * forward `db:migrate` — editing an already-applied migration wouldn't re-run for it.
 */
const CAMPAIGN_CONFIG_TTL_CONFIG_KEY = 'cache.ttl.campaignConfig.seconds';
const CAMPAIGN_CONFIG_TTL_DEFAULT_SECONDS = 300;

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `INSERT INTO reward_redemption.service_config
       (config_key, scope_level, scope_ref, config_value, value_type)
     VALUES (:key, 'GLOBAL', NULL, :value, 'int');`,
    {
      type: QueryTypes.RAW,
      replacements: {
        key: CAMPAIGN_CONFIG_TTL_CONFIG_KEY,
        value: String(CAMPAIGN_CONFIG_TTL_DEFAULT_SECONDS),
      },
    },
  );
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `DELETE FROM reward_redemption.service_config
     WHERE config_key = :key AND scope_level = 'GLOBAL' AND scope_ref IS NULL;`,
    { type: QueryTypes.RAW, replacements: { key: CAMPAIGN_CONFIG_TTL_CONFIG_KEY } },
  );
}
