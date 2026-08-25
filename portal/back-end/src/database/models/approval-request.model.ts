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
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.approval_requests` — T-003. `payload` is `text` holding JSON.
 * `requested_by`/`reviewed_by` reference the un-modelled `admin_users` — plain columns.
 */
@Table({
  schema: 'reward_config',
  tableName: 'approval_requests',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class ApprovalRequest extends Model<ApprovalRequest> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'entity_type' })
  declare entityType: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entity_id' })
  declare entityId: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare action: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column(DataType.TEXT)
  get payload(): Record<string, unknown> {
    return parseJsonColumn(this.getDataValue('payload'), {});
  }
  set payload(value: Record<string, unknown>) {
    this.setDataValue('payload', stringifyJsonColumn(value) as unknown as Record<string, unknown>);
  }

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'requested_by' })
  declare requestedBy: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'requested_at' })
  declare requestedAt: Date;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'reviewed_by' })
  declare reviewedBy: number | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'reviewed_at' })
  declare reviewedAt: Date | null;

  @Column({ type: DataType.STRING(500), allowNull: true, field: 'review_comment' })
  declare reviewComment: string | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'expires_at' })
  declare expiresAt: Date;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
