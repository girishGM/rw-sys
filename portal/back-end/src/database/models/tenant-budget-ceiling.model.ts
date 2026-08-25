import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';
import type { UnitType } from './campaign-cap.model';

/**
 * `reward_config.tenant_budget_ceilings` (T006_003) — the typo guard
 * (11-BUDGETS-AND-LIMITS.md §8, G18 in progress.json). Mirrors that migration's DDL
 * exactly; every CHECK lives in the database. Set only by `country_admin` (§8.3) — that is
 * a permission-matrix concern (T-013/T-033), not something this model enforces.
 *
 * **A tenant with no row here is unlimited, not blocked** (§8.5, §9) — callers must treat
 * `findOne` returning `null` as "no ceiling configured", never as an error.
 */
@Table({
  schema: 'reward_config',
  tableName: 'tenant_budget_ceilings',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class TenantBudgetCeiling extends Model<TenantBudgetCeiling> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(14), allowNull: false, field: 'unit_type' })
  declare unitType: UnitType;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'unit_code' })
  declare unitCode: string;

  /** Hard stop — no single campaign may declare a lifetime budget above this. String, same
   * "money never crosses a boundary as a float" rule as `CampaignCap.maxTotalAmount`. */
  @Column({ type: DataType.DECIMAL(18, 4), allowNull: false, field: 'max_campaign_budget' })
  declare maxCampaignBudget: string;

  /** Soft threshold, flagged to the checker; `ck_tbc_warn` rejects a value above the hard
   * stop, since such a row could never fire. */
  @Column({ type: DataType.DECIMAL(18, 4), allowNull: true, field: 'warn_above_amount' })
  declare warnAboveAmount: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  /** country_admin actor id — opaque here, same convention as every other `created_by` in
   * this schema. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'created_by' })
  declare createdBy: number;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
