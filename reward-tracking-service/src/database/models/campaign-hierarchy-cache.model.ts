/**
 * `reward_tracking.campaign_hierarchy_cache` — `brain-storm/02-DATA-MODEL.md` §7. See
 * `inbound-event-log.model.ts`'s header for this directory's own convention, and this table's own
 * migration (`007_create_campaign_hierarchy_cache.ts`) for the inferred-shape note.
 */
export interface CampaignHierarchyCacheRow {
  id: string;
  tenant_id: number;
  campaign_code: string;
  campaign_name: string | null;
  config_version: string | null;
  is_active: boolean;
  owner_contact: string | null;
  hierarchy: unknown;
  fetched_at: Date;
  created_at: Date;
  updated_at: Date;
}
