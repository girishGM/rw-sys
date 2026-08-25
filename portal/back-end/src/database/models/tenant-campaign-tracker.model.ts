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
import { TenantCampaign } from './tenant-campaign.model';
import { Tracker } from './tracker.model';

/** `reward_config.tenant_campaign_trackers` — T-003. */
@Table({
  schema: 'reward_config',
  tableName: 'tenant_campaign_trackers',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class TenantCampaignTracker extends Model<TenantCampaignTracker> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => TenantCampaign)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'campaign_id' })
  declare campaignId: number;

  @ForeignKey(() => Tracker)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tracker_id' })
  declare trackerId: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_primary' })
  declare isPrimary: boolean;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => TenantCampaign)
  declare campaign: TenantCampaign;

  @BelongsTo(() => Tracker)
  declare tracker: Tracker;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
