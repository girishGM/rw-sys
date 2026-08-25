import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { Country } from './country.model';

/**
 * `reward_config.reward_country_assignments` — T-003. No `created_at`/`updated_at`
 * (`assigned_at`/`assigned_by` only) — `timestamps: false`. `reward_id` has no FK
 * constraint in the live schema; `assigned_by` references the un-modelled `admin_users`.
 * See `rule-country-assignment.model.ts` for the reward-side of gap G10.
 */
@Table({
  schema: 'reward_config',
  tableName: 'reward_country_assignments',
  underscored: true,
  timestamps: false,
})
export class RewardCountryAssignment extends Model<RewardCountryAssignment> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  /** No FK constraint in the live schema for this column. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'reward_id' })
  declare rewardId: number;

  @ForeignKey(() => Country)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'country_id' })
  declare countryId: number;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'assigned_at',
  })
  declare assignedAt: Date;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'assigned_by' })
  declare assignedBy: number | null;

  @BelongsTo(() => Country)
  declare country: Country;
}
