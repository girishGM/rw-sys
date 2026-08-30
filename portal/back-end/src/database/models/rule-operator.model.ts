import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/**
 * `reward_config.rule_operators` — T-102. Declares *how* to compare a resolved fact against a
 * configured value (`equals`, `in`, `between`, `days_since_gte`, ...). Inert metadata from this
 * portal's point of view — nothing here evaluates a comparison; a different microservice does
 * that, generically, by reading this table. See `rule-engine-mapped-design.md` §1.3/§2.1.
 */
@Table({
  schema: 'reward_config',
  tableName: 'rule_operators',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RuleOperator extends Model<RuleOperator> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(30), allowNull: false, field: 'operator_code' })
  declare operatorCode: string;

  @Column({ type: DataType.STRING(100), allowNull: false, field: 'display_name' })
  declare displayName: string;

  /** scalar | array | range | number — drives which value widget the Apply screen renders. */
  @Column({ type: DataType.STRING(30), allowNull: false, field: 'expected_value_type' })
  declare expectedValueType: string;

  @Column({ type: DataType.STRING(200), allowNull: false, field: 'handler_class' })
  declare handlerClass: string;

  /** JSON array text, e.g. `["string","number","date"]` — read verbatim, never parsed here. */
  @Column({ type: DataType.TEXT, allowNull: false, field: 'applicable_data_types' })
  declare applicableDataTypes: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
