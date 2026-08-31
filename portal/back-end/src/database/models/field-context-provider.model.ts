import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/**
 * `reward_config.field_context_providers` — T-121. A value source that reads the in-progress
 * campaign draft itself, with no network call (`SIBLING_COMPONENTS`, `JOURNEY_COMPONENTS`).
 *
 * Inert metadata from this portal's point of view, exactly like `rule_resolvers` (T-102):
 * nothing here resolves a context provider. T-123 owns the endpoint that actually reads the
 * draft. See `13-REWARD-MASTER-VALUE-SOURCES.md` §3.
 */
@Table({
  schema: 'reward_config',
  tableName: 'field_context_providers',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class FieldContextProvider extends Model<FieldContextProvider> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'provider_code' })
  declare providerCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
