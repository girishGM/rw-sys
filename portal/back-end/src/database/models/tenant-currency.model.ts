import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';

/**
 * `reward_config.tenant_currencies` (T126_001) — 13-REWARD-MASTER-VALUE-SOURCES.md §4. A tenant
 * may support more than one currency; `is_default` marks the one used when no explicit currency
 * is chosen elsewhere (a partial unique index, `uq_tc_one_default`, guarantees at most one such
 * row per tenant — enforced by the database, not this model).
 *
 * See `country.model.ts` for why only the `@BelongsTo` side of the FK is declared.
 */
@Table({
  schema: 'reward_config',
  tableName: 'tenant_currencies',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class TenantCurrency extends Model<TenantCurrency> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.CHAR(3), allowNull: false, field: 'currency_code' })
  declare currencyCode: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_default' })
  declare isDefault: boolean;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
