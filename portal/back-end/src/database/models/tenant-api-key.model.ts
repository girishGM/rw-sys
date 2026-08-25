import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  DefaultScope,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';

/**
 * `reward_config.tenant_api_keys` — T-003. Not in the task file's own enumerated
 * "reward_config models required" list, but implementation note 5 explicitly names
 * `tenant_api_keys.key_hash` as a sensitive column requiring a `defaultScope` exclusion —
 * a genuine self-contradiction inside the task file. Resolved by including this model
 * (omitting it would silently leave note 5's own requirement unmet); see the T-003
 * completion report's Deviations section.
 *
 * `key_hash` (SHA-256 of the raw key; raw never stored, mirrors `portal_refresh_tokens`)
 * is excluded from the default scope — retrieving it requires an explicit `.unscoped()`
 * call, same rule as the credential-hash columns.
 */
@DefaultScope(() => ({
  attributes: { exclude: ['keyHash'] },
}))
@Table({
  schema: 'reward_config',
  tableName: 'tenant_api_keys',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class TenantApiKey extends Model<TenantApiKey> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'key_prefix' })
  declare keyPrefix: string;

  @Column({ type: DataType.STRING(128), allowNull: false, field: 'key_hash' })
  declare keyHash: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'expires_at' })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'grace_period_end' })
  declare gracePeriodEnd: Date | null;

  @ForeignKey(() => TenantApiKey)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'replaced_by_key_id' })
  declare replacedByKeyId: number | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'issued_at' })
  declare issuedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'last_used_at' })
  declare lastUsedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'activated_at' })
  declare activatedAt: Date | null;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => TenantApiKey, { foreignKey: 'replacedByKeyId' })
  declare replacedByKey: TenantApiKey | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
