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
import { TenantCampaign } from './tenant-campaign.model';
import { Merchant } from './merchant.model';

/** `reward_config.campaign_merchants` — T-003. `tenant_id` column exists but carries no FK
 * constraint in the live schema; kept as a plain column. */
@Table({
  schema: 'reward_config',
  tableName: 'campaign_merchants',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class CampaignMerchant extends Model<CampaignMerchant> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => TenantCampaign)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'campaign_id' })
  declare campaignId: number;

  @ForeignKey(() => Merchant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'merchant_id' })
  declare merchantId: number;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => TenantCampaign)
  declare campaign: TenantCampaign;

  @BelongsTo(() => Merchant)
  declare merchant: Merchant;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
