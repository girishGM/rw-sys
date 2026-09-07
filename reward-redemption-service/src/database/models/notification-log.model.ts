/**
 * `reward_redemption.notification_log` — logged (not sent) push-notification intents
 * (`01-DATABASE.md` §8). See `reward-redemption-entry.model.ts`'s header for this directory's
 * own convention. `customer_id_hash`, never plaintext (R8).
 */
export interface NotificationLogRow {
  id: string;
  reward_entry_id: string;
  tenant_id: number;
  customer_id_hash: string;
  campaign_code: string;
  reward_code: string;
  channel: string;
  would_be_payload: Record<string, unknown>;
  logged_at: Date;
}
