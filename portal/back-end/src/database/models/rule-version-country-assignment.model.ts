import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { RuleVersion } from './rule-version.model';
import { RuleMaster } from './rule-master.model';
import { Country } from './country.model';

export type CountryAssignmentStatus = 'active' | 'superseded' | 'withdrawn';

/**
 * `reward_config.rule_version_country_assignments` (T005_003) — added to T-003's modelled
 * set beyond the task file's own fixed list, per 05-EXECUTION-PLAN.md §1. The version-aware
 * replacement for `rule_country_assignments` (G10): lets a country hold two rule versions at
 * once. Deliberately kept alongside the legacy table, not a substitute for it — see
 * `rule-country-assignment.model.ts`.
 *
 * No `created_at`/`updated_at` in the live DDL (`effective_from`/`effective_to`/`assigned_at`
 * instead) — `timestamps: false`. `blast_id` has no FK constraint (populated by the blast API
 * once `version_blasts` rows exist, per T005_003's own migration comment); `assigned_by`
 * references the un-modelled `admin_users`.
 */
@Table({
  schema: 'reward_config',
  tableName: 'rule_version_country_assignments',
  underscored: true,
  timestamps: false,
})
export class RuleVersionCountryAssignment extends Model<RuleVersionCountryAssignment> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => RuleVersion)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'rule_version_id' })
  declare ruleVersionId: number;

  @ForeignKey(() => RuleMaster)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'rule_id' })
  declare ruleId: number;

  @ForeignKey(() => Country)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'country_id' })
  declare countryId: number;

  /** No FK constraint in the live schema — see file doc comment. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'blast_id' })
  declare blastId: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: CountryAssignmentStatus;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'effective_from',
  })
  declare effectiveFrom: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'effective_to' })
  declare effectiveTo: Date | null;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'assigned_by' })
  declare assignedBy: number;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'assigned_at',
  })
  declare assignedAt: Date;

  @BelongsTo(() => RuleVersion)
  declare ruleVersion: RuleVersion;

  @BelongsTo(() => RuleMaster)
  declare rule: RuleMaster;

  @BelongsTo(() => Country)
  declare country: Country;
}
