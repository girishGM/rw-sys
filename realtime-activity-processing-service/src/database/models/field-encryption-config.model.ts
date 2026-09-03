/**
 * `realtime_activity_processing.field_encryption_config` — which fields get encrypted in logs,
 * confirmed configurable (01-DATABASE.md §10). See `campaign-config-snapshot.model.ts`'s header
 * for this directory's own convention.
 */
export type ConfigScopeLevel = 'global' | 'country' | 'tenant' | 'campaign';

export interface FieldEncryptionConfigRow {
  id: string;
  scope_level: ConfigScopeLevel;
  scope_ref: string | null;
  field_name: string;
  is_encrypted: boolean;
  added_at: Date;
  added_by: string;
}
