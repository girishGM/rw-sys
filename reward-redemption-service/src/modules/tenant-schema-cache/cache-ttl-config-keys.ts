/**
 * T-RR-007. The `service_config` keys each of this task's four caches reads its own TTL from
 * (`06-CACHING-AND-TENANT-CONFIG.md` §2) — dot-namespaced under `cache.ttl.*` deliberately, per
 * that section's own "easy to find and audit together" reasoning. `serviceConfig`'s own TTL key
 * (`cache.ttl.serviceConfig.seconds`) is declared in `service-config.cache.ts` instead of here,
 * since it is that one file's own internal bootstrap concern (§2's bootstrap-exception note), not
 * a key any *other* cache in this module ever reads.
 */
export const CACHE_TTL_CONFIG_KEYS = {
  tenantSchemaConfig: 'cache.ttl.tenantSchemaConfig.seconds',
  externalRewardSystemConfig: 'cache.ttl.externalRewardSystemConfig.seconds',
  dispatchChannelConfig: 'cache.ttl.dispatchChannelConfig.seconds',
} as const;

/** `service_config` key for `ReconciliationPollerService`'s own refresh interval
 * (`06-CACHING-AND-TENANT-CONFIG.md` §4), default `300` seconds. */
export const RECONCILIATION_POLL_INTERVAL_CONFIG_KEY = 'cache.reconciliationPoll.intervalSeconds';
