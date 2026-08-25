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
import { RewardPolicy } from './reward-policy.model';
import { RewardVersion } from './reward-version.model';

/**
 * `reward_config.reward_campaign_assignments` — **added by T-037** (see
 * `tracker-component.model.ts`'s header for why).
 *
 * The **campaign** level of the three reward-attachment levels (04-FRONTEND.md §5.1). Its two
 * siblings — `reward-tracker-assignment.model.ts` and `reward-component-assignment.model.ts` —
 * are column-for-column identical except for which id they hang off, which is why all three are
 * separate tables rather than one with a discriminator: that is the shape the live schema has,
 * and R1 forbids changing it.
 *
 * ### Only this level carries a version pin
 *
 * T005_006 added `reward_version_id` to **this table alone** — the tracker and component
 * assignment tables did not get the column. That asymmetry is in the live schema, not a choice
 * this task made; it means a tracker- or component-level reward resolves its unit through the
 * reward's currently-assigned version at read time rather than through a pin. Flagged in the
 * T-037 completion report, because it is a real versioning gap for two of the three levels and
 * fixing it is a schema change nobody has authorised.
 *
 * `reward_policy_id`, not `reward_id`: a reward *system* is the connector, and a *policy* is the
 * concrete thing that pays (`reward_policies`, T-032). The wizard picks a policy.
 */
@Table({
  schema: 'reward_config',
  tableName: 'reward_campaign_assignments',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RewardCampaignAssignment extends Model<RewardCampaignAssignment> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => RewardPolicy)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'reward_policy_id' })
  declare rewardPolicyId: number;

  @ForeignKey(() => TenantCampaign)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'campaign_id' })
  declare campaignId: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'assigned_at' })
  declare assignedAt: Date;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  /** T005_006 — see this file's header. */
  @ForeignKey(() => RewardVersion)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'reward_version_id' })
  declare rewardVersionId: number | null;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => RewardPolicy)
  declare rewardPolicy: RewardPolicy;

  @BelongsTo(() => TenantCampaign)
  declare campaign: TenantCampaign;

  @BelongsTo(() => RewardVersion)
  declare rewardVersion: RewardVersion | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
