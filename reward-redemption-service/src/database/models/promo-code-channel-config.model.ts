/**
 * `reward_redemption.promo_code_channel_config` — campaign/tracker/reward-level REST/gRPC/Kafka
 * routing for this service's own synchronous outbound call to promo-code-service (`T-RR-080`, see
 * migration `018`'s own header; `kafka_enabled` added by `T-RR-081`, migration `019`). Following
 * `dispatch-channel-config.model.ts`'s own convention (T-RR-033): a plain snake_case row-shape
 * interface, exactly as `pg`/Sequelize returns it — the one place every consumer imports this
 * table's shape from, instead of each re-declaring it.
 */
export type PromoCodeChannelScopeLevel = 'REWARD' | 'TRACKER' | 'CAMPAIGN' | 'GLOBAL';
export type PromoCodeChannel = 'REST' | 'GRPC' | 'KAFKA';

export interface PromoCodeChannelConfigRow {
  id: number;
  scope_level: PromoCodeChannelScopeLevel;
  scope_ref_code: string | null;
  tenant_id: number | null;
  rest_enabled: boolean;
  grpc_enabled: boolean;
  /** T-RR-081, migration `019`. */
  kafka_enabled: boolean;
  primary_channel: PromoCodeChannel;
  fallback_channel: PromoCodeChannel;
  created_at: Date;
  updated_at: Date;
}
