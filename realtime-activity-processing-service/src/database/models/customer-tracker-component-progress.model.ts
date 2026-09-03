/**
 * `realtime_activity_processing.customer_tracker_component_progress` — precomputed progress, the
 * fast-read table (01-DATABASE.md §4). See `campaign-config-snapshot.model.ts`'s header for this
 * directory's own convention.
 */
export interface CustomerTrackerComponentProgressRow {
  id: string;
  tenant_id: number;
  customer_id_hash: string;
  campaign_code: string;
  tracker_code: string;
  tracker_component_code: string;
  current_count: number;
  required_count: number;
  completion_cycle: number;
  is_completed: boolean;
  completed_at: Date | null;
  last_activity_log_id: string | null;
  created_at: Date;
  updated_at: Date;
}
