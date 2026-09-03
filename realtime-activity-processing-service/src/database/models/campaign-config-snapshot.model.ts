/**
 * `realtime_activity_processing.campaign_config_snapshot` — 01-DATABASE.md §1. This service's
 * migrations are raw SQL (matching `promo-code-service`'s own convention, not
 * `sequelize-typescript` `@Table` models — see that project's `promo-code-config.entity.ts`
 * header for the precedent). These `models/*.ts` files are the shared, schema-level source of
 * truth for each table's raw row shape (snake_case, exactly as Postgres/`pg` returns it) — the
 * one place every later task's own module-level repository/entity imports from, instead of each
 * re-declaring the same columns. Domain (camelCase) mapping is each consuming module's own
 * concern (e.g. T-RAP-010's cache repository), not this task's.
 *
 * `payload` is typed `unknown` deliberately, not a concrete shape — this table is a pass-through
 * cache of whatever the portal's gRPC contract returns (`03-GRPC-CONTRACT.md` §2); the actual
 * campaign→trackers→components→rules→rewards→caps graph shape is that contract's concern, read
 * back out into the in-memory hot cache by T-RAP-010, never queried via SQL (01-DATABASE.md §1's
 * own note).
 */
export interface CampaignConfigSnapshotRow {
  id: string;
  tenant_id: number;
  campaign_code: string;
  config_version: string;
  is_active: boolean;
  payload: unknown;
  fetched_at: Date;
  created_at: Date;
  updated_at: Date;
}
