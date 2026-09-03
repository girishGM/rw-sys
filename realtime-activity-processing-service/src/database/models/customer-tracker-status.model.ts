/**
 * `realtime_activity_processing.customer_tracker_status` — tracker-level completion aggregate
 * (01-DATABASE.md §5). See `campaign-config-snapshot.model.ts`'s header for this directory's own
 * convention.
 */
export interface CustomerTrackerStatusRow {
  id: string;
  tenant_id: number;
  customer_id_hash: string;
  campaign_code: string;
  tracker_code: string;
  completion_cycle: number;
  components_required_count: number;
  components_completed_count: number;
  is_completed: boolean;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
