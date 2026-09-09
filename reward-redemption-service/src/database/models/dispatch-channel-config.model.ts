/**
 * `reward_redemption.dispatch_channel_config` — campaign/tracker/reward-level Kafka-vs-REST
 * routing (`01-DATABASE.md` §5). See `reward-redemption-entry.model.ts`'s header for this
 * directory's own convention.
 */
export type DispatchScopeLevel = 'REWARD' | 'TRACKER' | 'CAMPAIGN' | 'GLOBAL';
/** T-RR-062 widens this from `'KAFKA' | 'REST'` to add `'GRPC'` as a third legal dispatch channel
 * — additive only (migration `021`'s own header): no existing row names `'GRPC'` as either
 * `primary_channel` or `fallback_channel`, and `grpc_enabled` defaults `false`, so no pre-existing
 * `dispatch_channel_config` row's resolved behavior changes because of this widening. */
export type DispatchChannel = 'KAFKA' | 'REST' | 'GRPC';

export interface DispatchChannelConfigRow {
  id: number;
  scope_level: DispatchScopeLevel;
  scope_ref_code: string | null;
  tenant_id: number | null;
  kafka_enabled: boolean;
  rest_enabled: boolean;
  /** T-RR-062 (migration `021`). `boolean NOT NULL DEFAULT false` at the DB level — every real
   * `pg`/Sequelize read of this row always returns a real `boolean`, never `undefined`. Typed
   * **optional (`?`) here**, matching `reward-redemption-entry.model.ts`'s own `expires_at`
   * precedent exactly and for the identical reason: `test/tenant-schema-cache/dispatch-channel-
   * config.cache.spec.ts`'s own `makeRow()` already builds full `DispatchChannelConfigRow` object
   * literals with no `Partial<>` widening, and that file is outside this task's own file scope
   * (`test/tenant-schema-cache/**`, R3) — making this field required would force an edit to it just
   * to keep it compiling, for a column its own tests have no opinion on. This service's own reader
   * (`dispatch-channel-resolver.service.ts`'s `toResolved()`) treats a missing value as `false`
   * (`row.grpc_enabled ?? false`), the same safe default the DB column itself defaults to. */
  grpc_enabled?: boolean;
  primary_channel: DispatchChannel;
  fallback_channel: DispatchChannel;
  created_at: Date;
  updated_at: Date;
}
