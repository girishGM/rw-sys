/**
 * `realtime_activity_processing.budget_consumption` — campaign-scope budget cap consumption
 * (01-DATABASE.md §6). See `campaign-config-snapshot.model.ts`'s header for this directory's own
 * convention. `consumed_amount` is kept as a `string` (see `activity-log.model.ts`'s header on
 * why `decimal` columns are never re-parsed to `number` here).
 */
export interface BudgetConsumptionRow {
  id: string;
  tenant_id: number;
  campaign_code: string;
  reward_policy_code: string;
  cap_type: string;
  period_start: Date;
  period_end: Date;
  consumed_amount: string;
  consumed_count: number;
  updated_at: Date;
}
