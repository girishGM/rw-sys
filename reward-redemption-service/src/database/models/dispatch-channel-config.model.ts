/**
 * `reward_redemption.dispatch_channel_config` — campaign/tracker/reward-level Kafka-vs-REST
 * routing (`01-DATABASE.md` §5). See `reward-redemption-entry.model.ts`'s header for this
 * directory's own convention.
 */
export type DispatchScopeLevel = 'REWARD' | 'TRACKER' | 'CAMPAIGN' | 'GLOBAL';
export type DispatchChannel = 'KAFKA' | 'REST';

export interface DispatchChannelConfigRow {
  id: number;
  scope_level: DispatchScopeLevel;
  scope_ref_code: string | null;
  tenant_id: number | null;
  kafka_enabled: boolean;
  rest_enabled: boolean;
  primary_channel: DispatchChannel;
  fallback_channel: DispatchChannel;
  created_at: Date;
  updated_at: Date;
}
