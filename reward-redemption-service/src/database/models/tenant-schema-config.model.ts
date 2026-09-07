/**
 * `reward_redemption.tenant_schema_config` — dynamic per-tenant/country/environment schema
 * routing (`01-DATABASE.md` §4). See `reward-redemption-entry.model.ts`'s header for this
 * directory's own convention.
 */
export interface TenantSchemaConfigRow {
  id: number;
  tenant_id: number;
  tenant_code: string;
  country_code: string;
  environment: string;
  database_name: string;
  schema_name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}
