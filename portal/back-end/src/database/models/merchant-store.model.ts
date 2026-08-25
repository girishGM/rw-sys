import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  DeletedAt,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';
import { Merchant } from './merchant.model';

/**
 * `reward_config.merchant_stores` — T-003. `paranoid: true`: `deleted_at` exists on this
 * table in the live schema. Not among the five tables 01-DATABASE.md §6 implementation note
 * 2 names by example (`tenants`, `merchants`, `tenant_campaigns`, `reward_systems`,
 * `portal_users`) — that list turned out to be non-exhaustive; this table genuinely has the
 * column (confirmed via `information_schema.columns`, not assumed from the design doc), so
 * the note's own general rule ("paranoid only where the column actually exists") applies
 * here too. See the T-003 completion report for this as a documented deviation.
 */
@Table({
  schema: 'reward_config',
  tableName: 'merchant_stores',
  underscored: true,
  timestamps: true,
  paranoid: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
})
export class MerchantStore extends Model<MerchantStore> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => Merchant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'merchant_id' })
  declare merchantId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'store_code' })
  declare storeCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare address: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare city: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare state: string | null;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'postal_code' })
  declare postalCode: string | null;

  @Column({ type: DataType.STRING(50), allowNull: true })
  declare region: string | null;

  @Column({ type: DataType.DECIMAL(10, 7), allowNull: true })
  declare latitude: string | null;

  @Column({ type: DataType.DECIMAL(10, 7), allowNull: true })
  declare longitude: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => Merchant)
  declare merchant: Merchant;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;

  @DeletedAt
  @Column({ type: DataType.DATE, field: 'deleted_at' })
  declare deletedAt: Date | null;
}
