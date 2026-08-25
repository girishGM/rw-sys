import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/** 11-BUDGETS-AND-LIMITS.md §2 — `cap_class`. budget = pooled; limit = per customer. */
export type CapClass = 'budget' | 'limit';
export type ScopeLevel = 'campaign' | 'tracker' | 'component';
export type PeriodType = 'lifetime' | 'daily' | 'monthly' | 'rolling_hours' | 'time_of_day';
/** §3.1 — no conversion rate exists anywhere in the design; a budget only ever matches a
 * grant sharing both `unitType` and `unitCode` exactly. */
export type UnitType = 'currency' | 'points' | 'voucher';
export type OnBreach = 'reject' | 'pause_campaign' | 'alert_only';

/**
 * `reward_config.campaign_caps` (T006_001). Mirrors the DDL exactly — see that migration's
 * own doc comment for the full rationale of every constraint. Every CHECK lives in the
 * database, not here; this model exists so the wizard (T-037) and the dual-write helper
 * (`src/common/caps/legacy-budget-sync.ts`) have a typed shape to write through, not to
 * re-implement validation the database already enforces authoritatively.
 */
@Table({
  schema: 'reward_config',
  tableName: 'campaign_caps',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class CampaignCap extends Model<CampaignCap> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'campaign_id' })
  declare campaignId: number;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'cap_class' })
  declare capClass: CapClass;

  @Column({ type: DataType.STRING(12), allowNull: false, field: 'scope_level' })
  declare scopeLevel: ScopeLevel;

  /** `tracker_id` / `component_id`; NULL at campaign level (`ck_cc_ref`). */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'scope_ref_id' })
  declare scopeRefId: number | null;

  @Column({ type: DataType.STRING(16), allowNull: false, field: 'period_type' })
  declare periodType: PeriodType;

  /** N, for `period_type = 'rolling_hours'` only (`ck_cc_rolling`). */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'period_value' })
  declare periodValue: number | null;

  /** Time-of-day only. `window_end_time < window_start_time` means "wraps past midnight". */
  @Column({ type: DataType.TIME, allowNull: true, field: 'window_start_time' })
  declare windowStartTime: string | null;

  @Column({ type: DataType.TIME, allowNull: true, field: 'window_end_time' })
  declare windowEndTime: string | null;

  /** Defaults from the campaign's own country's `countries.timezone` when omitted — see
   * `trg_cc_default_timezone` in T006_001, not application code. */
  @Column({ type: DataType.STRING(60), allowNull: true, field: 'period_timezone' })
  declare periodTimezone: string | null;

  @Column({ type: DataType.STRING(14), allowNull: true, field: 'unit_type' })
  declare unitType: UnitType | null;

  @Column({ type: DataType.STRING(10), allowNull: true, field: 'unit_code' })
  declare unitCode: string | null;

  /** Optional narrowing; NULL = all reward types sharing this unit. No CHECK — deliberately
   * not constrained (`reward_systems.reward_type` is free text with legacy rows). */
  @Column({ type: DataType.STRING(30), allowNull: true, field: 'reward_type' })
  declare rewardType: string | null;

  /** `decimal(18,4)`. Sequelize returns Postgres `numeric` as a string — never coerce to a
   * JS number; money crosses every boundary as a string, never a float. */
  @Column({ type: DataType.DECIMAL(18, 4), allowNull: true, field: 'max_total_amount' })
  declare maxTotalAmount: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'max_occurrences' })
  declare maxOccurrences: number | null;

  /** Pooled idea only — `ck_cc_customers` rejects this on a `limit` row. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'max_customers' })
  declare maxCustomers: number | null;

  @Column({
    type: DataType.STRING(16),
    allowNull: false,
    defaultValue: 'reject',
    field: 'on_breach',
  })
  declare onBreach: OnBreach;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'warn_at_percent' })
  declare warnAtPercent: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'created_by' })
  declare createdBy: number;

  /**
   * `GENERATED ALWAYS AS (...) STORED` in the database (T006_001) — **never assign this
   * from application code.** Postgres rejects any INSERT/UPDATE that supplies its own value
   * for a generated column outright, so this attribute is read-only by construction: as
   * long as nothing ever calls `.set('dedupeKey', ...)`, Sequelize omits it from the
   * INSERT/UPDATE column list and the database computes it, which is the entire point —
   * see T006_001's own doc comment (AR-02 / TC-50 / TC-51).
   */
  @Column({ type: DataType.STRING(160), allowNull: true, field: 'dedupe_key' })
  declare readonly dedupeKey: string;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
