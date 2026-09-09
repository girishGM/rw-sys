/**
 * `reward_tracking.service_config` — general scoped configuration, mirroring
 * `reward-redemption-service`'s own shape exactly (`008_create_service_config.ts`'s own header).
 * See `inbound-event-log.model.ts`'s header for this directory's own convention.
 */
export type ServiceConfigScopeLevel = 'CAMPAIGN' | 'TENANT' | 'COUNTRY' | 'GLOBAL';
export type ServiceConfigValueType = 'string' | 'int' | 'boolean' | 'json';

export interface ServiceConfigRow {
  id: number;
  config_key: string;
  scope_level: ServiceConfigScopeLevel;
  scope_ref: string | null;
  config_value: string;
  value_type: ServiceConfigValueType;
  created_at: Date;
  updated_at: Date;
}
