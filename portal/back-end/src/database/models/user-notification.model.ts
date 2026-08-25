import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';

/**
 * `reward_config.user_notifications` — T-003. `user_id` references the un-modelled
 * `admin_users` — plain column. No `updated_at` column exists on this table (confirmed via
 * `information_schema.columns`, not assumed) — `updatedAt: false`.
 */
@Table({
  schema: 'reward_config',
  tableName: 'user_notifications',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
})
export class UserNotification extends Model<UserNotification> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'tenant_id' })
  declare tenantId: number;

  /** References the un-modelled `reward_config.admin_users`. */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare userId: number;

  @Column({ type: DataType.STRING(30), allowNull: false, field: 'notification_type' })
  declare notificationType: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.STRING(500), allowNull: false })
  declare message: string;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'entity_type' })
  declare entityType: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entity_id' })
  declare entityId: number | null;

  @Column({ type: DataType.STRING(200), allowNull: true, field: 'entity_label' })
  declare entityLabel: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_read' })
  declare isRead: boolean;

  @Column({ type: DataType.DATE, allowNull: true, field: 'read_at' })
  declare readAt: Date | null;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;
}
