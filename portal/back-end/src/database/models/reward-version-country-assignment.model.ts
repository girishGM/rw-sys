import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { RewardVersion } from './reward-version.model';
import { RewardSystem } from './reward-system.model';
import { Country } from './country.model';
import type { CountryAssignmentStatus } from './rule-version-country-assignment.model';

/**
 * `reward_config.reward_version_country_assignments` (T005_003) — reward-side mirror of
 * `rule_version_country_assignments`; added to T-003's modelled set beyond the task file's
 * own fixed list, per 05-EXECUTION-PLAN.md §1. See that model's own doc comment for the
 * shared rationale (G10, `timestamps: false`, no FK on `blast_id`, un-modelled `assigned_by`).
 */
@Table({
  schema: 'reward_config',
  tableName: 'reward_version_country_assignments',
  underscored: true,
  timestamps: false,
})
export class RewardVersionCountryAssignment extends Model<RewardVersionCountryAssignment> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => RewardVersion)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'reward_version_id' })
  declare rewardVersionId: number;

  @ForeignKey(() => RewardSystem)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'reward_id' })
  declare rewardId: number;

  @ForeignKey(() => Country)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'country_id' })
  declare countryId: number;

  /** No FK constraint in the live schema — see `rule-version-country-assignment.model.ts`. */
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

  @BelongsTo(() => RewardVersion)
  declare rewardVersion: RewardVersion;

  @BelongsTo(() => RewardSystem)
  declare reward: RewardSystem;

  @BelongsTo(() => Country)
  declare country: Country;
}
