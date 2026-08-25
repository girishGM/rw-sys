import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { Country } from './country.model';

/**
 * `reward_config.rule_country_assignments` — T-003. No `created_at`/`updated_at` on this
 * table (`assigned_at`/`assigned_by` only) — `timestamps: false`, as confirmed against
 * `information_schema.columns`, not assumed. `rule_id` has no FK constraint in the live
 * schema and `assigned_by` references the un-modelled `admin_users` — both plain columns.
 *
 * G10 (01-DATABASE.md / 06-VERSIONING.md): this legacy table blocks a country holding two
 * rule versions simultaneously; T-005's `rule_version_country_assignments` is the
 * version-aware replacement kept in sync alongside it, not a substitute for it.
 */
@Table({
  schema: 'reward_config',
  tableName: 'rule_country_assignments',
  underscored: true,
  timestamps: false,
})
export class RuleCountryAssignment extends Model<RuleCountryAssignment> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  /** No FK constraint in the live schema for this column. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'rule_id' })
  declare ruleId: number;

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
