import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-051. Seeds exactly one GLOBAL row per service_config key this service's own code actually
 * resolves through ServiceConfigResolverService.resolve() as of this writing -- the seeding
 * instruction 01-DATABASE.md Section 6 was missing (unlike Section 5's dispatch_channel_config,
 * which seeds its own single GLOBAL row inline in 006_create_dispatch_channel_config.ts).
 * Without this, ServiceConfigNotFoundError is thrown on every real (non-test) resolution of any
 * of these keys, because no earlier migration ever inserts a fallback row -- confirmed by direct
 * reproduction against the local dev DB (see this task's completion report) and, more subtly, by
 * reading ServiceConfigCache.resolve() (src/modules/tenant-schema-cache/service-config.cache.ts):
 * every call -- not just ones for the "cache.ttl.serviceConfig.seconds" key itself -- resolves
 * that one bootstrap key too (resolveTtlMs()), so a missing "cache.ttl.serviceConfig.seconds" row
 * breaks resolution of every other key cached through it as well, not just its own.
 *
 * A separate migration from 007_create_service_config.ts (rather than folding this into it)
 * deliberately, so a database that already applied 007 before this task landed still picks up
 * the seed via a normal forward db:migrate -- editing an already-applied migration wouldn't
 * re-run for it.
 *
 * Keys seeded (config_key -> default, value_type=int for every one of these):
 *   - cache.ttl.serviceConfig.seconds (60) -- this cache's own TTL; kept short since operators
 *     tuning any other knob need it to take effect quickly (06-CACHING-AND-TENANT-CONFIG.md
 *     Section 2's own bootstrap-default of 60_000ms mirrors this value in seconds, for
 *     consistency between the compiled-in bootstrap fallback and the steady-state resolved value).
 *   - cache.ttl.tenantSchemaConfig.seconds (300), cache.ttl.externalRewardSystemConfig.seconds
 *     (300), cache.ttl.dispatchChannelConfig.seconds (300) -- read-mostly config tables
 *     (06-CACHING-AND-TENANT-CONFIG.md Section 1), a 5-minute default TTL matches this plan's own
 *     documented cache.reconciliationPoll.intervalSeconds default below so a cold cache is
 *     refreshed on roughly the same cadence the reconciliation poller itself runs.
 *   - cache.reconciliationPoll.intervalSeconds (300) -- 06-CACHING-AND-TENANT-CONFIG.md Section 4's
 *     own explicit "defaulting to 300, deliberately aligned to RAP's own 5-minute default"
 *     instruction; also matches ReconciliationPollerService's own compiled-in
 *     DEFAULT_RECONCILIATION_INTERVAL_MS fallback (used only if resolution itself fails), so the
 *     documented default and the resolved value agree once this row exists.
 *   - completionSweep.graceSeconds (300) -- 05-PROCESSING-PIPELINE.md Section 2's sweep resumes a
 *     row stuck in dispatched_external; five minutes is long enough that the normal in-transaction
 *     completion path (Section 6) has always already run, so only a genuinely stuck row is ever
 *     swept.
 *   - completionSweep.intervalSeconds (60) -- the sweep scans a full-table filter on a rare
 *     condition (Section 2's own "vanishingly small" framing), so a 1-minute cadence catches a
 *     stuck row promptly without adding meaningful load.
 *
 * These are operational starting points, not requirements-derived constants -- no design doc
 * specifies a numeric default for any of these seven keys (confirmed by search); an operator can
 * override any of them with a more specific CAMPAIGN/TENANT/COUNTRY-scoped row at any time,
 * exactly as ServiceConfigResolverService's own precedence walk already supports. Flagged in this
 * task's completion report as a deviation-from-spec-by-necessity, not a silent choice.
 *
 * Process note for future knobs (the second half of this defect's own title -- "Wave 2+ tasks
 * can't add their own default GLOBAL row"): src/database/** remains agent-rr-foundation's own
 * file-scope grant only (R3). A task that introduces a new service_config-resolved knob must
 * still request a single-file grant to add its own seed row here (or in a further migration) the
 * same way this task's own filing note describes -- this migration does not create a generic,
 * self-service seeding mechanism, since a fixed, reviewed list of defaults is exactly what R1/R4
 * (no untracked change to what ships) call for.
 */
const DEFAULT_GLOBAL_INT_CONFIG: ReadonlyArray<{ key: string; value: number }> = [
  { key: 'cache.ttl.serviceConfig.seconds', value: 60 },
  { key: 'cache.ttl.tenantSchemaConfig.seconds', value: 300 },
  { key: 'cache.ttl.externalRewardSystemConfig.seconds', value: 300 },
  { key: 'cache.ttl.dispatchChannelConfig.seconds', value: 300 },
  { key: 'cache.reconciliationPoll.intervalSeconds', value: 300 },
  { key: 'completionSweep.graceSeconds', value: 300 },
  { key: 'completionSweep.intervalSeconds', value: 60 },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  for (const { key, value } of DEFAULT_GLOBAL_INT_CONFIG) {
    // eslint-disable-next-line no-await-in-loop -- T-RR-051: a handful of sequential inserts in a
    // one-shot migration; no throughput concern, and each statement's own parameter binding
    // (rather than string interpolation) is the property that actually matters here.
    await context.query(
      `INSERT INTO reward_redemption.service_config
         (config_key, scope_level, scope_ref, config_value, value_type)
       VALUES (:key, 'GLOBAL', NULL, :value, 'int');`,
      { type: QueryTypes.RAW, replacements: { key, value: String(value) } },
    );
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  for (const { key } of DEFAULT_GLOBAL_INT_CONFIG) {
    // eslint-disable-next-line no-await-in-loop -- T-RR-051: symmetric with up(), see above.
    await context.query(
      `DELETE FROM reward_redemption.service_config
       WHERE config_key = :key AND scope_level = 'GLOBAL' AND scope_ref IS NULL;`,
      { type: QueryTypes.RAW, replacements: { key } },
    );
  }
}
