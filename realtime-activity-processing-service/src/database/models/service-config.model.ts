import type { ConfigScopeLevel } from './field-encryption-config.model';

/**
 * `realtime_activity_processing.service_config` — general per-scope configuration
 * (01-DATABASE.md §11). See `campaign-config-snapshot.model.ts`'s header for this directory's own
 * convention. Reuses `ConfigScopeLevel` from `field-encryption-config.model.ts` — both tables
 * share the exact same four-level scope vocabulary (`global`/`country`/`tenant`/`campaign`).
 */
export interface ServiceConfigRow {
  id: number;
  config_key: string;
  config_value: string;
  scope_level: ConfigScopeLevel;
  scope_ref: string | null;
  description: string | null;
  updated_at: Date;
}
