import { Column, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';

/** `reward_config.rbac_cache_config` — T-003. No `created_at` column exists on this table
 * (confirmed via `information_schema.columns`) — `timestamps` carries `updatedAt` only. */
@Table({
  schema: 'reward_config',
  tableName: 'rbac_cache_config',
  underscored: true,
  timestamps: true,
  createdAt: false,
  updatedAt: 'updated_at',
})
export class RbacCacheConfig extends Model<RbacCacheConfig> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(100), allowNull: false, field: 'config_key' })
  declare configKey: string;

  @Column({ type: DataType.STRING(500), allowNull: false, field: 'config_value' })
  declare configValue: string;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
