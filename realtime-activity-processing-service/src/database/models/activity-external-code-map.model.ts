/**
 * `realtime_activity_processing.activity_external_code_map` — 01-DATABASE.md §2. Local, indexed
 * mirror of the portal-owned `reward_portal.activity_external_codes` join table (not yet filed —
 * `04-CACHE-INVALIDATION.md` §4 / R0). See `campaign-config-snapshot.model.ts`'s header for this
 * directory's own convention.
 */
export interface ActivityExternalCodeMapRow {
  id: string;
  tenant_id: number;
  external_code: string;
  activity_code: string;
  fetched_at: Date;
}
