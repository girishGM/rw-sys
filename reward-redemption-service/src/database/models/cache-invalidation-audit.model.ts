/**
 * `reward_redemption.cache_invalidation_audit` — who invalidated what, when (`01-DATABASE.md`
 * §11). See `reward-redemption-entry.model.ts`'s header for this directory's own convention.
 */
export interface CacheInvalidationAuditRow {
  id: string;
  cache_key: string | null;
  invoked_by: string;
  invoked_at: Date;
}
