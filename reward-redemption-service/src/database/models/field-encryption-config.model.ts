/**
 * `reward_redemption.field_encryption_config` — `01-DATABASE.md` §10 (see
 * `008_create_field_encryption_config.ts`'s own header for the deviation flagged against the
 * task file's note 5). See `reward-redemption-entry.model.ts`'s header for this directory's own
 * row-interface convention.
 */
export interface FieldEncryptionConfigRow {
  id: number;
  field_name: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}
