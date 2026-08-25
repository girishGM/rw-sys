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
import { Merchant } from './merchant.model';
import { Activity } from './activity.model';
import { MerchantStore } from './merchant-store.model';

/** `reward_config.merchant_activities` — T-003. */
@Table({
  schema: 'reward_config',
  tableName: 'merchant_activities',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class MerchantActivity extends Model<MerchantActivity> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => Merchant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'merchant_id' })
  declare merchantId: number;

  @ForeignKey(() => Activity)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'activity_id' })
  declare activityId: number;

  @ForeignKey(() => MerchantStore)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'store_id' })
  declare storeId: number | null;

  /** `decimal(5,2)`; Sequelize returns Postgres `numeric` as a string — never coerce. */
  @Column({ type: DataType.DECIMAL(5, 2), allowNull: true, field: 'commission_rate' })
  declare commissionRate: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => Merchant)
  declare merchant: Merchant;

  @BelongsTo(() => Activity)
  declare activity: Activity;

  @BelongsTo(() => MerchantStore)
  declare store: MerchantStore;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
