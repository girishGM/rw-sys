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
import { TrackerComponent } from './tracker-component.model';
import { RewardPolicy } from './reward-policy.model';

/**
 * `reward_config.reward_component_assignments` — **added by T-037**. The **component** level of
 * the three reward-attachment levels; see `reward-campaign-assignment.model.ts` for the shared
 * rationale, including why this table has **no** `reward_version_id` pin.
 */
@Table({
  schema: 'reward_config',
  tableName: 'reward_component_assignments',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RewardComponentAssignment extends Model<RewardComponentAssignment> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @ForeignKey(() => RewardPolicy)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'reward_policy_id' })
  declare rewardPolicyId: number;

  @ForeignKey(() => TrackerComponent)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'component_id' })
  declare componentId: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'assigned_at' })
  declare assignedAt: Date;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => RewardPolicy)
  declare rewardPolicy: RewardPolicy;

  @BelongsTo(() => TrackerComponent)
  declare component: TrackerComponent;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
