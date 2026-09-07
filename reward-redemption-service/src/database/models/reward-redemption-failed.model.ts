/**
 * `reward_redemption.reward_redemption_failed` — permanent-failure ledger (`01-DATABASE.md` §2).
 * See `reward-redemption-entry.model.ts`'s header for this directory's own convention.
 */
export interface RewardRedemptionFailedRow {
  id: string;
  reward_entry_id: string;
  tenant_id: number;
  campaign_code: string;
  reward_code: string;
  total_attempts: number;
  final_error_code: string | null;
  final_error_message: string;
  failed_at: Date;
  created_at: Date;
}
