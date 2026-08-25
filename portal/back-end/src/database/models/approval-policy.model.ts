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

/** `reward_config.approval_policies` — T-003. `tenant_id` is nullable (a `NULL` policy is
 * global, per the live schema — no `DROP NOT NULL` migration needed since it was already
 * nullable). */
@Table({
  schema: 'reward_config',
  tableName: 'approval_policies',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class ApprovalPolicy extends Model<ApprovalPolicy> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'entity_type' })
  declare entityType: string;

  @Column({ type: DataType.STRING(20), allowNull: false, field: 'creator_role' })
  declare creatorRole: string;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'requires_approval',
  })
  declare requiresApproval: boolean;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'approver_role' })
  declare approverRole: string | null;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'tenant_id' })
  declare tenantId: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant | null;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
